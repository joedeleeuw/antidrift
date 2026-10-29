use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, ScopeOptions};
use antidrift_kernel::tsrs_kernel;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-sql-string-concat";

const MESSAGE: &str = "Do not build SQL queries with string concatenation or raw template interpolation; use parameterized queries.";

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::BinaryExpression),
    Listener::Enter(Kind::TemplateExpression),
    Listener::Enter(Kind::TaggedTemplateExpression),
];

const BEFORE_KEYWORDS: &str =
    "FROM|JOIN|UPDATE|INTO|TABLE|WHERE|AND|OR|IN|VALUES|SET|ON|LIKE|ORDER BY|GROUP BY|PARTITION BY";

const AFTER_KEYWORDS: &str =
    "AND|OR|WHERE|FROM|JOIN|ORDER BY|GROUP BY|PARTITION BY|LIMIT|OFFSET|HAVING|SET|VALUES|IN";

const IDENTIFIER_CONTEXT_KEYWORDS: &str =
    "ORDER BY|GROUP BY|PARTITION BY|FROM|JOIN|UPDATE|INTO|TABLE";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SqlConcatOptions {
    pub safe_identifier_members: Vec<SafeIdentifierMemberSpec>,
    pub safe_template_tags: Vec<SafeTemplateTagSpec>,
    #[serde(flatten)]
    pub scope: ScopeOptions,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafeIdentifierMemberSpec {
    #[serde(rename = "type")]
    pub type_name: String,
    pub member: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum SafeTemplateTagSpec {
    Imported {
        module: String,
        #[serde(rename = "export")]
        export_name: String,
    },
    Member {
        #[serde(rename = "type")]
        type_name: String,
        member: String,
        source: String,
    },
}

pub struct NoSqlStringConcat {
    options: SqlConcatOptions,
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoSqlStringConcat = NoSqlStringConcat {
    options: SqlConcatOptions {
        safe_identifier_members: Vec::new(),
        safe_template_tags: Vec::new(),
        scope: ScopeOptions {
            files: None,
            exclude_files: Vec::new(),
        },
    },
    scope: RuleScope::DEFAULT,
};

impl NoSqlStringConcat {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = super::decode_rule_options::<SqlConcatOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &parsed.scope)?;
        Ok(Self {
            options: parsed,
            scope,
        })
    }
}

impl Rule for NoSqlStringConcat {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor { rule: self })
    }
}

struct Visitor {
    rule: &'static NoSqlStringConcat,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::BinaryExpression => NoSqlStringConcat::check_binary(node, ctx),
            Kind::TemplateExpression => self.rule.check_template(node, ctx),
            Kind::TaggedTemplateExpression => self.rule.check_tagged_template(node, ctx),
            _ => {}
        }
    }
}

impl NoSqlStringConcat {
    fn check_binary(node: P<Node>, ctx: &mut Ctx) {
        let bin = node.as_binary_expression();
        if bin.operator_token().kind() != Kind::PlusToken {
            return;
        }
        let left = Self::static_string_text(tsrs_kernel::unwrap_expression(bin.left()));
        let right = Self::static_string_text(tsrs_kernel::unwrap_expression(bin.right()));
        if (left.as_deref().is_some_and(Self::is_sql_statement) && right.is_none())
            || (right.as_deref().is_some_and(Self::is_sql_statement) && left.is_none())
        {
            ctx.report_node(node, RuleMessage::new("no-sql-string-concat", MESSAGE));
        }
    }

    fn check_template(&self, node: P<Node>, ctx: &mut Ctx) {
        if !node
            .parent()
            .is_some_and(ast::is_tagged_template_expression)
            && !node
                .as_template_expression()
                .template_spans
                .nodes()
                .is_empty()
            && Self::is_sql_statement(&Self::combined_template_text(node))
            && self.has_unsafe_sql_interpolation(node, ctx.checker)
        {
            ctx.report_node(node, RuleMessage::new("no-sql-string-concat", MESSAGE));
        }
    }

    fn check_tagged_template(&self, node: P<Node>, ctx: &mut Ctx) {
        let tagged = node.as_tagged_template_expression();
        let template = tagged.template;
        if template.kind() != Kind::TemplateExpression {
            return;
        }
        let spans = template.as_template_expression().template_spans.nodes();
        if spans.is_empty() {
            return;
        }
        if self.is_trusted_sql_template_tag(tagged.tag, ctx.checker) {
            self.report_unsafe_raw_fragments(spans, ctx);
        } else if Self::is_sql_statement(&Self::combined_template_text(template))
            && self.has_unsafe_sql_interpolation(template, ctx.checker)
        {
            ctx.report_node(node, RuleMessage::new("no-sql-string-concat", MESSAGE));
        }
    }

    fn has_unsafe_sql_interpolation(&self, template_node: P<Node>, checker: &mut Checker) -> bool {
        let template = template_node.as_template_expression();
        let spans = template.template_spans.nodes();
        spans.iter().enumerate().any(|(idx, &span_node)| {
            let before = if idx == 0 {
                template.head.text()
            } else {
                spans[idx - 1].as_template_span().literal.text()
            };
            let span = span_node.as_template_span();
            let after = span.literal.text();
            let expr = tsrs_kernel::unwrap_expression(span.expression);
            let safe = Self::static_string_text(expr).is_some()
                || (self.is_trusted_identifier_member(expr, checker)
                    && Self::is_sql_identifier_context(before, after));
            !safe && Self::is_sql_interpolation_context(before, after)
        })
    }

    fn is_trusted_identifier_member(&self, node: P<Node>, checker: &mut Checker) -> bool {
        if node.kind() != Kind::PropertyAccessExpression
            || self.options.safe_identifier_members.is_empty()
        {
            return false;
        }
        let prop = node.as_property_access_expression();
        let name_node = prop.name();
        let Some(owner_name) = ast::is_identifier(name_node)
            .then(|| checker.get_type_at_location(prop.expression()).symbol())
            .flatten()
            .map(|sym| sym.name())
        else {
            return false;
        };
        let member_name = name_node.as_identifier().text();
        self.options
            .safe_identifier_members
            .iter()
            .any(|spec| spec.member == member_name && spec.type_name == owner_name)
    }

    fn is_sql_identifier_context(before: &str, after: &str) -> bool {
        let norm_before = Self::normalized_sql_context(before);
        IDENTIFIER_CONTEXT_KEYWORDS
            .split('|')
            .any(|kw| norm_before == kw || norm_before.ends_with(&format!(" {kw}")))
            || after.trim_start().starts_with('=')
    }

    fn is_sql_interpolation_context(before: &str, after: &str) -> bool {
        let trimmed_before = before
            .trim_end()
            .strip_suffix(['\'', '"', '`'])
            .map_or_else(|| before.trim_end(), str::trim_end);
        let norm_before = Self::normalized_sql_context(trimmed_before);
        let ends_kw = BEFORE_KEYWORDS.split('|').any(|kw| {
            norm_before == kw
                || norm_before.ends_with(&format!(" {kw}"))
                || norm_before.ends_with(&format!(" {kw} ("))
        });
        let has_stmt_ctx = norm_before.split_whitespace().any(|tok| {
            matches!(
                tok,
                "SELECT" | "FROM" | "JOIN" | "WHERE" | "VALUES" | "UPDATE" | "INSERT" | "DELETE"
            )
        });
        let ends_op = has_stmt_ctx
            && ["=", "(", ","]
                .iter()
                .any(|op| trimmed_before.ends_with(op));
        let trimmed_after = after
            .trim_start()
            .strip_prefix(['\'', '"', '`'])
            .map_or_else(|| after.trim_start(), str::trim_start);
        let norm_after = Self::normalized_sql_context(trimmed_after);
        let starts_kw = norm_after.starts_with(')')
            || norm_after.starts_with(',')
            || AFTER_KEYWORDS
                .split('|')
                .any(|kw| norm_after == kw || norm_after.starts_with(&format!("{kw} ")));
        ends_kw || ends_op || starts_kw
    }

    fn normalized_sql_context(text: &str) -> String {
        text.split_whitespace()
            .map(str::to_ascii_uppercase)
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn report_unsafe_raw_fragments(&self, spans: &[P<Node>], ctx: &mut Ctx) {
        for &span_node in spans {
            let expr = span_node.as_template_span().expression;
            if self.contains_unsafe_raw_sql_fragment(expr, ctx.checker) {
                ctx.report_node(expr, RuleMessage::new("no-sql-string-concat", MESSAGE));
            }
        }
    }

    fn is_trusted_sql_template_tag(&self, tag: P<Node>, checker: &mut Checker) -> bool {
        let unwrapped = tsrs_kernel::unwrap_expression(tag);
        self.is_trusted_imported_tag(unwrapped, checker)
            || self.is_trusted_member_tag(unwrapped, checker)
            || has_external_sql_tag_provenance(unwrapped, checker, 0)
    }

    fn is_trusted_imported_tag(&self, node: P<Node>, checker: &mut Checker) -> bool {
        if !ast::is_identifier(node) || self.options.safe_template_tags.is_empty() {
            return false;
        }
        let Some(sym) = checker.get_symbol_at_location_exported(node) else {
            return false;
        };
        sym.declarations().iter().any(|&decl| {
            if decl.kind() != Kind::ImportSpecifier {
                return false;
            }
            let spec = decl.as_import_specifier();
            let export_ident = spec.property_name().unwrap_or_else(|| spec.name());
            let Some(module_name) = enclosing_import_module_name(decl) else {
                return false;
            };
            ast::is_identifier(export_ident)
                && self.options.safe_template_tags.iter().any(|s| {
                    matches!(
                        s,
                        SafeTemplateTagSpec::Imported { module, export_name }
                            if module == &module_name
                                && export_name == export_ident.as_identifier().text()
                    )
                })
        })
    }

    fn is_trusted_member_tag(&self, node: P<Node>, checker: &mut Checker) -> bool {
        if node.kind() != Kind::PropertyAccessExpression
            || self.options.safe_template_tags.is_empty()
        {
            return false;
        }
        let prop = node.as_property_access_expression();
        let name_node = prop.name();
        if !ast::is_identifier(name_node) {
            return false;
        }
        let member_name = name_node.as_identifier().text();
        let receiver_type = checker.get_type_at_location(prop.expression());
        checker
            .get_property_of_type(receiver_type, member_name)
            .is_some_and(|prop_sym| {
                prop_sym
                    .declarations()
                    .iter()
                    .any(|&decl| self.declaration_matches_member_spec(decl, member_name))
            })
    }

    fn declaration_matches_member_spec(&self, decl: P<Node>, member_name: &str) -> bool {
        let Some(owner_name) = decl
            .parent()
            .as_deref()
            .and_then(Node::name)
            .and_then(tsrs_kernel::property_name_text)
        else {
            return false;
        };
        let Some(sf) = ast::get_source_file_of_node(decl) else {
            return false;
        };
        let file_name = tsrs_kernel::normalize_path(sf.file_name());
        self.options.safe_template_tags.iter().any(|spec| {
            matches!(
                spec,
                SafeTemplateTagSpec::Member { type_name, member, source }
                    if member == member_name
                        && type_name == owner_name
                        && file_name.ends_with(&tsrs_kernel::normalize_path(source))
            )
        })
    }

    fn contains_unsafe_raw_sql_fragment(&self, expr: P<Node>, checker: &mut Checker) -> bool {
        let unwrapped = tsrs_kernel::unwrap_awaited_expression(expr);
        if self.is_unsafe_raw_builder_call(unwrapped, checker) {
            return true;
        }
        let mut found = false;
        unwrapped.for_each_child(&mut |child| {
            if !found && !tsrs_kernel::is_function_like(child) {
                found = self.contains_unsafe_raw_sql_fragment(child, checker);
            }
            found
        });
        found
    }

    fn is_unsafe_raw_builder_call(&self, node: P<Node>, checker: &mut Checker) -> bool {
        if node.kind() != Kind::CallExpression {
            return false;
        }
        let call = node.as_call_expression();
        let callee = tsrs_kernel::unwrap_expression(call.expression());
        if callee.kind() != Kind::PropertyAccessExpression {
            return false;
        }
        let prop = callee.as_property_access_expression();
        let name = prop.name();
        if !ast::is_identifier(name) || !matches!(name.as_identifier().text(), "raw" | "unsafe") {
            return false;
        }
        let builder = tsrs_kernel::unwrap_expression(prop.expression());
        self.is_trusted_sql_template_tag(builder, checker)
            && call
                .arguments()
                .nodes()
                .iter()
                .any(|&arg| Self::static_string_text(tsrs_kernel::unwrap_expression(arg)).is_none())
    }

    fn static_string_text(node: P<Node>) -> Option<String> {
        matches!(
            node.kind(),
            Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral
        )
        .then(|| node.text().to_owned())
    }

    fn combined_template_text(template_node: P<Node>) -> String {
        let template = template_node.as_template_expression();
        let mut out = String::from(template.head.text());
        for &span in template.template_spans.nodes() {
            out.push(' ');
            out.push_str(span.as_template_span().literal.text());
        }
        out
    }

    fn is_sql_statement(text: &str) -> bool {
        let tokens: Vec<String> = text
            .split(|ch: char| !ch.is_ascii_alphabetic())
            .filter(|word| !word.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
        let Some(first) = tokens.first().map(String::as_str) else {
            return false;
        };
        let adj = |a: &str, b: &str| tokens.windows(2).any(|w| w[0] == a && w[1] == b);
        (matches!(first, "select" | "with")
            && tokens
                .iter()
                .position(|tok| tok == "select")
                .is_some_and(|pos| tokens[pos + 1..].iter().any(|tok| tok == "from")))
            || (first == "update" && tokens.iter().skip(2).take(2).any(|tok| tok == "set"))
            || (matches!(first, "insert" | "replace") && adj(first, "into"))
            || (first == "delete" && adj("delete", "from"))
            || ["create", "alter", "drop"]
                .iter()
                .any(|op| adj(op, "table"))
    }
}

fn identifier_has_external_provenance(ident: P<Node>, checker: &mut Checker, depth: u8) -> bool {
    let Some(sym) = checker.get_symbol_at_location_exported(ident) else {
        return false;
    };
    sym.declarations().iter().any(|&d| {
        is_external_declaration(d)
            || decl_origin_node(d)
                .is_some_and(|n| has_external_sql_tag_provenance(n, checker, depth + 1))
    })
}

fn has_external_sql_tag_provenance(node: P<Node>, checker: &mut Checker, depth: u8) -> bool {
    if depth > 4 {
        return false;
    }
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    match unwrapped.kind() {
        Kind::Identifier => identifier_has_external_provenance(unwrapped, checker, depth),
        Kind::TypeReference => {
            let tn = unwrapped.as_type_reference_node().type_name();
            let id = if ast::is_qualified_name(tn) {
                tn.as_qualified_name().left()
            } else {
                tn
            };
            has_external_sql_tag_provenance(id, checker, depth + 1)
        }
        Kind::YieldExpression => unwrapped
            .as_yield_expression()
            .expression()
            .is_some_and(|e| has_external_sql_tag_provenance(e, checker, depth + 1)),
        Kind::CallExpression => has_external_sql_tag_provenance(
            unwrapped.as_call_expression().expression(),
            checker,
            depth + 1,
        ),
        Kind::ThisKeyword => enclosing_class_extends_external(unwrapped, checker, depth),
        Kind::PropertyAccessExpression => {
            let prop = unwrapped.as_property_access_expression();
            let name = prop.name();
            ast::is_identifier(name)
                && !matches!(name.as_identifier().text(), "raw" | "unsafe")
                && has_external_sql_tag_provenance(prop.expression(), checker, depth + 1)
        }
        _ => false,
    }
}

fn decl_origin_node(decl: P<Node>) -> Option<P<Node>> {
    match decl.kind() {
        Kind::VariableDeclaration => decl.as_variable_declaration().initializer(),
        Kind::Parameter => decl.as_parameter_declaration().type_(),
        _ => None,
    }
}

fn enclosing_class(mut current: Option<P<Node>>) -> Option<P<Node>> {
    while let Some(curr) = current {
        if curr.kind() == Kind::ClassDeclaration {
            return Some(curr);
        }
        current = curr.parent();
    }
    None
}

fn enclosing_class_extends_external(node: P<Node>, checker: &mut Checker, depth: u8) -> bool {
    let Some(cls) = enclosing_class(node.parent()) else {
        return false;
    };
    let Some(clauses) = cls.as_class_declaration().heritage_clauses() else {
        return false;
    };
    clauses
        .nodes()
        .iter()
        .flat_map(|&c| c.as_heritage_clause().types().nodes())
        .any(|&ty| {
            ast::is_expression_with_type_arguments(ty)
                && has_external_sql_tag_provenance(
                    ty.as_expression_with_type_arguments().expression(),
                    checker,
                    depth + 1,
                )
        })
}

fn is_external_declaration(decl: P<Node>) -> bool {
    (matches!(
        decl.kind(),
        Kind::ImportSpecifier | Kind::NamespaceImport | Kind::ImportClause
    ) && enclosing_import_module_name(decl)
        .is_some_and(|m| !m.starts_with('.') && !m.starts_with('/')))
        || ast::get_source_file_of_node(decl).is_some_and(|sf| {
            tsrs_kernel::normalize_path(sf.file_name()).contains("/node_modules/")
        })
}

fn enclosing_import_module_name(node: P<Node>) -> Option<String> {
    let mut current = node.parent();
    while let Some(curr) = current {
        if curr.kind() == Kind::ImportDeclaration {
            let spec = curr.as_import_declaration().module_specifier();
            return ast::is_string_literal(spec).then(|| spec.text().to_owned());
        }
        current = curr.parent();
    }
    None
}
