use crate::ts_resolver::ResolutionMode;
use rustc_hash::FxHashSet;
use std::collections::BTreeMap;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportedSymbol {
    Named(&'static str),
    Default,
    Namespace,
}

#[derive(Debug, Clone, Copy)]
pub struct ImportBinding {
    pub module_specifier: &'static str,
    pub imported: ImportedSymbol,
    pub is_type_only: bool,
    pub declaration: P<Node>,
}

#[derive(Debug, Default, Clone)]
pub struct FileImports {
    bindings: BTreeMap<&'static str, ImportBinding>,
}

impl FileImports {
    #[must_use]
    pub fn collect(sf: P<SourceFile>) -> Self {
        let mut bindings = BTreeMap::new();
        for &stmt in sf.statements().nodes() {
            if stmt.kind() != Kind::ImportDeclaration {
                continue;
            }
            collect_import_declaration_bindings(stmt, &mut bindings);
        }
        Self { bindings }
    }

    #[must_use]
    pub fn binding(&self, local_name: &str) -> Option<&ImportBinding> {
        self.bindings.get(local_name)
    }

    #[must_use]
    pub fn namespaces_from(&self, module_name: &str) -> FxHashSet<&'static str> {
        let mut out = FxHashSet::default();
        for (&local, binding) in &self.bindings {
            if binding.module_specifier == module_name
                && matches!(
                    binding.imported,
                    ImportedSymbol::Default
                        | ImportedSymbol::Namespace
                        | ImportedSymbol::Named("default")
                )
            {
                out.insert(local);
            }
        }
        out
    }

    #[must_use]
    pub fn is_unshadowed_call(
        &self,
        callee: P<Node>,
        module_name: &str,
        exported_names: &[&str],
    ) -> bool {
        let inner = crate::tsrs_kernel::unwrap_expression(callee);
        if ast::is_identifier(inner) {
            if crate::local_binding::is_shadowed_import(inner) {
                return false;
            }
            let name = inner.as_identifier().text();
            return exported_names
                .iter()
                .any(|&exp| self.is_named_import_from(name, module_name, exp));
        }
        if inner.kind() != Kind::PropertyAccessExpression {
            return false;
        }
        let access = inner.as_property_access_expression();
        let prop = access.name();
        if !ast::is_identifier(prop) || !exported_names.contains(&prop.as_identifier().text()) {
            return false;
        }
        let obj = crate::tsrs_kernel::unwrap_expression(access.expression());
        ast::is_identifier(obj)
            && !crate::local_binding::is_shadowed_import(obj)
            && self
                .namespaces_from(module_name)
                .contains(obj.as_identifier().text())
    }

    #[must_use]
    pub fn locals_from(
        &self,
        module_name: &str,
        exported_names: &[&str],
    ) -> FxHashSet<&'static str> {
        let mut out = FxHashSet::default();
        for (&local, binding) in &self.bindings {
            if binding.module_specifier == module_name
                && let ImportedSymbol::Named(imported_name) = binding.imported
                && exported_names.contains(&imported_name)
            {
                out.insert(local);
            }
        }
        out
    }

    #[must_use]
    pub fn is_named_import_from(
        &self,
        local_name: &str,
        module_name: &str,
        exported_name: &str,
    ) -> bool {
        self.bindings.get(local_name).is_some_and(|binding| {
            binding.module_specifier == module_name
                && matches!(binding.imported, ImportedSymbol::Named(name) if name == exported_name)
        })
    }
}

fn collect_import_declaration_bindings(
    import_node: P<Node>,
    bindings: &mut BTreeMap<&'static str, ImportBinding>,
) {
    let import_decl = import_node.as_import_declaration();
    let spec = import_decl.module_specifier();
    if !ast::is_string_literal(spec) {
        return;
    }
    let module_specifier = spec.as_string_literal().text();
    let Some(clause_node) = import_decl.import_clause() else {
        return;
    };
    let clause = clause_node.as_import_clause();
    let clause_type_only = clause.phase_modifier() == Kind::TypeKeyword;
    if let Some(default_name) = clause.name()
        && ast::is_identifier(default_name)
    {
        bindings.insert(
            default_name.as_identifier().text(),
            ImportBinding {
                module_specifier,
                imported: ImportedSymbol::Default,
                is_type_only: clause_type_only,
                declaration: clause_node,
            },
        );
    }
    let Some(named) = clause.named_bindings() else {
        return;
    };
    match named.kind() {
        Kind::NamespaceImport => {
            let ns_name = named.as_namespace_import().name();
            if ast::is_identifier(ns_name) {
                bindings.insert(
                    ns_name.as_identifier().text(),
                    ImportBinding {
                        module_specifier,
                        imported: ImportedSymbol::Namespace,
                        is_type_only: clause_type_only,
                        declaration: named,
                    },
                );
            }
        }
        Kind::NamedImports => {
            for &elem in named.as_named_imports().elements().nodes() {
                if elem.kind() != Kind::ImportSpecifier {
                    continue;
                }
                let spec_decl = elem.as_import_specifier();
                let local_node = spec_decl.name();
                if !ast::is_identifier(local_node) {
                    continue;
                }
                let local_text = local_node.as_identifier().text();
                let imported_text = spec_decl
                    .property_name()
                    .and_then(|prop| match prop.kind() {
                        Kind::Identifier => Some(prop.as_identifier().text()),
                        Kind::StringLiteral => Some(prop.as_string_literal().text()),
                        _ => None,
                    })
                    .unwrap_or(local_text);
                bindings.insert(
                    local_text,
                    ImportBinding {
                        module_specifier,
                        imported: ImportedSymbol::Named(imported_text),
                        is_type_only: clause_type_only || spec_decl.is_type_only(),
                        declaration: elem,
                    },
                );
            }
        }
        _ => {}
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ModuleImport {
    pub source: &'static str,
    pub node: P<Node>,
    pub specifier_node: P<Node>,
    pub type_only: bool,
    pub mode: Option<ResolutionMode>,
}

#[must_use]
pub fn extract_module_import(node: P<Node>) -> Option<ModuleImport> {
    match node.kind() {
        Kind::ImportDeclaration => extract_from_import_declaration(node),
        Kind::ExportDeclaration => extract_from_export_declaration(node),
        Kind::CallExpression => extract_from_call_expression(node),
        Kind::ExternalModuleReference => {
            let expr = node.as_external_module_reference().expression();
            ast::is_string_literal(expr).then(|| ModuleImport {
                source: expr.as_string_literal().text(),
                node,
                specifier_node: expr,
                type_only: false,
                mode: Some(ResolutionMode::Require),
            })
        }
        Kind::ImportType => {
            let arg = node.as_import_type_node().argument();
            if arg.kind() != Kind::LiteralType {
                return None;
            }
            let lit = arg.as_literal_type_node().literal();
            ast::is_string_literal(lit).then(|| ModuleImport {
                source: lit.as_string_literal().text(),
                node,
                specifier_node: lit,
                type_only: true,
                mode: None,
            })
        }
        _ => None,
    }
}

fn extract_from_import_declaration(node: P<Node>) -> Option<ModuleImport> {
    let decl = node.as_import_declaration();
    let spec = decl.module_specifier();
    if !ast::is_string_literal(spec) {
        return None;
    }
    let type_only = decl.import_clause().is_some_and(|clause_node| {
        let clause = clause_node.as_import_clause();
        if clause.phase_modifier() == Kind::TypeKeyword {
            return true;
        }
        if clause.name().is_some() {
            return false;
        }
        let Some(named) = clause.named_bindings() else {
            return false;
        };
        if named.kind() != Kind::NamedImports {
            return false;
        }
        let elements = named.as_named_imports().elements().nodes();
        !elements.is_empty()
            && elements.iter().all(|&elem| {
                elem.kind() == Kind::ImportSpecifier && elem.as_import_specifier().is_type_only()
            })
    });
    Some(ModuleImport {
        source: spec.as_string_literal().text(),
        node,
        specifier_node: spec,
        type_only,
        mode: attribute_resolution_mode(decl.attributes()),
    })
}

fn extract_from_export_declaration(node: P<Node>) -> Option<ModuleImport> {
    let decl = node.as_export_declaration();
    let spec = decl.module_specifier()?;
    if !ast::is_string_literal(spec) {
        return None;
    }
    let clause_all_type = decl.export_clause().is_some_and(|clause| {
        if clause.kind() != Kind::NamedExports {
            return false;
        }
        let elements = clause.as_named_exports().elements().nodes();
        !elements.is_empty()
            && elements.iter().all(|&elem| {
                elem.kind() == Kind::ExportSpecifier && elem.as_export_specifier().is_type_only()
            })
    });
    Some(ModuleImport {
        source: spec.as_string_literal().text(),
        node,
        specifier_node: spec,
        type_only: decl.is_type_only() || clause_all_type,
        mode: attribute_resolution_mode(decl.attributes()),
    })
}

fn extract_from_call_expression(node: P<Node>) -> Option<ModuleImport> {
    let call = node.as_call_expression();
    let callee = call.expression();
    if callee.kind() != Kind::ImportKeyword {
        return None;
    }
    let first = *call.arguments().nodes().first()?;
    ast::is_string_literal(first).then(|| ModuleImport {
        source: first.as_string_literal().text(),
        node,
        specifier_node: first,
        type_only: false,
        mode: Some(ResolutionMode::Import),
    })
}

fn attribute_resolution_mode(attributes_node: Option<P<Node>>) -> Option<ResolutionMode> {
    let attrs = attributes_node?;
    if attrs.kind() != Kind::ImportAttributes {
        return None;
    }
    for &entry in attrs.as_import_attributes().attributes().nodes() {
        if entry.kind() != Kind::ImportAttribute {
            continue;
        }
        let attr = entry.as_import_attribute();
        let Some(name_node) = attr.name() else {
            continue;
        };
        let key = match name_node.kind() {
            Kind::Identifier => name_node.as_identifier().text(),
            Kind::StringLiteral => name_node.as_string_literal().text(),
            _ => continue,
        };
        if key != "resolution-mode" {
            continue;
        }
        let val = attr.value();
        if !ast::is_string_literal(val) {
            continue;
        }
        return match val.as_string_literal().text() {
            "import" => Some(ResolutionMode::Import),
            "require" => Some(ResolutionMode::Require),
            _ => None,
        };
    }
    None
}
