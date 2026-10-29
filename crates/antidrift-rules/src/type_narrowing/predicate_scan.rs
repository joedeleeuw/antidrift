use antidrift_kernel::{boundary, provenance, shape, tsrs_kernel};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node, Symbol};
use tsrs_checker::{Checker, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::utils::{get_construct_signatures, is_type_flag_set, is_union_type};

pub fn unit_literal_key(typ: P<Type>) -> Option<String> {
    if is_union_type(typ) {
        return None;
    }
    if typ.is_string_literal()
        && let Some(tsrs_checker::LiteralValue::String(val)) = typ.as_literal_type().value()
    {
        return Some(format!("string:{val}"));
    }
    if typ.is_number_literal()
        && let Some(tsrs_checker::LiteralValue::Number(num)) = typ.as_literal_type().value()
    {
        return Some(format!("number:{}", num.string()));
    }
    if shape::is_true_literal_type(typ) {
        return Some("boolean:true".to_owned());
    }
    shape::is_false_literal_type(typ).then(|| "boolean:false".to_owned())
}

#[derive(Default)]
pub struct BodyScanState {
    pub(super) param_names: FxHashSet<String>,
    pub(super) alias_paths: FxHashMap<String, Vec<String>>,
    pub(super) destructured_aliases: FxHashMap<String, String>,
    pub(super) checked_props: FxHashSet<String>,
    pub(super) checked_paths: FxHashSet<String>,
    pub(super) checked_path_list: Vec<String>,
    pub(super) tag_literals: FxHashMap<String, FxHashSet<String>>,
    pub(super) tag_fields: Vec<String>,
    pub(super) proven: bool,
}

impl BodyScanState {
    pub fn new(param_name: &str) -> Self {
        let mut state = Self::default();
        state.param_names.insert(param_name.to_owned());
        state
    }

    pub fn record_path(&mut self, path: &[String]) {
        if let Some(first) = path.first() {
            self.checked_props.insert(first.clone());
            let joined = path.join(".");
            if self.checked_paths.insert(joined.clone()) {
                self.checked_path_list.push(joined);
            }
        }
    }

    pub fn path_of(&self, expr: P<Node>) -> Option<Vec<String>> {
        let unwrapped = tsrs_kernel::unwrap_expression(expr);
        if ast::is_identifier(unwrapped) {
            let name = unwrapped.as_identifier().text();
            return self
                .param_names
                .contains(name)
                .then(Vec::new)
                .or_else(|| self.alias_paths.get(name).cloned());
        }
        if let Some((target, prop_name)) = reflect_get_parts(unwrapped) {
            let mut base = self.path_of(target)?;
            base.push(prop_name.to_owned());
            return Some(base);
        }
        let (root, chain) = tsrs_kernel::static_member_chain(unwrapped)?;
        let mut base = self.path_of(root)?;
        base.extend(chain.into_iter().map(str::to_owned));
        Some(base)
    }

    pub fn has_param_root(&self, expr: P<Node>) -> bool {
        self.path_of(expr).is_some()
    }
}

fn reflect_get_parts(node: P<Node>) -> Option<(P<Node>, &'static str)> {
    if !ast::is_call_expression(node) {
        return None;
    }
    let call = node.as_call_expression();
    let callee = tsrs_kernel::unwrap_expression(call.expression());
    if !ast::is_property_access_expression(callee) {
        return None;
    }
    let prop = callee.as_property_access_expression();
    let recv = tsrs_kernel::unwrap_expression(prop.expression());
    if !ast::is_identifier(recv)
        || recv.as_identifier().text() != "Reflect"
        || tsrs_kernel::property_name_text(prop.name()) != Some("get")
    {
        return None;
    }
    let args = call.arguments().nodes();
    let key = tsrs_kernel::property_name_text(tsrs_kernel::unwrap_expression(*args.get(1)?))?;
    Some((args[0], key))
}

fn record_binding_elements(pattern: P<Node>, state: &mut BodyScanState) {
    for &elem in pattern.as_binding_pattern().elements().nodes() {
        let bind = elem.as_binding_element();
        let Some(bind_name) = bind.name() else {
            continue;
        };
        if !ast::is_identifier(bind_name) {
            continue;
        }
        let local = bind_name.as_identifier().text().to_owned();
        let prop = bind
            .property_name()
            .and_then(tsrs_kernel::property_name_text)
            .map_or_else(|| local.clone(), str::to_owned);
        state.destructured_aliases.insert(local, prop);
    }
}

fn record_variable_declaration(node: P<Node>, state: &mut BodyScanState) {
    let decl = node.as_variable_declaration();
    let name_node = decl.name();
    let Some(init) = decl.initializer() else {
        return;
    };
    if ast::is_identifier(name_node) {
        if let Some(path) = state.path_of(init) {
            let name = name_node.as_identifier().text().to_owned();
            if path.is_empty() {
                state.param_names.insert(name);
            } else {
                state.alias_paths.insert(name, path);
            }
        }
    } else if name_node.kind() == Kind::ObjectBindingPattern && state.has_param_root(init) {
        record_binding_elements(name_node, state);
    }
}

fn record_tag_comparison(
    side: P<Node>,
    other: P<Node>,
    checker: &mut Checker,
    state: &mut BodyScanState,
) {
    let Some(path) = state.path_of(side) else {
        return;
    };
    if path.len() != 1 {
        return;
    }
    let other_type = checker.get_type_at_location(other);
    let Some(lit_key) = unit_literal_key(other_type) else {
        return;
    };
    let field = path[0].clone();
    if !state.tag_literals.contains_key(&field) {
        state.tag_fields.push(field.clone());
    }
    state.tag_literals.entry(field).or_default().insert(lit_key);
}

fn apply_delegated_predicate_decl(
    decl: P<Node>,
    target_type: P<Type>,
    checker: &mut Checker,
    state: &mut BodyScanState,
) -> bool {
    let Some(ret_type) = tsrs_kernel::function_node_from_declaration(decl)
        .and_then(tsrs_kernel::function_return_type_node)
    else {
        return false;
    };
    if ret_type.kind() != Kind::TypePredicate {
        return false;
    }
    let Some(pred_target) = ret_type.as_type_predicate_node().type_() else {
        return false;
    };
    let delegated = checker.get_type_from_type_node(pred_target);
    if is_type_flag_set(delegated, TypeFlags::AnyOrUnknown) {
        return false;
    }
    if checker.is_type_assignable_to(delegated, target_type) {
        state.proven = true;
        return true;
    }
    let props = checker.get_properties_of_type(delegated);
    for &prop in props {
        state.checked_props.insert(prop.name().to_owned());
    }
    false
}

fn check_delegated_predicate_call(
    call_node: P<Node>,
    target_type: P<Type>,
    checker: &mut Checker,
    state: &mut BodyScanState,
) {
    let call = call_node.as_call_expression();
    if !call
        .arguments()
        .nodes()
        .iter()
        .any(|&a| state.has_param_root(a))
    {
        return;
    }
    if boundary::schema_validation_call_parts(call_node, checker).is_some() {
        state.proven = true;
        return;
    }
    let callee = tsrs_kernel::unwrap_expression(call.expression());
    if ast::is_property_access_expression(callee) {
        let method_node = callee.as_property_access_expression().name();
        if matches!(
            tsrs_kernel::property_name_text(method_node),
            Some("parse" | "parseAsync" | "safeParse")
        ) && boundary::is_zod_method(checker, method_node)
        {
            state.proven = true;
            return;
        }
    }
    let sym = provenance::symbol_at_node(checker, callee);
    let decls = provenance::symbol_declarations(checker, sym);
    for decl in decls {
        if apply_delegated_predicate_decl(decl, target_type, checker, state) {
            return;
        }
    }
}

fn check_has_own_probe(callee: P<Node>, args: &[P<Node>], state: &mut BodyScanState) -> bool {
    if !ast::is_property_access_expression(callee) {
        return false;
    }
    let prop = callee.as_property_access_expression();
    if !matches!(
        tsrs_kernel::property_name_text(prop.name()),
        Some("hasOwn" | "hasOwnProperty")
    ) {
        return false;
    }
    let recv = tsrs_kernel::unwrap_expression(prop.expression());
    let pair = if ast::is_identifier(recv) && recv.as_identifier().text() == "Object" {
        args.first().copied().zip(args.get(1).copied())
    } else {
        Some(recv).zip(args.first().copied())
    };
    let Some((target_arg, key_arg)) = pair else {
        return false;
    };
    let Some(mut base) = state.path_of(target_arg) else {
        return false;
    };
    let Some(key) = tsrs_kernel::property_name_text(tsrs_kernel::unwrap_expression(key_arg)) else {
        return false;
    };
    base.push(key.to_owned());
    state.record_path(&base);
    true
}

fn check_call_property_probes(call_node: P<Node>, state: &mut BodyScanState) {
    if let Some(path) = state.path_of(call_node) {
        state.record_path(&path);
        return;
    }
    let call = call_node.as_call_expression();
    let callee = tsrs_kernel::unwrap_expression(call.expression());
    let args = call.arguments().nodes();
    if check_has_own_probe(callee, args, state) {
        return;
    }
    let Some(key_node) = args
        .iter()
        .copied()
        .find(|&a| ast::is_string_literal(tsrs_kernel::unwrap_expression(a)))
    else {
        return;
    };
    let key = tsrs_kernel::unwrap_expression(key_node)
        .as_string_literal()
        .text()
        .to_owned();
    for &arg in args {
        if arg != key_node
            && arg.kind() != Kind::SpreadElement
            && let Some(mut base) = state.path_of(arg)
        {
            base.push(key);
            state.record_path(&base);
            return;
        }
    }
}

fn prop_matches_brand(prop: P<Symbol>, brand_sym: P<Symbol>, checker: &mut Checker) -> bool {
    for &decl in prop.declarations() {
        if let Some(name) = decl.name()
            && name.kind() == Kind::ComputedPropertyName
        {
            let expr = name.as_computed_property_name().expression();
            if provenance::symbol_at_node(checker, expr) == Some(brand_sym) {
                return true;
            }
        }
    }
    false
}

fn check_nominal_brand_in(
    left: P<Node>,
    right: P<Node>,
    target_type: P<Type>,
    checker: &mut Checker,
    state: &BodyScanState,
) -> bool {
    if is_union_type(target_type) || state.path_of(right).as_deref() != Some(&[]) {
        return false;
    }
    let Some(brand_sym) = provenance::symbol_at_node(checker, left) else {
        return false;
    };
    let props = checker.get_properties_of_type(target_type);
    props
        .iter()
        .copied()
        .any(|prop| prop_matches_brand(prop, brand_sym, checker))
}

fn matches_instanceof_target(right: P<Node>, target_type: P<Type>, checker: &mut Checker) -> bool {
    let ctor = checker.get_type_at_location(right);
    let sigs = get_construct_signatures(checker, ctor);
    for &sig in sigs {
        let ret = checker.get_return_type_of_signature(sig);
        if checker.is_type_assignable_to(ret, target_type) {
            return true;
        }
    }
    false
}

fn visit_binary_in_body(
    node: P<Node>,
    target_type: P<Type>,
    checker: &mut Checker,
    state: &mut BodyScanState,
) {
    let bin = node.as_binary_expression();
    let (left, right) = (bin.left(), bin.right());
    match bin.operator_token().kind() {
        Kind::InKeyword => {
            if check_nominal_brand_in(left, right, target_type, checker, state) {
                state.proven = true;
            } else if let Some(mut base) = state.path_of(right)
                && let Some(key) =
                    tsrs_kernel::property_name_text(tsrs_kernel::unwrap_expression(left))
            {
                base.push(key.to_owned());
                state.record_path(&base);
            }
        }
        Kind::InstanceOfKeyword => {
            if state.path_of(left).as_deref() == Some(&[])
                && matches_instanceof_target(right, target_type, checker)
            {
                state.proven = true;
            }
        }
        Kind::EqualsEqualsEqualsToken
        | Kind::EqualsEqualsToken
        | Kind::ExclamationEqualsEqualsToken
        | Kind::ExclamationEqualsToken => {
            record_tag_comparison(left, right, checker, state);
            record_tag_comparison(right, left, checker, state);
        }
        _ => {}
    }
}

fn visit_switch_in_body(node: P<Node>, checker: &mut Checker, state: &mut BodyScanState) {
    let sw = node.as_switch_statement();
    let disc = sw.expression();
    for &clause in sw.case_block().as_case_block().clauses().nodes() {
        if clause.kind() == Kind::CaseClause
            && let Some(test) = clause.as_case_or_default_clause().expression()
        {
            record_tag_comparison(disc, test, checker, state);
        }
    }
}

pub fn scan_body_node(
    node: P<Node>,
    target_type: P<Type>,
    checker: &mut Checker,
    state: &mut BodyScanState,
) {
    if state.proven {
        return;
    }
    match node.kind() {
        Kind::VariableDeclaration => record_variable_declaration(node, state),
        Kind::BinaryExpression => visit_binary_in_body(node, target_type, checker, state),
        Kind::SwitchStatement => visit_switch_in_body(node, checker, state),
        Kind::CallExpression => {
            check_delegated_predicate_call(node, target_type, checker, state);
            check_call_property_probes(node, state);
        }
        Kind::PropertyAccessExpression | Kind::ElementAccessExpression => {
            if let Some(path) = state.path_of(node) {
                state.record_path(&path);
            }
        }
        Kind::Identifier => {
            if let Some(prop) = state.destructured_aliases.get(node.as_identifier().text())
                && !node.parent().is_some_and(|p| {
                    matches!(p.kind(), Kind::BindingElement | Kind::VariableDeclaration)
                        && p.name() == Some(node)
                })
            {
                state.checked_props.insert(prop.clone());
            }
        }
        _ => {}
    }
    node.for_each_child(&mut |child| {
        scan_body_node(child, target_type, checker, state);
        false
    });
}
