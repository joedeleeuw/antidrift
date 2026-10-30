use super::web_provenance::property_name;
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options, in_scope};
use antidrift_kernel::tsrs_kernel::cooked_text;
use serde::Deserialize;
use std::collections::BTreeSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-secure-document-response";

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct DocumentResponseOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    all_responses: bool,
    headers_module: Option<String>,
    owner: Option<String>,
}

pub struct RequireSecureDocumentResponse {
    scope: RuleScope,
    all_responses: bool,
    headers_module: Option<String>,
    owner: Option<String>,
}

pub static DEFAULT_RULE: RequireSecureDocumentResponse = RequireSecureDocumentResponse {
    scope: RuleScope::DEFAULT,
    all_responses: false,
    headers_module: None,
    owner: None,
};

impl RequireSecureDocumentResponse {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<DocumentResponseOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &parsed.scope)?;
        Ok(Self {
            scope,
            all_responses: parsed.all_responses,
            headers_module: parsed.headers_module,
            owner: parsed.owner,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ImportDeclaration),
    Listener::Enter(Kind::NewExpression),
];

impl Rule for RequireSecureDocumentResponse {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        let mut download_headers = BTreeSet::new();
        if enabled {
            collect_download_headers(ctx.file.as_node(), &mut download_headers);
        }
        let owner = self
            .owner
            .as_deref()
            .unwrap_or("a Response with explicit Content-Type, Content-Disposition and X-Content-Type-Options: nosniff headers");
        Box::new(Visitor {
            rule: self,
            enabled,
            download_headers,
            owner,
        })
    }
}

fn collect_download_headers(node: P<Node>, out: &mut BTreeSet<&'static str>) {
    if node.kind() == Kind::VariableDeclaration
        && let Some(name) = attachment_headers(node)
    {
        out.insert(name);
    }
    node.for_each_child(&mut |child| {
        collect_download_headers(child, out);
        false
    });
}

struct Visitor {
    rule: &'static RequireSecureDocumentResponse,
    enabled: bool,
    download_headers: BTreeSet<&'static str>,
    owner: &'static str,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::ImportDeclaration => {
                inspect_import(ctx, node, self.rule.headers_module.as_deref(), self.owner);
            }
            Kind::NewExpression
                if insecure_response(node, self.rule.all_responses, &self.download_headers) =>
            {
                ctx.report_node(
                    node,
                    RuleMessage::new(
                        "directResponse",
                        format!(
                            "Use {} for raw document bytes so the security policy, MIME type, and disposition are applied by construction.",
                            self.owner
                        ),
                    ),
                );
            }
            _ => {}
        }
    }
}

fn inspect_import(ctx: &mut Ctx, import_node: P<Node>, headers_module: Option<&str>, owner: &str) {
    let import = import_node.as_import_declaration();
    let spec = import.module_specifier();
    if !ast::is_string_literal(spec)
        || !cooked_text(spec).is_some_and(|module| headers_module == Some(module))
    {
        return;
    }
    let Some(clause) = import.import_clause() else {
        return;
    };
    let Some(bindings) = clause.as_import_clause().named_bindings() else {
        return;
    };
    if bindings.kind() != Kind::NamedImports {
        return;
    }
    let manual = bindings
        .as_named_imports()
        .elements()
        .nodes()
        .iter()
        .copied()
        .find(|&elem| {
            if elem.kind() != Kind::ImportSpecifier {
                return false;
            }
            let spec_decl = elem.as_import_specifier();
            let imported = spec_decl
                .property_name()
                .unwrap_or_else(|| spec_decl.name());
            ast::is_identifier(imported)
                && imported.as_identifier().text() == "RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS"
        });
    if let Some(specifier) = manual {
        ctx.report_node(
            specifier,
            RuleMessage::new(
                "manualHeaders",
                format!(
                    "Handler modules must not assemble raw document security headers manually. Use {owner}."
                ),
            ),
        );
    }
}

fn attachment_headers(variable: P<Node>) -> Option<&'static str> {
    let name_node = variable.name()?;
    if !ast::is_identifier(name_node) {
        return None;
    }
    let init = variable.as_variable_declaration().initializer()?;
    if init.kind() != Kind::NewExpression {
        return None;
    }
    let constructor = init.as_new_expression();
    let callee = constructor.expression();
    if !ast::is_identifier(callee) || callee.as_identifier().text() != "Headers" {
        return None;
    }
    let first_arg = *constructor.arguments()?.nodes().first()?;
    if first_arg.kind() != Kind::ObjectLiteralExpression {
        return None;
    }
    attachment_disposition(first_arg).then(|| name_node.as_identifier().text())
}

fn insecure_response(
    constructor_node: P<Node>,
    all_responses: bool,
    download_headers: &BTreeSet<&'static str>,
) -> bool {
    let constructor = constructor_node.as_new_expression();
    let callee = constructor.expression();
    let args = constructor.arguments().map_or(&[][..], |a| a.nodes());
    if !ast::is_identifier(callee)
        || callee.as_identifier().text() != "Response"
        || args
            .first()
            .is_none_or(|&body| matches!(body.kind(), Kind::NullKeyword | Kind::SpreadElement))
    {
        return false;
    }
    let headers = args
        .get(1)
        .copied()
        .filter(|init| init.kind() == Kind::ObjectLiteralExpression)
        .and_then(|init| {
            init.as_object_literal_expression()
                .properties()
                .nodes()
                .iter()
                .copied()
                .find_map(|prop| {
                    if prop.kind() != Kind::PropertyAssignment {
                        return None;
                    }
                    let assign = prop.as_property_assignment();
                    (property_name(assign.name()) == Some("headers")).then(|| assign.initializer())
                })
        });
    let download = all_responses
        || match headers.map(|h| (h.kind(), h)) {
            Some((Kind::ObjectLiteralExpression, headers_obj)) => {
                attachment_disposition(headers_obj)
            }
            Some((Kind::Identifier, ident)) => {
                download_headers.contains(ident.as_identifier().text())
            }
            _ => false,
        };
    download
        && !headers.is_some_and(|headers_node| {
            headers_node.kind() == Kind::ObjectLiteralExpression
                && explicit_security_headers(headers_node)
        })
}

fn attachment_disposition(headers: P<Node>) -> bool {
    let disposition = headers
        .as_object_literal_expression()
        .properties()
        .nodes()
        .iter()
        .copied()
        .find_map(|property| {
            if property.kind() != Kind::PropertyAssignment {
                return None;
            }
            let assign = property.as_property_assignment();
            property_name(assign.name())
                .is_some_and(|name| name.eq_ignore_ascii_case("content-disposition"))
                .then(|| assign.initializer())
        });
    let Some(disposition) = disposition else {
        return false;
    };
    match disposition.kind() {
        Kind::StringLiteral => cooked_text(disposition)
            .is_some_and(|text| text.to_lowercase().starts_with("attachment;")),
        Kind::CallExpression => {
            let callee = disposition.as_call_expression().expression();
            ast::is_identifier(callee) && callee.as_identifier().text() == "contentDisposition"
        }
        _ => false,
    }
}

fn explicit_security_headers(headers: P<Node>) -> bool {
    let mut content_type = false;
    let mut content_disposition = false;
    let mut nosniff = false;
    for &property in headers.as_object_literal_expression().properties().nodes() {
        if property.kind() != Kind::PropertyAssignment {
            continue;
        }
        let assign = property.as_property_assignment();
        let Some(name) = property_name(assign.name()) else {
            continue;
        };
        match name.to_lowercase().as_str() {
            "content-type" => content_type = true,
            "content-disposition" => content_disposition = true,
            "x-content-type-options" => {
                let val = assign.initializer();
                nosniff = val.kind() == Kind::StringLiteral && cooked_text(val) == Some("nosniff");
            }
            _ => {}
        }
    }
    content_type && content_disposition && nosniff
}
