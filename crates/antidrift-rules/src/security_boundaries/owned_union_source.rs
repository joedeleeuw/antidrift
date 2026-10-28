use antidrift_kernel::local_binding::{
    Binding, is_const_variable_declaration, lookup_scope_binding, resolve_lexical_binding,
};
use antidrift_kernel::tsrs_kernel::is_const_assertion;
use rustc_hash::FxHashSet;
use std::collections::{BTreeMap, BTreeSet};
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum OwnedLiteral {
    Text(String),
    Number(u64),
}

pub(super) type MemberSet = BTreeSet<OwnedLiteral>;

#[derive(Clone)]
pub(super) struct ExportedArray {
    pub(super) name: String,
    pub(super) local: String,
    pub(super) members: MemberSet,
}

pub(super) fn literal_expression(expression: P<Node>) -> Option<OwnedLiteral> {
    match expression.kind() {
        Kind::StringLiteral => Some(OwnedLiteral::Text(
            expression.as_string_literal().text().to_string(),
        )),
        Kind::NumericLiteral => numeric_value(expression).map(number_literal),
        Kind::PrefixUnaryExpression => {
            let unary = expression.as_prefix_unary_expression();
            if unary.operator() != Kind::MinusToken {
                return None;
            }
            numeric_value(unary.operand()).map(|val| number_literal(-val))
        }
        _ => None,
    }
}

fn numeric_value(node: P<Node>) -> Option<f64> {
    if node.kind() != Kind::NumericLiteral {
        return None;
    }
    let Ok(value) = node.text().replace('_', "").parse::<f64>() else {
        return None;
    };
    Some(value)
}

fn number_literal(number: f64) -> OwnedLiteral {
    OwnedLiteral::Number(if number == 0.0 { 0 } else { number.to_bits() })
}

pub(super) fn literal_type(annotation: P<Node>) -> Option<OwnedLiteral> {
    if annotation.kind() != Kind::LiteralType {
        return None;
    }
    literal_expression(annotation.as_literal_type_node().literal())
}

fn array_members(initializer: P<Node>) -> Option<MemberSet> {
    let mut expression = initializer;
    loop {
        expression = match expression.kind() {
            Kind::ParenthesizedExpression => expression.as_parenthesized_expression().expression(),
            Kind::SatisfiesExpression => expression.as_satisfies_expression().expression(),
            _ => break,
        };
    }
    if expression.kind() != Kind::AsExpression {
        return None;
    }
    let assertion = expression.as_as_expression();
    if !is_const_assertion(assertion.type_()) {
        return None;
    }
    let inner = assertion.expression();
    if inner.kind() != Kind::ArrayLiteralExpression {
        return None;
    }
    let elements = inner.as_array_literal_expression().elements().nodes();
    if elements.is_empty() {
        return None;
    }
    elements
        .iter()
        .map(|&element| {
            if matches!(
                element.kind(),
                Kind::SpreadElement | Kind::OmittedExpression
            ) {
                return None;
            }
            literal_expression(element)
        })
        .collect()
}

pub(super) fn exported_arrays(sf: P<SourceFile>) -> Vec<ExportedArray> {
    let mut bindings = BTreeMap::new();
    let mut exports = Vec::new();
    for &statement in sf.statements().nodes() {
        match statement.kind() {
            Kind::VariableStatement => {
                let exported = has_export_modifier(statement);
                collect_bindings(
                    statement.as_variable_statement().declaration_list(),
                    exported,
                    &mut bindings,
                    &mut exports,
                );
            }
            Kind::ExportDeclaration => {
                collect_export_declaration(statement, &mut exports);
            }
            Kind::ExportAssignment => {
                let expr = statement.as_export_assignment().expression();
                if ast::is_identifier(expr) {
                    record_export(&mut exports, "default", expr.as_identifier().text());
                }
            }
            _ => {}
        }
    }
    exports
        .into_iter()
        .filter_map(|(name, local)| {
            Some(ExportedArray {
                name,
                members: bindings.get(&local)?.clone(),
                local,
            })
        })
        .collect()
}

fn has_export_modifier(node: P<Node>) -> bool {
    node.modifiers()
        .is_some_and(|mods| mods.nodes().iter().any(|m| m.kind() == Kind::ExportKeyword))
}

fn collect_export_declaration(statement: P<Node>, exports: &mut Vec<(String, String)>) {
    let export = statement.as_export_declaration();
    if export.is_type_only() || export.module_specifier().is_some() {
        return;
    }
    let Some(clause) = export.export_clause() else {
        return;
    };
    if clause.kind() != Kind::NamedExports {
        return;
    }
    for &spec in clause.as_named_exports().elements().nodes() {
        if spec.kind() != Kind::ExportSpecifier {
            continue;
        }
        let es = spec.as_export_specifier();
        if es.is_type_only() {
            continue;
        }
        let exported_node = es.name();
        let local_node = es.property_name().unwrap_or(exported_node);
        let Some(exported_name) = module_export_name(exported_node) else {
            continue;
        };
        let Some(local_name) = module_export_name(local_node) else {
            continue;
        };
        record_export(exports, exported_name, local_name);
    }
}

fn module_export_name(node: P<Node>) -> Option<&'static str> {
    match node.kind() {
        Kind::Identifier => Some(node.as_identifier().text()),
        Kind::StringLiteral => Some(node.as_string_literal().text()),
        _ => None,
    }
}

fn collect_bindings(
    declaration_list: P<Node>,
    exported: bool,
    bindings: &mut BTreeMap<String, MemberSet>,
    exports: &mut Vec<(String, String)>,
) {
    for &decl in declaration_list
        .as_variable_declaration_list()
        .declarations()
        .nodes()
    {
        if !is_const_variable_declaration(decl) {
            continue;
        }
        let Some(name_node) = decl.name() else {
            continue;
        };
        if !ast::is_identifier(name_node) {
            continue;
        }
        let Some(members) = decl
            .as_variable_declaration()
            .initializer()
            .and_then(array_members)
        else {
            continue;
        };
        let name = name_node.as_identifier().text();
        bindings.insert(name.to_string(), members);
        if exported {
            record_export(exports, name, name);
        }
    }
}

fn record_export(exports: &mut Vec<(String, String)>, name: &str, local: &str) {
    if let Some((_, binding)) = exports.iter_mut().find(|(export, _)| export == name) {
        local.clone_into(binding);
    } else {
        exports.push((name.to_string(), local.to_string()));
    }
}

pub(super) fn is_shadowed_at(node: P<Node>, name: &str, root_binding: Binding) -> bool {
    let mut cursor = Some(node);
    while let Some(current) = cursor {
        if current.kind() == Kind::SourceFile {
            break;
        }
        if let Some(found) = lookup_scope_binding(current, name) {
            return found != root_binding;
        }
        cursor = current.parent();
    }
    false
}

pub(super) fn find_top_level_binding(sf: P<SourceFile>, target_name: &str) -> Option<Binding> {
    lookup_scope_binding(sf.as_node(), target_name)
}

pub(super) fn convex_bindings(sf: P<SourceFile>) -> FxHashSet<Binding> {
    let mut bindings = FxHashSet::default();
    for &statement in sf.statements().nodes() {
        if statement.kind() != Kind::ImportDeclaration {
            continue;
        }
        let import = statement.as_import_declaration();
        let spec = import.module_specifier();
        if !ast::is_string_literal(spec) || spec.as_string_literal().text() != "convex/values" {
            continue;
        }
        let Some(clause_node) = import.import_clause() else {
            continue;
        };
        let clause = clause_node.as_import_clause();
        if clause.phase_modifier() == Kind::TypeKeyword {
            continue;
        }
        let Some(named) = clause.named_bindings() else {
            continue;
        };
        if named.kind() != Kind::NamedImports {
            continue;
        }
        for &elem in named.as_named_imports().elements().nodes() {
            if elem.kind() != Kind::ImportSpecifier {
                continue;
            }
            let spec_decl = elem.as_import_specifier();
            if spec_decl.is_type_only() {
                continue;
            }
            let local_node = spec_decl.name();
            if !ast::is_identifier(local_node) {
                continue;
            }
            let imported = spec_decl.property_name().unwrap_or(local_node);
            if ast::is_identifier(imported) && imported.as_identifier().text() == "v" {
                bindings.insert(Binding {
                    decl: elem,
                    ident: local_node,
                });
            }
        }
    }
    bindings
}

fn convex_method(
    call_node: P<Node>,
    method: &str,
    bindings: &FxHashSet<Binding>,
) -> Option<Binding> {
    let callee = call_node.as_call_expression().expression();
    if callee.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = callee.as_property_access_expression();
    let prop = access.name();
    if !ast::is_identifier(prop) || prop.as_identifier().text() != method {
        return None;
    }
    let obj = access.expression();
    if !ast::is_identifier(obj) {
        return None;
    }
    let symbol = resolve_lexical_binding(obj)?;
    bindings.contains(&symbol).then_some(symbol)
}

pub(super) fn validator_members(
    call_node: P<Node>,
    bindings: &FxHashSet<Binding>,
) -> Option<MemberSet> {
    let receiver = convex_method(call_node, "union", bindings)?;
    let args = call_node.as_call_expression().arguments().nodes();
    if args.len() < 2 {
        return None;
    }
    args.iter()
        .map(|&argument| {
            if argument.kind() != Kind::CallExpression {
                return None;
            }
            let lit_args = argument.as_call_expression().arguments().nodes();
            if lit_args.len() != 1
                || lit_args[0].kind() == Kind::SpreadElement
                || convex_method(argument, "literal", bindings) != Some(receiver)
            {
                return None;
            }
            literal_expression(lit_args[0])
        })
        .collect()
}

pub(super) fn call_site(node: P<Node>) -> Option<String> {
    let mut segments = Vec::new();
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        match ancestor.kind() {
            Kind::PropertyAssignment => {
                let prop = ancestor.as_property_assignment().name();
                let name = match prop.kind() {
                    Kind::Identifier => Some(prop.as_identifier().text()),
                    Kind::StringLiteral => Some(prop.as_string_literal().text()),
                    _ => None,
                }?;
                segments.push(name.to_string());
            }
            Kind::VariableDeclaration => {
                if let Some(name_node) = ancestor.name()
                    && ast::is_identifier(name_node)
                {
                    segments.push(name_node.as_identifier().text().to_string());
                    segments.reverse();
                    return Some(segments.join("."));
                }
            }
            Kind::FunctionDeclaration
            | Kind::FunctionExpression
            | Kind::ArrowFunction
            | Kind::MethodDeclaration => break,
            _ => {}
        }
        cursor = ancestor.parent();
    }
    None
}
