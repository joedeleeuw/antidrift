use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-ambient-hotkey-format";
const HOTKEY_MODULES: [&str; 2] = ["@tanstack/hotkeys", "@tanstack/react-hotkeys"];
const AMBIENT_EXPORTS: [&str; 2] = ["detectPlatform", "formatForDisplay"];
const MESSAGE: &str = "Ambient hotkey platform reads can differ between SSR and hydration. Use useHydrationSafeHotkeyPlatform() with formatHotkeyForPlatform().";

pub struct NoAmbientHotkeyFormat {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoAmbientHotkeyFormat = NoAmbientHotkeyFormat {
    scope: RuleScope::DEFAULT,
};

impl NoAmbientHotkeyFormat {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::ImportDeclaration)];

impl Rule for NoAmbientHotkeyFormat {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        Box::new(Visitor { enabled })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let decl = node.as_import_declaration();
        let spec = decl.module_specifier();
        if !ast::is_string_literal(spec)
            || !HOTKEY_MODULES.contains(&spec.as_string_literal().text())
        {
            return;
        }
        let Some(clause_node) = decl.import_clause() else {
            return;
        };
        let Some(bindings) = clause_node.as_import_clause().named_bindings() else {
            return;
        };
        match bindings.kind() {
            Kind::NamespaceImport => {
                ctx.report_node(bindings, RuleMessage::new("ambientHotkeyFormat", MESSAGE));
            }
            Kind::NamedImports => {
                report_named_imports(ctx, bindings.as_named_imports().elements().nodes());
            }
            _ => {}
        }
    }
}

fn report_named_imports(ctx: &mut Ctx, elements: &[P<Node>]) {
    for &elem in elements {
        if is_ambient_specifier(elem) {
            ctx.report_node(elem, RuleMessage::new("ambientHotkeyFormat", MESSAGE));
        }
    }
}

fn is_ambient_specifier(specifier: P<Node>) -> bool {
    if specifier.kind() != Kind::ImportSpecifier {
        return false;
    }
    let spec = specifier.as_import_specifier();
    let imported = spec.property_name().unwrap_or_else(|| spec.name());
    let name = match imported.kind() {
        Kind::Identifier => imported.as_identifier().text(),
        Kind::StringLiteral => imported.as_string_literal().text(),
        _ => return false,
    };
    AMBIENT_EXPORTS.contains(&name)
}
