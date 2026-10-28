use std::hash::{Hash, Hasher};

use crate::provenance::{symbol_at_node, symbol_declarations};
use crate::tsrs_kernel::{is_function_like, unwrap_expression};
use tsrs_ast::{self as ast, Kind, Node, NodeFlags, SourceFile};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::utils::trim_node_text_range;

#[derive(Clone, Copy)]
pub struct Binding {
    pub decl: P<Node>,
    pub ident: P<Node>,
}

impl Binding {
    #[must_use]
    pub fn name(self) -> &'static str {
        self.ident.as_identifier().text()
    }

    #[must_use]
    pub fn range(self, sf: P<SourceFile>) -> (i32, i32) {
        trim_node_text_range(sf, self.ident)
    }

    #[must_use]
    pub fn is_import_binding(self) -> bool {
        matches!(
            self.decl.kind(),
            Kind::ImportSpecifier | Kind::ImportClause | Kind::NamespaceImport
        )
    }

    #[must_use]
    pub fn is_top_level(self) -> bool {
        let mut cursor = self.decl.parent();
        while let Some(node) = cursor {
            if is_function_like(node) || node.kind() == Kind::Block {
                return false;
            }
            if node.kind() == Kind::SourceFile {
                return true;
            }
            cursor = node.parent();
        }
        false
    }
}

impl PartialEq for Binding {
    fn eq(&self, other: &Self) -> bool {
        self.ident.pos() == other.ident.pos() && self.ident.end() == other.ident.end()
    }
}

impl Eq for Binding {}

impl Hash for Binding {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.ident.pos().hash(state);
        self.ident.end().hash(state);
    }
}

#[must_use]
pub fn binding_for_declarator(decl: P<Node>) -> Option<Binding> {
    let name = decl.name()?;
    ast::is_identifier(name).then_some(Binding { decl, ident: name })
}

#[must_use]
pub fn lookup_scope_binding(scope: P<Node>, target_name: &str) -> Option<Binding> {
    if let Some(locals) = scope.locals()
        && let Some(sym) = locals.get().get(target_name)
        && let Some(decl) = sym
            .value_declaration()
            .or_else(|| sym.declarations().first().copied())
        && let Some(binding) = binding_for_declarator(decl)
    {
        return Some(binding);
    }
    if is_function_like(scope)
        && let Some(name) = scope.name()
        && ast::is_identifier(name)
        && name.as_identifier().text() == target_name
    {
        return Some(Binding {
            decl: scope,
            ident: name,
        });
    }
    None
}

#[must_use]
pub fn resolve_lexical_binding(ident: P<Node>) -> Option<Binding> {
    if !ast::is_identifier(ident) {
        return None;
    }
    let target_name = ident.as_identifier().text();
    let mut current = ident.parent();
    while let Some(scope) = current {
        if let Some(binding) = lookup_scope_binding(scope, target_name) {
            return Some(binding);
        }
        current = scope.parent();
    }
    None
}

#[must_use]
pub fn is_shadowed_import(ident: P<Node>) -> bool {
    resolve_lexical_binding(ident).is_some_and(|binding| !binding.is_import_binding())
}

#[must_use]
pub fn resolve_local_declaration(checker: &mut Checker, node: P<Node>) -> Option<P<Node>> {
    let expr = unwrap_expression(node);
    if !ast::is_identifier(expr) {
        return None;
    }
    let target_sf = ast::get_source_file_of_node(expr)?;
    let sym = symbol_at_node(checker, expr);
    symbol_declarations(checker, sym)
        .into_iter()
        .find(|&decl| ast::get_source_file_of_node(decl) == Some(target_sf))
        .or_else(|| resolve_lexical_binding(expr).map(|binding| binding.decl))
}

#[must_use]
pub fn enclosing_variable_declaration(binding: Binding) -> Option<P<Node>> {
    let mut cursor = Some(binding.decl);
    while let Some(node) = cursor {
        if node.kind() == Kind::VariableDeclaration {
            return Some(node);
        }
        if !matches!(
            node.kind(),
            Kind::BindingElement | Kind::ObjectBindingPattern | Kind::ArrayBindingPattern
        ) {
            return None;
        }
        cursor = node.parent();
    }
    None
}

fn variable_decl_list_flags(decl: P<Node>) -> Option<NodeFlags> {
    let mut cursor = Some(decl);
    while let Some(node) = cursor {
        if node.kind() == Kind::VariableDeclarationList {
            return Some(node.flags());
        }
        cursor = node.parent();
    }
    None
}

#[must_use]
pub fn is_const_variable_declaration(decl: P<Node>) -> bool {
    variable_decl_list_flags(decl).is_some_and(|flags| flags.intersects(NodeFlags::Const))
}

#[must_use]
pub fn is_let_variable_declaration(decl: P<Node>) -> bool {
    variable_decl_list_flags(decl)
        .is_some_and(|flags| (flags & NodeFlags::BlockScoped) == NodeFlags::Let)
}

#[must_use]
pub fn is_var_variable_declaration(decl: P<Node>) -> bool {
    variable_decl_list_flags(decl).is_some_and(|flags| !flags.intersects(NodeFlags::BlockScoped))
}

#[must_use]
pub fn const_binding_initializer(binding: Binding) -> Option<P<Node>> {
    if binding.decl.kind() != Kind::VariableDeclaration {
        return None;
    }
    is_const_variable_declaration(binding.decl)
        .then(|| binding.decl.as_variable_declaration().initializer())
        .flatten()
}

#[must_use]
pub fn resolve_local_initializer(
    checker: &mut Checker,
    expr: P<Node>,
    require_const: bool,
) -> Option<P<Node>> {
    let decl = resolve_local_declaration(checker, expr)?;
    if decl.kind() != Kind::VariableDeclaration {
        return None;
    }
    if require_const && !is_const_variable_declaration(decl) {
        return None;
    }
    decl.as_variable_declaration().initializer()
}

#[must_use]
pub fn resolve_binding_source_expression(checker: &mut Checker, expr: P<Node>) -> Option<P<Node>> {
    let decl = resolve_local_declaration(checker, expr)?;
    if decl.kind() != Kind::VariableDeclaration {
        return None;
    }
    if let Some(init) = decl.as_variable_declaration().initializer() {
        return Some(init);
    }
    let parent = decl.parent()?;
    if parent.kind() == Kind::VariableDeclarationList
        && let Some(grand) = parent.parent()
        && grand.kind() == Kind::ForOfStatement
    {
        return Some(grand.as_for_in_or_of_statement().expression());
    }
    None
}

#[must_use]
pub fn resolve_local_function(checker: &mut Checker, expr: P<Node>) -> Option<P<Node>> {
    let unwrapped = unwrap_expression(expr);
    if is_function_like(unwrapped) {
        return Some(unwrapped);
    }
    let decl = resolve_local_declaration(checker, unwrapped)?;
    match decl.kind() {
        Kind::FunctionDeclaration => Some(decl),
        Kind::VariableDeclaration => {
            let init = unwrap_expression(decl.as_variable_declaration().initializer()?);
            is_function_like(init).then_some(init)
        }
        _ => None,
    }
}

#[must_use]
pub fn collect_identifier_references_in_subtree(root: P<Node>, target_name: &str) -> Vec<P<Node>> {
    let mut refs = Vec::new();
    collect_refs_walk(root, target_name, &mut refs);
    refs
}

fn collect_refs_walk(node: P<Node>, target_name: &str, out: &mut Vec<P<Node>>) {
    if ast::is_identifier(node)
        && node.as_identifier().text() == target_name
        && is_identifier_reference_position(node)
    {
        out.push(node);
    }
    node.for_each_child(&mut |child| {
        collect_refs_walk(child, target_name, out);
        false
    });
}

#[must_use]
pub fn collect_binding_references(root: P<Node>, binding: Binding) -> Vec<P<Node>> {
    let mut refs = Vec::new();
    collect_binding_refs_walk(root, binding, &mut refs);
    refs
}

fn collect_binding_refs_walk(node: P<Node>, binding: Binding, out: &mut Vec<P<Node>>) {
    if ast::is_identifier(node)
        && node.as_identifier().text() == binding.name()
        && !(node.pos() == binding.ident.pos() && node.end() == binding.ident.end())
        && is_identifier_reference_position(node)
        && resolve_lexical_binding(node) == Some(binding)
    {
        out.push(node);
    }
    node.for_each_child(&mut |child| {
        collect_binding_refs_walk(child, binding, out);
        false
    });
}

#[must_use]
pub fn is_identifier_reference_position(ident: P<Node>) -> bool {
    let Some(parent) = ident.parent() else {
        return true;
    };
    match parent.kind() {
        Kind::PropertyAccessExpression => {
            parent.as_property_access_expression().expression() == ident
        }
        Kind::PropertyAssignment => parent.as_property_assignment().initializer() == ident,
        Kind::VariableDeclaration
        | Kind::Parameter
        | Kind::FunctionDeclaration
        | Kind::FunctionExpression
        | Kind::ClassDeclaration
        | Kind::InterfaceDeclaration
        | Kind::TypeAliasDeclaration
        | Kind::EnumDeclaration
        | Kind::MethodDeclaration
        | Kind::PropertyDeclaration
        | Kind::PropertySignature
        | Kind::ImportSpecifier
        | Kind::ExportSpecifier
        | Kind::ImportClause
        | Kind::NamespaceImport => parent.name() != Some(ident),
        Kind::BindingElement => {
            let binding = parent.as_binding_element();
            binding.name() != Some(ident) && binding.property_name() != Some(ident)
        }
        _ => !ast::is_type_node(parent),
    }
}

#[must_use]
pub fn is_write_reference(ident: P<Node>) -> bool {
    let mut current = ident;
    while let Some(parent) = current.parent() {
        match parent.kind() {
            Kind::ParenthesizedExpression
            | Kind::ArrayLiteralExpression
            | Kind::ObjectLiteralExpression
            | Kind::ShorthandPropertyAssignment
            | Kind::SpreadAssignment
            | Kind::SpreadElement => {
                current = parent;
            }
            Kind::PropertyAssignment => {
                if parent.as_property_assignment().initializer() != current {
                    return false;
                }
                current = parent;
            }
            Kind::BinaryExpression => {
                let bin = parent.as_binary_expression();
                if bin.left() != current
                    || !ast::is_assignment_operator(bin.operator_token().kind())
                {
                    return false;
                }
                if is_destructuring_default_parent(parent) {
                    current = parent;
                    continue;
                }
                return true;
            }
            Kind::PrefixUnaryExpression => {
                return matches!(
                    parent.as_prefix_unary_expression().operator(),
                    Kind::PlusPlusToken | Kind::MinusMinusToken
                );
            }
            Kind::PostfixUnaryExpression => {
                return matches!(
                    parent.as_postfix_unary_expression().operator(),
                    Kind::PlusPlusToken | Kind::MinusMinusToken
                );
            }
            Kind::ForInStatement | Kind::ForOfStatement => {
                return parent.as_for_in_or_of_statement().initializer() == current;
            }
            _ => return false,
        }
    }
    false
}

fn is_destructuring_default_parent(node: P<Node>) -> bool {
    node.parent().is_some_and(|grand| {
        matches!(
            grand.kind(),
            Kind::ArrayLiteralExpression | Kind::ObjectLiteralExpression | Kind::PropertyAssignment
        )
    })
}

#[must_use]
pub fn is_binding_mutated(root: P<Node>, binding: Binding) -> bool {
    collect_binding_references(root, binding)
        .into_iter()
        .any(is_write_reference)
}

#[must_use]
pub fn is_identifier_mutated_in_subtree(root: P<Node>, target_name: &str) -> bool {
    collect_identifier_references_in_subtree(root, target_name)
        .into_iter()
        .any(is_write_reference)
}
