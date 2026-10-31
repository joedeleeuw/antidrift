use antidrift_kernel::rule_options::decode_rule_options;
use antidrift_kernel::tsrs_kernel::cooked_text;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-static-devtools-import";

const DEVTOOLS_PACKAGES: &[&str] = &[
    "@tanstack/react-devtools",
    "@tanstack/react-query-devtools",
    "@tanstack/react-router-devtools",
    "@tanstack/react-table-devtools",
];

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct NoStaticDevtoolsImportOptions {
    modules: Vec<String>,
}

pub struct NoStaticDevtoolsImport {
    modules: Vec<String>,
}

pub static DEFAULT_RULE: NoStaticDevtoolsImport = NoStaticDevtoolsImport {
    modules: Vec::new(),
};

impl NoStaticDevtoolsImport {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<NoStaticDevtoolsImportOptions>(RULE_NAME, options)?;
        Ok(Self {
            modules: parsed.modules,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::ImportDeclaration)];

impl Rule for NoStaticDevtoolsImport {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor { rule: self })
    }
}

struct Visitor {
    rule: &'static NoStaticDevtoolsImport,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if is_type_only_import(node) {
            return;
        }
        let spec = node.as_import_declaration().module_specifier();
        if !ast::is_string_literal(spec) {
            return;
        }
        let Some(source) = cooked_text(spec) else {
            return;
        };
        if DEVTOOLS_PACKAGES.contains(&source) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "staticDevtoolsPackage",
                    "Keep TanStack devtools package imports inside the approved lazy-loaded devtools modules.",
                ),
            );
            return;
        }
        if self.rule.modules.iter().any(|module| module == source) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "staticDevtoolsModule",
                    "Keep devtools modules behind a dynamic import so route shells can mount before devtools code loads.",
                ),
            );
        }
    }
}

fn is_type_only_import(import_node: P<Node>) -> bool {
    let Some(clause_node) = import_node.as_import_declaration().import_clause() else {
        return false;
    };
    let clause = clause_node.as_import_clause();
    if clause.phase_modifier() == Kind::TypeKeyword {
        return true;
    }
    if clause.name().is_some() {
        return false;
    }
    let Some(bindings) = clause.named_bindings() else {
        return false;
    };
    if bindings.kind() != Kind::NamedImports {
        return false;
    }
    let elems = bindings.as_named_imports().elements().nodes();
    !elems.is_empty()
        && elems.iter().all(|&spec| {
            spec.kind() == Kind::ImportSpecifier && spec.as_import_specifier().is_type_only()
        })
}
