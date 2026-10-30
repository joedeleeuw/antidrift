use super::sql_tag_provenance::{enclosing_import_module_name, has_external_sql_tag_provenance};
use super::sql_text::{
    combined_template_text, is_sql_identifier_context, is_sql_interpolation_context,
    is_sql_statement, is_static_string, static_string_text,
};
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, ScopeOptions};
use antidrift_kernel::tsrs_kernel;
use antidrift_kernel::tsrs_kernel::cooked_text_lossy;
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
        let left = tsrs_kernel::unwrap_expression(bin.left());
        let right = tsrs_kernel::unwrap_expression(bin.right());
        if (static_string_text(left)
            .as_deref()
            .is_some_and(is_sql_statement)
            && !is_static_string(right))
            || (static_string_text(right)
                .as_deref()
                .is_some_and(is_sql_statement)
                && !is_static_string(left))
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
            && is_sql_statement(&combined_template_text(node))
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
        } else if is_sql_statement(&combined_template_text(template))
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
                cooked_text_lossy(template.head)
            } else {
                cooked_text_lossy(spans[idx - 1].as_template_span().literal)
            };
            let span = span_node.as_template_span();
            let after = cooked_text_lossy(span.literal);
            let expr = tsrs_kernel::unwrap_expression(span.expression);
            let safe = is_static_string(expr)
                || (self.is_trusted_identifier_member(expr, checker)
                    && is_sql_identifier_context(&before, &after));
            !safe && is_sql_interpolation_context(&before, &after)
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
                .any(|&arg| !is_static_string(tsrs_kernel::unwrap_expression(arg)))
    }
}
