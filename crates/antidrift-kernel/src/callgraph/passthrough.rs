use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node, SourceFile, Symbol};
use tsrs_checker::Checker;
use tsrs_core::P;

use crate::tsrs_kernel;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PassThroughParam {
    pub name_node: P<Node>,
    pub name: String,
    pub targets: Vec<String>,
}

fn outer_expression(node: P<Node>) -> P<Node> {
    let mut current = node;
    while let Some(parent) = current.parent() {
        match parent.kind() {
            Kind::AsExpression
            | Kind::NonNullExpression
            | Kind::SatisfiesExpression
            | Kind::ParenthesizedExpression => {
                current = parent;
            }
            _ => return current,
        }
    }
    current
}

fn is_call_argument(node: P<Node>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    match parent.kind() {
        Kind::CallExpression => parent
            .as_call_expression()
            .arguments()
            .nodes()
            .contains(&node),
        Kind::NewExpression => parent
            .as_new_expression()
            .arguments()
            .is_some_and(|args| args.nodes().contains(&node)),
        _ => false,
    }
}

fn is_inline_options_literal(obj: Option<P<Node>>) -> bool {
    let Some(start) = obj else {
        return false;
    };
    let mut current = outer_expression(start);
    while let Some(parent) = current.parent()
        && ast::is_property_assignment(parent)
        && let Some(grandparent) = parent.parent()
        && ast::is_object_literal_expression(grandparent)
    {
        current = outer_expression(grandparent);
    }
    let Some(parent) = current.parent() else {
        return false;
    };
    is_call_argument(current) || parent.kind() == Kind::JsxExpression
}

#[must_use]
pub fn is_named_function_node(node: P<Node>) -> bool {
    if node.kind() == Kind::FunctionDeclaration {
        return true;
    }
    let Some(parent) = node.parent() else {
        return false;
    };
    match parent.kind() {
        Kind::ExportAssignment
        | Kind::MethodDeclaration
        | Kind::PropertyDeclaration
        | Kind::VariableDeclaration => true,
        Kind::PropertyAssignment => {
            let prop_assign = parent.as_property_assignment();
            prop_assign.initializer() == node && !is_inline_options_literal(parent.parent())
        }
        _ => false,
    }
}

fn root_callee_expr(node: P<Node>) -> P<Node> {
    let mut current = node;
    while ast::is_property_access_expression(current) {
        current = current.as_property_access_expression().expression();
    }
    current
}

fn is_first_party_specifier(spec: &str) -> bool {
    spec.starts_with("./")
        || spec.starts_with("../")
        || spec.starts_with("@/")
        || spec.starts_with("~/")
        || spec.starts_with("#/")
}

fn is_callable_expression_kind(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::ArrowFunction | Kind::FunctionExpression | Kind::ClassExpression
    )
}

fn defines_callable(init: Option<P<Node>>) -> bool {
    let Some(init_node) = init else {
        return false;
    };
    let unwrapped = tsrs_kernel::unwrap_expression(init_node);
    if is_callable_expression_kind(unwrapped.kind()) {
        return true;
    }
    if unwrapped.kind() == Kind::CallExpression
        && let Some(&first_arg) = unwrapped.as_call_expression().arguments().nodes().first()
    {
        let arg0 = tsrs_kernel::unwrap_expression(first_arg);
        return is_callable_expression_kind(arg0.kind());
    }
    false
}

fn is_imported_first_party_declaration(decl: P<Node>, callee: P<Node>, root: P<Node>) -> bool {
    let mut cur = Some(decl);
    let mut import_decl = None;
    while let Some(node) = cur {
        if ast::is_import_declaration(node) {
            import_decl = Some(node);
            break;
        }
        cur = node.parent();
    }
    let Some(import_node) = import_decl else {
        return false;
    };
    let spec_node = import_node.as_import_declaration().module_specifier();
    if !ast::is_string_literal(spec_node) {
        return false;
    }
    is_first_party_specifier(spec_node.as_string_literal().text())
        && (callee == root || decl.kind() == Kind::NamespaceImport)
}

fn is_first_party_layer_callee(callee: P<Node>, checker: &mut Checker) -> bool {
    let root = root_callee_expr(callee);
    if root.kind() == Kind::ThisKeyword {
        return ast::is_property_access_expression(callee)
            && callee.as_property_access_expression().expression() == root;
    }
    if !ast::is_identifier(root)
        && !matches!(
            root.kind(),
            Kind::JsxOpeningElement | Kind::JsxSelfClosingElement
        )
    {
        return false;
    }
    let Some(sym) = checker.get_symbol_at_location_exported(root) else {
        return false;
    };
    let Some(&decl) = sym.declarations().first() else {
        return false;
    };
    match decl.kind() {
        Kind::ImportSpecifier | Kind::ImportClause | Kind::NamespaceImport => {
            is_imported_first_party_declaration(decl, callee, root)
        }
        Kind::FunctionDeclaration | Kind::ClassDeclaration => callee == root,
        Kind::VariableDeclaration => {
            callee == root && defines_callable(decl.as_variable_declaration().initializer())
        }
        _ => false,
    }
}

fn is_delegated_call_parent(node: P<Node>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    match parent.kind() {
        Kind::ExpressionStatement | Kind::ReturnStatement => true,
        Kind::ArrowFunction => parent.body() == Some(node),
        _ => false,
    }
}

fn is_delegated_result_call(call: P<Node>) -> bool {
    let mut node = outer_expression(call);
    while let Some(parent) = node.parent() {
        match parent.kind() {
            Kind::AwaitExpression | Kind::VoidExpression | Kind::NonNullExpression => {
                node = outer_expression(parent);
            }
            _ => return is_delegated_call_parent(node),
        }
    }
    is_delegated_call_parent(node)
}

fn forwarding_call_for_identifier(node: P<Node>) -> Option<P<Node>> {
    let parent = node.parent()?;
    if is_call_argument(node) {
        return Some(parent);
    }
    if ast::is_spread_element(parent) && is_call_argument(parent) {
        return parent.parent();
    }
    if (ast::is_spread_assignment(parent) || ast::is_shorthand_property_assignment(parent))
        && let Some(grandparent) = parent.parent()
        && ast::is_object_literal_expression(grandparent)
        && is_call_argument(grandparent)
    {
        return grandparent.parent();
    }
    None
}

fn forwarding_jsx_tag_name_for_identifier(node: P<Node>) -> Option<P<Node>> {
    let parent = node.parent()?;
    let jsx_attrs = match parent.kind() {
        Kind::JsxExpression => {
            let grandparent = parent.parent()?;
            (grandparent.kind() == Kind::JsxAttribute)
                .then(|| grandparent.parent())
                .flatten()
        }
        Kind::JsxSpreadAttribute => parent.parent(),
        _ => None,
    }?;
    let elem = jsx_attrs.parent()?;
    matches!(
        elem.kind(),
        Kind::JsxOpeningElement | Kind::JsxSelfClosingElement
    )
    .then(|| elem.tag_name())
}

fn is_expression_statement_call(call: P<Node>) -> bool {
    let mut node = outer_expression(call);
    while let Some(parent) = node.parent() {
        match parent.kind() {
            Kind::AwaitExpression | Kind::VoidExpression | Kind::NonNullExpression => {
                node = outer_expression(parent);
            }
            Kind::ExpressionStatement => return true,
            _ => return false,
        }
    }
    false
}

fn call_joins_local_variable(call: P<Node>, param_ident: P<Node>, checker: &mut Checker) -> bool {
    if !ast::is_call_expression(call) || !is_expression_statement_call(call) {
        return false;
    }
    let Some(enclosing_fn) = tsrs_kernel::enclosing_function(call) else {
        return false;
    };
    for &arg in call.as_call_expression().arguments().nodes() {
        let unwrapped = tsrs_kernel::unwrap_expression(arg);
        if unwrapped == param_ident || !ast::is_identifier(unwrapped) {
            continue;
        }
        let Some(sym) = checker.get_symbol_at_location_exported(unwrapped) else {
            continue;
        };
        if sym.declarations().iter().copied().any(|decl| {
            decl.kind() == Kind::VariableDeclaration
                && tsrs_kernel::enclosing_function(decl) == Some(enclosing_fn)
        }) {
            return true;
        }
    }
    false
}

fn forward_target_for_identifier(
    ident: P<Node>,
    sf: P<SourceFile>,
    checker: &mut Checker,
) -> Option<String> {
    let node = outer_expression(ident);
    if let Some(call) = forwarding_call_for_identifier(node) {
        if call_joins_local_variable(call, node, checker) {
            return None;
        }
        let callee = if ast::is_call_expression(call) {
            Some(call.as_call_expression().expression())
        } else if ast::is_new_expression(call) {
            Some(call.as_new_expression().expression())
        } else {
            None
        }?;
        if is_delegated_result_call(call) && is_first_party_layer_callee(callee, checker) {
            let text = tsrs_kernel::node_text(sf, callee).trim();
            return (!text.is_empty()).then(|| text.to_owned());
        }
        return None;
    }
    let tag_name = forwarding_jsx_tag_name_for_identifier(node)?;
    if is_first_party_layer_callee(tag_name, checker) {
        let text = tsrs_kernel::node_text(sf, tag_name).trim();
        return (!text.is_empty()).then(|| text.to_owned());
    }
    None
}

fn is_write_reference(ident: P<Node>) -> bool {
    let Some(parent) = ident.parent() else {
        return false;
    };
    if ast::is_binary_expression(parent) {
        let bin = parent.as_binary_expression();
        return bin.left() == ident && ast::is_assignment_operator(bin.operator_token().kind());
    }
    if ast::is_prefix_unary_expression(parent) {
        let op = parent.as_prefix_unary_expression().operator();
        return matches!(op, Kind::PlusPlusToken | Kind::MinusMinusToken);
    }
    if ast::is_postfix_unary_expression(parent) {
        let op = parent.as_postfix_unary_expression().operator();
        return matches!(op, Kind::PlusPlusToken | Kind::MinusMinusToken);
    }
    false
}

fn is_type_position_identifier(ident: P<Node>) -> bool {
    let mut cur = ident.parent();
    while let Some(node) = cur {
        if ast::is_type_node(node) {
            return true;
        }
        if tsrs_kernel::is_function_like(node) || ast::is_block(node) {
            return false;
        }
        cur = node.parent();
    }
    false
}

fn collect_param_identifiers(param_node: P<Node>, out: &mut Vec<P<Node>>) {
    let Some(name_node) = param_node.name() else {
        return;
    };
    if ast::is_identifier(name_node) {
        out.push(name_node);
        return;
    }
    if matches!(
        name_node.kind(),
        Kind::ObjectBindingPattern | Kind::ArrayBindingPattern
    ) {
        for &elem in name_node.as_binding_pattern().elements().nodes() {
            collect_param_identifiers(elem, out);
        }
    }
}

fn resolve_identifier_symbol(node: P<Node>, checker: &mut Checker) -> Option<P<Symbol>> {
    let sym = checker.get_symbol_at_location_exported(node)?;
    if let Some(parent) = node.parent()
        && ast::is_shorthand_property_assignment(parent)
        && parent.name() == Some(node)
        && let Some(val_sym) = checker.get_shorthand_assignment_value_symbol(Some(parent))
    {
        return Some(val_sym);
    }
    Some(sym)
}

fn collect_body_param_refs(
    node: P<Node>,
    checker: &mut Checker,
    sym_to_ident: &FxHashMap<P<Symbol>, P<Node>>,
    sym_refs: &mut FxHashMap<P<Symbol>, Vec<P<Node>>>,
) {
    if ast::is_identifier(node)
        && !is_type_position_identifier(node)
        && let Some(sym) = resolve_identifier_symbol(node, checker)
        && let Some(&def_ident) = sym_to_ident.get(&sym)
        && node != def_ident
    {
        sym_refs.entry(sym).or_default().push(node);
    }
    node.for_each_child(&mut |child| {
        collect_body_param_refs(child, checker, sym_to_ident, sym_refs);
        false
    });
}

fn evaluate_param_pass_through(
    def_ident: P<Node>,
    refs: &[P<Node>],
    sf: P<SourceFile>,
    checker: &mut Checker,
) -> Option<PassThroughParam> {
    if refs.is_empty() {
        return None;
    }
    let mut targets = Vec::new();
    let mut seen_targets = FxHashSet::default();
    for &ref_node in refs {
        if is_write_reference(ref_node) {
            return None;
        }
        let target = forward_target_for_identifier(ref_node, sf, checker)?;
        let quoted = format!("'{target}'");
        if seen_targets.insert(target) {
            targets.push(quoted);
        }
    }
    if targets.is_empty() {
        return None;
    }
    Some(PassThroughParam {
        name_node: def_ident,
        name: def_ident.as_identifier().text().to_owned(),
        targets,
    })
}

fn collect_param_init_refs(
    param_node: P<Node>,
    checker: &mut Checker,
    sym_to_ident: &FxHashMap<P<Symbol>, P<Node>>,
    sym_refs: &mut FxHashMap<P<Symbol>, Vec<P<Node>>>,
) {
    let init = match param_node.kind() {
        Kind::Parameter => param_node.as_parameter_declaration().initializer(),
        Kind::BindingElement => param_node.as_binding_element().initializer(),
        _ => None,
    };
    if let Some(init_node) = init {
        collect_body_param_refs(init_node, checker, sym_to_ident, sym_refs);
    }
    if let Some(name_node) = param_node.name()
        && matches!(
            name_node.kind(),
            Kind::ObjectBindingPattern | Kind::ArrayBindingPattern
        )
    {
        for &elem in name_node.as_binding_pattern().elements().nodes() {
            collect_param_init_refs(elem, checker, sym_to_ident, sym_refs);
        }
    }
}

pub fn find_pass_through_parameters(
    fn_node: P<Node>,
    sf: P<SourceFile>,
    checker: &mut Checker,
) -> Vec<PassThroughParam> {
    let Some(body) = fn_node.body() else {
        return Vec::new();
    };
    if !is_named_function_node(fn_node) {
        return Vec::new();
    }
    if tsrs_kernel::function_return_type_node(fn_node)
        .is_some_and(|ret| ret.kind() == Kind::TypePredicate)
    {
        return Vec::new();
    }
    let mut param_idents = Vec::new();
    for &param in fn_node.parameters() {
        collect_param_identifiers(param, &mut param_idents);
    }
    if param_idents.is_empty() {
        return Vec::new();
    }
    let mut sym_to_ident = FxHashMap::default();
    let mut sym_refs = FxHashMap::default();
    for &ident in &param_idents {
        if let Some(sym) = checker.get_symbol_at_location_exported(ident) {
            sym_to_ident.insert(sym, ident);
        }
    }
    for &param in fn_node.parameters() {
        collect_param_init_refs(param, checker, &sym_to_ident, &mut sym_refs);
    }
    collect_body_param_refs(body, checker, &sym_to_ident, &mut sym_refs);

    let mut matched_params = Vec::new();
    for def_ident in param_idents {
        if let Some(sym) = checker.get_symbol_at_location_exported(def_ident)
            && let Some(refs) = sym_refs.get(&sym)
            && let Some(param) = evaluate_param_pass_through(def_ident, refs, sf, checker)
        {
            matched_params.push(param);
        }
    }
    matched_params
}
