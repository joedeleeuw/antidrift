use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{provenance, tsrs_kernel};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-reexport-only-module";

pub struct NoReexportOnlyModule {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoReexportOnlyModule = NoReexportOnlyModule {
    scope: RuleScope::DEFAULT,
};

impl NoReexportOnlyModule {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

impl Rule for NoReexportOnlyModule {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.admits_authored_source(ctx) || is_tool_config_file(ctx.file.file_name()) {
            return Box::new(EmptyVisitor);
        }
        match provenance::is_package_entry_file(ctx.file.file_name()) {
            Ok(true) => return Box::new(EmptyVisitor),
            Ok(false) => {}
            Err(error) => {
                ctx.report_node(
                    ctx.file.as_node(),
                    RuleMessage::new("invalidPackageJson", error.to_string()),
                );
                return Box::new(EmptyVisitor);
            }
        }
        let statements = ctx.file.statements().nodes();
        if let Some(first_export) = reexport_only_anchor(statements) {
            ctx.report_node(
                first_export,
                RuleMessage::new(
                    "reexportOnlyModule",
                    "This module only re-exports bindings owned elsewhere. Import from the owning module directly and delete this hop.",
                ),
            );
        }
        Box::new(EmptyVisitor)
    }
}

#[derive(Default)]
struct ModuleShape {
    imported: FxHashSet<&'static str>,
    specifiers: Vec<&'static str>,
    first_export: Option<P<Node>>,
}

impl ModuleShape {
    fn record_import(&mut self, stmt: P<Node>) -> bool {
        let decl = stmt.as_import_declaration();
        let Some(clause) = decl.import_clause() else {
            return false;
        };
        let import_clause = clause.as_import_clause();
        if let Some(default_name) = import_clause.name() {
            self.imported.insert(default_name.as_identifier().text());
        }
        let bindings = import_clause.named_bindings();
        match bindings.map(|node| node.kind()) {
            None => {}
            Some(Kind::NamespaceImport) => {
                let namespace = bindings.map(|node| node.as_namespace_import().name());
                self.imported
                    .extend(namespace.map(|name| name.as_identifier().text()));
            }
            Some(Kind::NamedImports) => {
                let elements =
                    bindings.map_or(&[][..], |node| node.as_named_imports().elements().nodes());
                self.imported.extend(
                    elements
                        .iter()
                        .map(|element| element.as_import_specifier().name().as_identifier().text()),
                );
            }
            Some(_) => return false,
        }
        self.specifiers.push(decl.module_specifier().text());
        true
    }

    fn record_local_exports(&self, clause: Option<P<Node>>) -> bool {
        let Some(clause) = clause.filter(|node| node.kind() == Kind::NamedExports) else {
            return false;
        };
        let elements = clause.as_named_exports().elements().nodes();
        !elements.is_empty()
            && elements.iter().all(|&element| {
                let specifier = element.as_export_specifier();
                let local = specifier
                    .property_name()
                    .unwrap_or_else(|| specifier.name());
                ast::is_identifier(local) && self.imported.contains(local.as_identifier().text())
            })
    }

    fn record_export(&mut self, stmt: P<Node>) -> bool {
        let accepted = match stmt.kind() {
            Kind::ExportDeclaration => {
                let decl = stmt.as_export_declaration();
                match decl.module_specifier() {
                    Some(specifier) => {
                        self.specifiers.push(specifier.text());
                        true
                    }
                    None => self.record_local_exports(decl.export_clause()),
                }
            }
            Kind::ExportAssignment => {
                let expression = stmt.as_export_assignment().expression();
                ast::is_identifier(expression)
                    && self.imported.contains(expression.as_identifier().text())
            }
            _ => false,
        };
        if accepted && self.first_export.is_none() {
            self.first_export = Some(stmt);
        }
        accepted
    }
}

fn is_tool_config_file(file_name: &str) -> bool {
    let normalized = tsrs_kernel::normalize_path(file_name);
    let base = normalized.rsplit('/').next().unwrap_or(&normalized);
    let mut parts = base.split('.');
    match parts.next() {
        Some("") => parts.next().is_some_and(|name| name.ends_with("rc")),
        Some(_) => parts.next() == Some("config"),
        None => false,
    }
}

fn is_private_sibling(specifier: &str) -> bool {
    specifier.starts_with("./_")
}

fn reexport_only_anchor(statements: &[P<Node>]) -> Option<P<Node>> {
    let mut shape = ModuleShape::default();
    for &stmt in statements {
        if stmt.kind() == Kind::ImportDeclaration && !shape.record_import(stmt) {
            return None;
        }
    }
    for &stmt in statements {
        if stmt.kind() != Kind::ImportDeclaration && !shape.record_export(stmt) {
            return None;
        }
    }
    if shape
        .specifiers
        .iter()
        .all(|specifier| is_private_sibling(specifier))
    {
        return None;
    }
    shape.first_export
}
