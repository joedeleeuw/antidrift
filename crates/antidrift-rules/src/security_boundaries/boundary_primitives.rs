use super::package_ownership::{PackageOwner, absolute_filename, package_owner};
use super::web_provenance::{
    AliasStability, ImportedOwner, const_initializer, imported_owner, member_expression,
    member_object, resolve_lexical_binding, static_property_name, unwrap_expression,
};
use antidrift_kernel::imports::extract_module_import;
use antidrift_kernel::jsx::element_tag_name;
use antidrift_kernel::local_binding::Binding;
use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleSpec, RuleVisitor};
use antidrift_kernel::tsrs_kernel::cooked_text;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

const BUN_LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ImportDeclaration),
    Listener::Enter(Kind::PropertyAccessExpression),
    Listener::Enter(Kind::ElementAccessExpression),
];
const CROSS_PACKAGE_LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ImportDeclaration),
    Listener::Enter(Kind::ExportDeclaration),
    Listener::Enter(Kind::CallExpression),
];
const CALL_LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];
const JSX_ATTR_LISTENERS: &[Listener] = &[Listener::Enter(Kind::JsxAttribute)];

pub static NO_BUN_API_IN_SHARED: RuleSpec = RuleSpec::new(
    "antidrift/no-bun-api-in-shared",
    BUN_LISTENERS,
    visit_bun_api_in_shared,
);

pub static REQUIRE_SAFE_WINDOW_OPEN: RuleSpec = RuleSpec::new(
    "antidrift/require-safe-window-open",
    CALL_LISTENERS,
    visit_safe_window_open,
);

fn visit_bun_api_in_shared(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    let violation = match node.kind() {
        Kind::ImportDeclaration => {
            let spec = node.as_import_declaration().module_specifier();
            ast::is_string_literal(spec)
                && cooked_text(spec)
                    .is_some_and(|source| source == "bun" || source.starts_with("bun:"))
        }
        Kind::PropertyAccessExpression => {
            unbound_bun(node.as_property_access_expression().expression())
        }
        Kind::ElementAccessExpression => {
            unbound_bun(node.as_element_access_expression().expression())
        }
        _ => false,
    };
    if violation {
        ctx.report_node(
            node,
            RuleMessage::new(
                "runtime",
                "Keep shared code runtime independent; move Bun APIs into the runtime adapter owner.",
            ),
        );
    }
}

fn unbound_bun(expression: P<Node>) -> bool {
    expression.kind() == Kind::Identifier
        && expression.as_identifier().text() == "Bun"
        && resolve_lexical_binding(expression).is_none()
}

pub struct NoRelativeCrossPackageImports;

pub static NO_RELATIVE_CROSS_PACKAGE_IMPORTS: NoRelativeCrossPackageImports =
    NoRelativeCrossPackageImports;

impl Rule for NoRelativeCrossPackageImports {
    fn name(&self) -> &'static str {
        "antidrift/no-relative-cross-package-imports"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        match load_owner_state(ctx.file.file_name()) {
            Ok(state) => Box::new(CrossPackageVisitor { state }),
            Err(message) => {
                ctx.report_range(0, 0, RuleMessage::new("invalidPackageOwnership", message));
                Box::new(CrossPackageVisitor { state: None })
            }
        }
    }
}

struct OwnerState {
    owner: PackageOwner,
    parent: PathBuf,
}

fn load_owner_state(file_name: &str) -> Result<Option<OwnerState>, String> {
    let filename = absolute_filename(Path::new(file_name))?;
    let Some(owner) = package_owner(&filename)? else {
        return Ok(None);
    };
    let Some(parent) = filename.parent() else {
        return Ok(None);
    };
    Ok(Some(OwnerState {
        owner,
        parent: parent.to_path_buf(),
    }))
}

struct CrossPackageVisitor {
    state: Option<OwnerState>,
}

impl RuleVisitor for CrossPackageVisitor {
    fn listeners(&self) -> &[Listener] {
        if self.state.is_some() {
            CROSS_PACKAGE_LISTENERS
        } else {
            &[]
        }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let Some(state) = &self.state else {
            return;
        };
        let Some(import) = extract_module_import(node) else {
            return;
        };
        if !import.source.starts_with('.') {
            return;
        }
        match package_owner(&state.parent.join(import.source)) {
            Ok(Some(destination)) => {
                if destination.directory != state.owner.directory
                    && !state.owner.directory.starts_with(&destination.directory)
                {
                    let destination_name = destination
                        .manifest
                        .name
                        .unwrap_or_else(|| destination.directory.display().to_string());
                    ctx.report_node(
                        import.node,
                        RuleMessage::new(
                            "crossPackage",
                            format!(
                                "Import '{}' through the destination package's public entrypoint; {destination_name} owns these files; declare the shared contract in that package before importing it.",
                                import.source
                            ),
                        ),
                    );
                }
            }
            Ok(None) => {}
            Err(message) => {
                ctx.report_range(0, 0, RuleMessage::new("invalidPackageOwnership", message));
            }
        }
    }
}

fn visit_safe_window_open(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    let call = node.as_call_expression();
    let third_arg = call
        .arguments()
        .nodes()
        .get(2)
        .copied()
        .filter(|arg| arg.kind() != Kind::SpreadElement);
    if !browser_open(ctx.file, call.expression()) || safe_features(third_arg) {
        return;
    }
    ctx.report_node(
        node,
        RuleMessage::new(
            "requireSafeWindowOpen",
            "Pass noopener,noreferrer in the third argument to window.open() so the browser isolates the opener.",
        ),
    );
}

fn browser_open(sf: P<SourceFile>, expression: P<Node>) -> bool {
    let expression = unwrap_expression(expression);
    if expression.kind() == Kind::Identifier {
        return expression.as_identifier().text() == "open"
            && resolve_lexical_binding(expression).is_none();
    }
    member_expression(expression).is_some_and(|member| {
        static_property_name(member) == Some("open")
            && browser_global(sf, member_object(member), &mut Vec::new())
    })
}

fn browser_global(sf: P<SourceFile>, expression: P<Node>, visited: &mut Vec<Binding>) -> bool {
    let expression = unwrap_expression(expression);
    if expression.kind() == Kind::Identifier {
        let symbol = resolve_lexical_binding(expression);
        if matches!(
            expression.as_identifier().text(),
            "window" | "globalThis" | "self"
        ) && symbol.is_none()
        {
            return true;
        }
        let Some(symbol) = symbol else {
            return false;
        };
        if visited.contains(&symbol) {
            return false;
        }
        visited.push(symbol);
        return const_initializer(sf, symbol, AliasStability::Unwritten)
            .is_some_and(|initializer| browser_global(sf, initializer, visited));
    }
    member_expression(expression).is_some_and(|member| {
        static_property_name(member) == Some("window")
            && browser_global(sf, member_object(member), visited)
    })
}

fn safe_features(features: Option<P<Node>>) -> bool {
    let Some(features) = features else {
        return false;
    };
    if features.kind() != Kind::StringLiteral {
        return false;
    }
    let Some(text) = cooked_text(features) else {
        return false;
    };
    ["noopener", "noreferrer"].iter().all(|required| {
        text.split(',').any(|segment| {
            segment
                .trim_start()
                .strip_prefix(required)
                .is_some_and(|tail| tail.is_empty() || tail.starts_with(char::is_whitespace))
        })
    })
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HrefOptions {
    sanitizers: Vec<ImportedOwner>,
}

pub struct NoUnsanitizedHref {
    sanitizers: Vec<ImportedOwner>,
}

pub static NO_UNSANITIZED_HREF: NoUnsanitizedHref = NoUnsanitizedHref {
    sanitizers: Vec::new(),
};

impl crate::ConfigurableRule for NoUnsanitizedHref {
    type Options = HrefOptions;

    fn from_options(parsed: Self::Options) -> Result<Self, String> {
        Ok(Self {
            sanitizers: parsed.sanitizers,
        })
    }
}

impl Rule for NoUnsanitizedHref {
    fn name(&self) -> &'static str {
        "antidrift/no-unsanitized-href"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(HrefVisitor { rule: self })
    }
}

struct HrefVisitor {
    rule: &'static NoUnsanitizedHref,
}

impl RuleVisitor for HrefVisitor {
    fn listeners(&self) -> &[Listener] {
        JSX_ATTR_LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let attr = node.as_jsx_attribute();
        let name = attr.name();
        if !ast::is_identifier(name) || name.as_identifier().text() != "href" {
            return;
        }
        let Some(opening) = node.parent().and_then(|attrs| attrs.parent()) else {
            return;
        };
        if element_tag_name(opening) != Some("a")
            || attr
                .initializer()
                .is_none_or(|init| safe_attribute(ctx.file, init, &self.rule.sanitizers))
        {
            return;
        }
        ctx.report_node(
            node,
            RuleMessage::new(
                "unsanitizedHref",
                "Sanitize dynamic href values through the imported URL-policy owner registered in sanitizers at the anchor sink to prevent javascript: XSS. Static http(s), mailto, fragment, and relative literals are allowed.",
            ),
        );
    }
}

fn safe_attribute(sf: P<SourceFile>, attribute: P<Node>, sanitizers: &[ImportedOwner]) -> bool {
    match attribute.kind() {
        Kind::StringLiteral => cooked_text(attribute).is_some_and(safe_prefix),
        Kind::JsxExpression => {
            attribute
                .as_jsx_expression()
                .expression()
                .is_some_and(|expression| match expression.kind() {
                    Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral => {
                        cooked_text(expression).is_some_and(safe_prefix)
                    }
                    Kind::TemplateExpression => {
                        cooked_text(expression.as_template_expression().head())
                            .is_some_and(safe_prefix)
                    }
                    Kind::CallExpression => {
                        imported_owner(sf, expression.as_call_expression().expression(), sanitizers)
                    }
                    Kind::Identifier => expression.as_identifier().text() == "undefined",
                    Kind::NullKeyword => true,
                    _ => false,
                })
        }
        Kind::JsxElement | Kind::JsxSelfClosingElement | Kind::JsxFragment => true,
        _ => false,
    }
}

fn safe_prefix(href: &str) -> bool {
    ["https://", "http://", "/", "#", "mailto:"]
        .iter()
        .any(|prefix| href.starts_with(prefix))
}
