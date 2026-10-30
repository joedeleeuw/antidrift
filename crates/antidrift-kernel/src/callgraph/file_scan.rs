use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, SourceFile};
use tsrs_core::P;

use super::program_index::{CallSiteRecord, IdentifierRef, ProgramSymbolIndex};
use crate::tsrs_kernel;

#[derive(Clone, Debug)]
pub(super) struct HeritageRecord {
    pub(super) declaration: P<Node>,
    pub(super) binding_name: Option<P<Node>>,
    pub(super) is_abstract: bool,
    pub(super) is_interface: bool,
    pub(super) is_test_file: bool,
    pub(super) targets: Vec<P<Node>>,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct AnnotatedObjectLiteral {
    pub(super) type_name: P<Node>,
    pub(super) is_test_file: bool,
}

pub(super) struct FileScan<'a> {
    pub(super) index: &'a mut ProgramSymbolIndex,
    pub(super) file: P<SourceFile>,
    pub(super) is_test_file: bool,
}

fn callee_name_node(callee: P<Node>) -> Option<P<Node>> {
    let inner = tsrs_kernel::unwrap_expression(callee);
    match inner.kind() {
        Kind::Identifier => Some(inner),
        Kind::PropertyAccessExpression => {
            let name = inner.as_property_access_expression().name();
            ast::is_identifier(name).then_some(name)
        }
        _ => None,
    }
}

fn rightmost_type_identifier(type_name: P<Node>) -> Option<P<Node>> {
    let identifier = if ast::is_qualified_name(type_name) {
        type_name.as_qualified_name().right()
    } else {
        type_name
    };
    ast::is_identifier(identifier).then_some(identifier)
}

fn class_binding_name(declaration: P<Node>) -> Option<P<Node>> {
    if let Some(name) = declaration.name() {
        return Some(name);
    }
    let parent = declaration.parent()?;
    (parent.kind() == Kind::VariableDeclaration)
        .then(|| parent.as_variable_declaration().name())
        .filter(|name| ast::is_identifier(*name))
}

fn heritage_target_identifier(type_node: P<Node>) -> Option<P<Node>> {
    let target = match type_node.kind() {
        Kind::ExpressionWithTypeArguments => {
            let inner = tsrs_kernel::unwrap_expression(
                type_node.as_expression_with_type_arguments().expression(),
            );
            if inner.kind() == Kind::PropertyAccessExpression {
                inner.as_property_access_expression().name()
            } else {
                inner
            }
        }
        Kind::TypeReference => {
            return rightmost_type_identifier(type_node.as_type_reference_node().type_name());
        }
        _ => return None,
    };
    ast::is_identifier(target).then_some(target)
}

fn heritage_targets(declaration: P<Node>) -> Vec<P<Node>> {
    let clauses = match declaration.kind() {
        Kind::ClassDeclaration => declaration.as_class_declaration().heritage_clauses(),
        Kind::ClassExpression => declaration.as_class_expression().heritage_clauses(),
        Kind::InterfaceDeclaration => declaration.as_interface_declaration().heritage_clauses(),
        _ => None,
    };
    let Some(clauses) = clauses else {
        return Vec::new();
    };
    clauses
        .nodes()
        .iter()
        .flat_map(|clause| clause.as_heritage_clause().types().nodes().iter())
        .filter_map(|&type_node| heritage_target_identifier(type_node))
        .collect()
}

fn object_literal_annotation(node: P<Node>) -> Option<P<Node>> {
    let mut current = node;
    while let Some(parent) = current.parent() {
        if parent.kind() != Kind::ParenthesizedExpression {
            break;
        }
        current = parent;
    }
    let parent = current.parent()?;
    let type_node = match parent.kind() {
        Kind::VariableDeclaration => {
            let decl = parent.as_variable_declaration();
            (decl.initializer() == Some(current))
                .then(|| decl.type_())
                .flatten()
        }
        Kind::AsExpression => Some(parent.as_as_expression().type_()),
        Kind::SatisfiesExpression => Some(parent.as_satisfies_expression().type_()),
        _ => None,
    }?;
    (type_node.kind() == Kind::TypeReference)
        .then(|| rightmost_type_identifier(type_node.as_type_reference_node().type_name()))
        .flatten()
}

impl FileScan<'_> {
    fn record_alias(&mut self, original: P<Node>, local: P<Node>) {
        let (Some(from), Some(to)) = (
            tsrs_kernel::property_name_text(original),
            tsrs_kernel::property_name_text(local),
        ) else {
            return;
        };
        if from != to {
            self.index.add_alias(from, to);
        }
    }

    fn record_default_export(&mut self, node: P<Node>) {
        if !ast::has_syntactic_modifier(node, ModifierFlags::Default) {
            return;
        }
        if let Some(name) = node.name().filter(|name| ast::is_identifier(*name)) {
            self.index.add_alias(name.as_identifier().text(), "default");
        }
    }

    fn record_call(&mut self, node: P<Node>, callee: P<Node>, arguments: &[P<Node>]) {
        let Some(name_node) = callee_name_node(callee) else {
            return;
        };
        self.index
            .call_sites
            .entry(name_node.as_identifier().text())
            .or_default()
            .push(CallSiteRecord {
                file: self.file,
                call_node: node,
                callee_name_node: name_node,
                is_test_file: self.is_test_file,
                arg_nodes: arguments.to_vec(),
            });
    }

    fn record_heritage(&mut self, node: P<Node>) {
        let targets = heritage_targets(node);
        if targets.is_empty() {
            return;
        }
        let record_idx = self.index.heritage.len();
        for &target in &targets {
            self.index
                .heritage_by_target
                .entry(target.as_identifier().text())
                .or_default()
                .push(record_idx);
        }
        self.index.heritage.push(HeritageRecord {
            declaration: node,
            binding_name: class_binding_name(node),
            is_abstract: ast::has_syntactic_modifier(node, ModifierFlags::Abstract),
            is_interface: node.kind() == Kind::InterfaceDeclaration,
            is_test_file: self.is_test_file,
            targets,
        });
    }

    fn record_object_literal(&mut self, node: P<Node>) {
        let Some(type_name) = object_literal_annotation(node) else {
            return;
        };
        self.index
            .annotated_objects
            .entry(type_name.as_identifier().text())
            .or_default()
            .push(AnnotatedObjectLiteral {
                type_name,
                is_test_file: self.is_test_file,
            });
    }

    fn record_node(&mut self, node: P<Node>) {
        match node.kind() {
            Kind::Identifier => self
                .index
                .identifiers
                .entry(node.as_identifier().text())
                .or_default()
                .push(IdentifierRef {
                    file: self.file,
                    node,
                    is_test_file: self.is_test_file,
                }),
            Kind::CallExpression => {
                let call = node.as_call_expression();
                self.record_call(node, call.expression(), call.arguments().nodes());
            }
            Kind::NewExpression => {
                let call = node.as_new_expression();
                let arguments = call.arguments().map_or(&[][..], |list| list.nodes());
                self.record_call(node, call.expression(), arguments);
            }
            Kind::ClassDeclaration | Kind::ClassExpression | Kind::InterfaceDeclaration => {
                self.record_heritage(node);
                self.record_default_export(node);
            }
            Kind::FunctionDeclaration => self.record_default_export(node),
            Kind::ObjectLiteralExpression => self.record_object_literal(node),
            Kind::ImportSpecifier => {
                let specifier = node.as_import_specifier();
                if let Some(original) = specifier.property_name() {
                    self.record_alias(original, specifier.name());
                }
            }
            Kind::ExportSpecifier => {
                let specifier = node.as_export_specifier();
                if let Some(original) = specifier.property_name() {
                    self.record_alias(original, specifier.name());
                }
            }
            Kind::ImportClause => {
                if let Some(local) = node.as_import_clause().name() {
                    self.index
                        .add_alias("default", local.as_identifier().text());
                }
            }
            Kind::ExportAssignment => {
                let expression = node.as_export_assignment().expression();
                if ast::is_identifier(expression) {
                    self.index
                        .add_alias(expression.as_identifier().text(), "default");
                }
            }
            _ => {}
        }
    }

    pub(super) fn walk(&mut self, node: P<Node>) {
        self.record_node(node);
        node.for_each_child(&mut |child| {
            self.walk(child);
            false
        });
    }
}
