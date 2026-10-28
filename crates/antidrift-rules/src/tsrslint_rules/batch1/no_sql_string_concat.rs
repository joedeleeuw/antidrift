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

const BEFORE_KEYWORDS: &[&str] = &[
    "FROM",
    "JOIN",
    "UPDATE",
    "INTO",
    "TABLE",
    "WHERE",
    "AND",
    "OR",
    "IN",
    "VALUES",
    "SET",
    "ON",
    "LIKE",
    "ORDER BY",
    "GROUP BY",
    "PARTITION BY",
];

const AFTER_KEYWORDS: &[&str] = &[
    "AND",
    "OR",
    "WHERE",
    "FROM",
    "JOIN",
    "ORDER BY",
    "GROUP BY",
    "PARTITION BY",
    "LIMIT",
    "OFFSET",
    "HAVING",
    "SET",
    "VALUES",
    "IN",
];

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SqlConcatOptions {
    pub safe_identifier_members: Vec<SafeIdentifierMemberSpec>,
    pub safe_template_tags: Vec<SafeTemplateTagSpec>,
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
}

pub static DEFAULT_RULE: NoSqlStringConcat = NoSqlStringConcat {
    options: SqlConcatOptions {
        safe_identifier_members: Vec::new(),
        safe_template_tags: Vec::new(),
    },
};

impl NoSqlStringConcat {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = super::decode_rule_options::<SqlConcatOptions>(RULE_NAME, options)?;
        Ok(Self { options: parsed })
    }
}

impl Rule for NoSqlStringConcat {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
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
        let left_sql =
            Self::static_string_text(left).is_some_and(|text| Self::is_sql_statement(&text));
        let right_sql =
            Self::static_string_text(right).is_some_and(|text| Self::is_sql_statement(&text));
        let left_non_literal = Self::static_string_text(left).is_none();
        let right_non_literal = Self::static_string_text(right).is_none();
        if (left_sql && right_non_literal) || (right_sql && left_non_literal) {
            ctx.report_node(node, RuleMessage::new("no-sql-string-concat", MESSAGE));
        }
    }

    fn check_template(&self, node: P<Node>, ctx: &mut Ctx) {
        if node
            .parent()
            .is_some_and(ast::is_tagged_template_expression)
        {
            return;
        }
        let template = node.as_template_expression();
        if template.template_spans.nodes().is_empty() {
            return;
        }
        let combined = Self::combined_template_text(node);
        if Self::is_sql_statement(&combined) && self.has_unsafe_sql_interpolation(node, ctx.checker)
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
        let tag = tagged.tag;
        if self.is_trusted_sql_template_tag(tag, ctx.checker) {
            self.report_unsafe_raw_fragments(spans, ctx);
            return;
        }
        let combined = Self::combined_template_text(template);
        if Self::is_sql_statement(&combined)
            && self.has_unsafe_sql_interpolation(template, ctx.checker)
        {
            ctx.report_node(node, RuleMessage::new("no-sql-string-concat", MESSAGE));
        }
    }

    fn has_unsafe_sql_interpolation(&self, template_node: P<Node>, checker: &mut Checker) -> bool {
        let template = template_node.as_template_expression();
        let spans = template.template_spans.nodes();
        for (idx, &span_node) in spans.iter().enumerate() {
            let before = if idx == 0 {
                template.head.text()
            } else {
                spans[idx - 1].as_template_span().literal.text()
            };
            let span = span_node.as_template_span();
            let after = span.literal.text();
            if !self.is_safe_sql_span(span.expression, before, after, checker)
                && Self::is_sql_interpolation_context(before, after)
            {
                return true;
            }
        }
        false
    }

    fn is_safe_sql_span(
        &self,
        expr: P<Node>,
        before: &str,
        after: &str,
        checker: &mut Checker,
    ) -> bool {
        let unwrapped = tsrs_kernel::unwrap_expression(expr);
        if Self::static_string_text(unwrapped).is_some() {
            return true;
        }
        self.is_trusted_identifier_member(unwrapped, checker)
            && Self::is_sql_identifier_context(before, after)
    }

    fn is_trusted_identifier_member(&self, node: P<Node>, checker: &mut Checker) -> bool {
        if node.kind() != Kind::PropertyAccessExpression
            || self.options.safe_identifier_members.is_empty()
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
        let Some(sym) = receiver_type.symbol() else {
            return false;
        };
        let owner_name = sym.name();
        self.options
            .safe_identifier_members
            .iter()
            .any(|spec| spec.member == member_name && spec.type_name == owner_name)
    }

    fn is_sql_identifier_context(before: &str, after: &str) -> bool {
        let norm_before = Self::normalized_sql_context(before);
        [
            "ORDER BY",
            "GROUP BY",
            "PARTITION BY",
            "FROM",
            "JOIN",
            "UPDATE",
            "INTO",
            "TABLE",
        ]
        .iter()
        .any(|kw| norm_before == *kw || norm_before.ends_with(&format!(" {kw}")))
            || after.trim_start().starts_with('=')
    }

    fn is_sql_interpolation_context(before: &str, after: &str) -> bool {
        let trimmed_before = Self::strip_trailing_sql_quote(before);
        let norm_before = Self::normalized_sql_context(trimmed_before);
        let ends_kw = BEFORE_KEYWORDS.iter().any(|kw| {
            norm_before == *kw
                || norm_before.ends_with(&format!(" {kw}"))
                || norm_before.ends_with(&format!(" {kw} ("))
        });
        let ends_op = ["=", "(", ","]
            .iter()
            .any(|op| trimmed_before.ends_with(op));
        let trimmed_after = Self::strip_leading_sql_quote(after);
        let norm_after = Self::normalized_sql_context(trimmed_after);
        let starts_kw = norm_after.starts_with(')')
            || norm_after.starts_with(',')
            || AFTER_KEYWORDS
                .iter()
                .any(|kw| norm_after == *kw || norm_after.starts_with(&format!("{kw} ")));
        ends_kw || ends_op || starts_kw
    }

    fn strip_trailing_sql_quote(text: &str) -> &str {
        let trimmed = text.trim_end();
        trimmed
            .strip_suffix(['\'', '"', '`'])
            .map_or(trimmed, str::trim_end)
    }

    fn strip_leading_sql_quote(text: &str) -> &str {
        let trimmed = text.trim_start();
        trimmed
            .strip_prefix(['\'', '"', '`'])
            .map_or(trimmed, str::trim_start)
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
    }

    fn is_trusted_imported_tag(&self, node: P<Node>, checker: &mut Checker) -> bool {
        if !ast::is_identifier(node) || self.options.safe_template_tags.is_empty() {
            return false;
        }
        let Some(sym) = checker.get_symbol_at_location_exported(node) else {
            return false;
        };
        for &decl in sym.declarations() {
            if decl.kind() == Kind::ImportSpecifier
                && let Some((module_name, export_name)) = Self::import_specifier_origin(decl)
                && self.matches_imported_spec(&module_name, &export_name)
            {
                return true;
            }
        }
        false
    }

    fn matches_imported_spec(&self, module_name: &str, export_name: &str) -> bool {
        self.options.safe_template_tags.iter().any(|spec| {
            matches!(
                spec,
                SafeTemplateTagSpec::Imported {
                    module,
                    export_name: expected_export,
                    ..
                } if module == module_name && expected_export == export_name
            )
        })
    }

    fn import_specifier_origin(specifier: P<Node>) -> Option<(String, String)> {
        let mut idents: Vec<String> = Vec::new();
        specifier.for_each_child(&mut |child| {
            if ast::is_identifier(child) {
                idents.push(child.as_identifier().text().to_string());
            }
            false
        });
        let export_name = idents.first()?.clone();
        let module_name = Self::enclosing_import_module_name(specifier)?;
        Some((module_name, export_name))
    }

    fn enclosing_import_module_name(node: P<Node>) -> Option<String> {
        let mut current = node.parent();
        while let Some(curr) = current {
            if curr.kind() == Kind::ImportDeclaration {
                let spec = curr.as_import_declaration().module_specifier();
                return ast::is_string_literal(spec).then(|| spec.text().to_string());
            }
            current = curr.parent();
        }
        None
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
        let Some(prop_sym) = checker.get_property_of_type(receiver_type, member_name) else {
            return false;
        };
        for &decl in prop_sym.declarations() {
            if self.declaration_matches_member_spec(decl, member_name) {
                return true;
            }
        }
        false
    }

    fn declaration_matches_member_spec(&self, decl: P<Node>, member_name: &str) -> bool {
        let Some(parent) = decl.parent() else {
            return false;
        };
        let Some(owner_name_node) = parent.name() else {
            return false;
        };
        let Some(owner_name) = tsrs_kernel::property_name_text(owner_name_node) else {
            return false;
        };
        let Some(sf) = ast::get_source_file_of_node(decl) else {
            return false;
        };
        let file_name = tsrs_kernel::normalize_path(sf.file_name());
        self.options.safe_template_tags.iter().any(|spec| {
            let SafeTemplateTagSpec::Member {
                type_name,
                member,
                source,
                ..
            } = spec
            else {
                return false;
            };
            let normalized_source = tsrs_kernel::normalize_path(source);
            member == member_name
                && type_name == owner_name
                && file_name.ends_with(&normalized_source)
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
        if !ast::is_identifier(name) || name.as_identifier().text() != "raw" {
            return false;
        }
        let builder = tsrs_kernel::unwrap_expression(prop.expression());
        if !self.is_trusted_sql_template_tag(builder, checker) {
            return false;
        }
        call.arguments()
            .nodes()
            .iter()
            .any(|&arg| Self::static_string_text(tsrs_kernel::unwrap_expression(arg)).is_none())
    }

    fn static_string_text(node: P<Node>) -> Option<String> {
        match node.kind() {
            Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral => {
                Some(node.text().to_string())
            }
            _ => None,
        }
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
        Self::tokens_match_sql_pair(&tokens, "select", "from")
            || Self::tokens_match_sql_pair(&tokens, "insert", "into")
            || Self::tokens_match_sql_pair(&tokens, "update", "set")
            || Self::tokens_match_sql_pair(&tokens, "delete", "from")
            || Self::tokens_match_adjacent(&tokens, "create", "table")
            || Self::tokens_match_adjacent(&tokens, "alter", "table")
            || Self::tokens_match_adjacent(&tokens, "drop", "table")
    }

    fn tokens_match_sql_pair(tokens: &[String], first: &str, second: &str) -> bool {
        let Some(first_pos) = tokens.iter().position(|tok| tok == first) else {
            return false;
        };
        tokens[first_pos + 1..].iter().any(|tok| tok == second)
    }

    fn tokens_match_adjacent(tokens: &[String], first: &str, second: &str) -> bool {
        tokens
            .windows(2)
            .any(|pair| pair[0] == first && pair[1] == second)
    }
}
