use super::no_handrolled_resource_lifecycle_cells::{StateFrame, WriteClass};
use antidrift_kernel::imports::FileImports;
use antidrift_kernel::jsx::{is_component_or_hook_function, is_hook_name};
use antidrift_kernel::tsrs_kernel::{is_function_like, unwrap_expression};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::{P, TextPos};

pub(super) struct AbortGuard {
    pub(super) block: P<Node>,
    pub(super) start: Option<TextPos>,
    pub(super) end: TextPos,
}

const EFFECT_HOOKS: &[&str] = &["useEffect", "useLayoutEffect"];
pub(super) const SHADOW_STATE_MIRROR_MESSAGE: &str = "This state cell copies a prop or hook result and is only re-synced from an effect, so it renders one frame stale. Derive the value during render, or key the component to reset it.";

pub(super) fn shadow_state_mirrors(sf: P<SourceFile>, imports: &FileImports) -> Vec<P<Node>> {
    let mut reports = Vec::new();
    collect_components(sf.as_node(), imports, &mut reports);
    reports
}

fn collect_components(node: P<Node>, imports: &FileImports, reports: &mut Vec<P<Node>>) {
    if is_function_like(node) && is_component_or_hook_function(node) {
        check_component(node, imports, reports);
    }
    node.for_each_child(&mut |child| {
        collect_components(child, imports, reports);
        false
    });
}

fn binding_identifiers(name: P<Node>, out: &mut FxHashSet<&'static str>) {
    if ast::is_identifier(name) {
        out.insert(name.as_identifier().text());
        return;
    }
    if name.kind() != Kind::ObjectBindingPattern {
        return;
    }
    for &element in name.as_binding_pattern().elements().nodes() {
        if let Some(inner) = element.as_binding_element().name() {
            binding_identifiers(inner, out);
        }
    }
}

struct ComponentScope {
    params: FxHashSet<&'static str>,
    hook_results: FxHashSet<&'static str>,
}

fn is_prop_or_hook_derived(initial: P<Node>, scope: &ComponentScope) -> bool {
    let inner = unwrap_expression(initial);
    if ast::is_identifier(inner) {
        return scope.params.contains(inner.as_identifier().text());
    }
    if inner.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let access = inner.as_property_access_expression();
    let prop = access.name();
    if ast::is_identifier(prop) {
        let prop_text = prop.as_identifier().text();
        if prop_text.starts_with("get")
            && prop_text
                .as_bytes()
                .get(3)
                .is_some_and(u8::is_ascii_uppercase)
        {
            return false;
        }
    }
    let root = unwrap_expression(access.expression());
    ast::is_identifier(root) && {
        let root_name = root.as_identifier().text();
        scope.params.contains(root_name) || scope.hook_results.contains(root_name)
    }
}

fn same_mirror_source(left: P<Node>, right: P<Node>) -> bool {
    let l = unwrap_expression(left);
    let r = unwrap_expression(right);
    if l.kind() != r.kind() {
        return false;
    }
    match l.kind() {
        Kind::Identifier => l.as_identifier().text() == r.as_identifier().text(),
        Kind::PropertyAccessExpression => {
            let la = l.as_property_access_expression();
            let ra = r.as_property_access_expression();
            ast::is_identifier(la.name())
                && ast::is_identifier(ra.name())
                && la.name().as_identifier().text() == ra.name().as_identifier().text()
                && same_mirror_source(la.expression(), ra.expression())
        }
        _ => false,
    }
}

fn hook_call_name(init: P<Node>) -> Option<&'static str> {
    let inner = unwrap_expression(init);
    if inner.kind() != Kind::CallExpression {
        return None;
    }
    let callee = unwrap_expression(inner.as_call_expression().expression());
    let name = match callee.kind() {
        Kind::Identifier => callee.as_identifier().text(),
        Kind::PropertyAccessExpression => {
            let prop = callee.as_property_access_expression().name();
            ast::is_identifier(prop).then(|| prop.as_identifier().text())?
        }
        _ => return None,
    };
    is_hook_name(name).then_some(name)
}

fn state_pair_setter(decl: P<Node>, imports: &FileImports) -> Option<(P<Node>, P<Node>)> {
    let var_decl = decl.as_variable_declaration();
    let pattern = var_decl.name();
    let init = unwrap_expression(var_decl.initializer()?);
    if pattern.kind() != Kind::ArrayBindingPattern || init.kind() != Kind::CallExpression {
        return None;
    }
    let call = init.as_call_expression();
    if !imports.is_unshadowed_call(call.expression(), "react", &["useState"]) {
        return None;
    }
    let setter_element = *pattern.as_binding_pattern().elements().nodes().get(1)?;
    let setter = (setter_element.kind() == Kind::BindingElement)
        .then(|| setter_element.as_binding_element().name())
        .flatten()
        .filter(|name| ast::is_identifier(*name))?;
    Some((init, setter))
}

fn is_effect_callback(func: P<Node>, imports: &FileImports) -> bool {
    func.parent().is_some_and(|parent| {
        parent.kind() == Kind::CallExpression
            && parent.as_call_expression().arguments().nodes().first() == Some(&func)
            && imports.is_unshadowed_call(
                parent.as_call_expression().expression(),
                "react",
                EFFECT_HOOKS,
            )
    })
}

fn is_inside_effect(reference: P<Node>, component: P<Node>, imports: &FileImports) -> bool {
    let mut cursor = reference.parent();
    while let Some(ancestor) = cursor {
        if ancestor == component {
            return false;
        }
        if is_function_like(ancestor) {
            return is_effect_callback(ancestor, imports);
        }
        cursor = ancestor.parent();
    }
    false
}

fn collect_references(node: P<Node>, name: &str, skip: P<Node>, out: &mut Vec<P<Node>>) {
    if node != skip && ast::is_identifier(node) && node.as_identifier().text() == name {
        out.push(node);
    }
    node.for_each_child(&mut |child| {
        collect_references(child, name, skip, out);
        false
    });
}

fn is_effect_only_mirror(
    component: P<Node>,
    body: P<Node>,
    setter: P<Node>,
    initial: P<Node>,
    imports: &FileImports,
) -> bool {
    let mut references = Vec::new();
    collect_references(body, setter.as_identifier().text(), setter, &mut references);
    let mut effect_calls = 0usize;
    for reference in references {
        if !is_inside_effect(reference, component, imports) {
            return false;
        }
        let Some(parent) = reference.parent() else {
            return false;
        };
        if parent.kind() != Kind::CallExpression
            || parent.as_call_expression().expression() != reference
        {
            return false;
        }
        let Some(&arg) = parent.as_call_expression().arguments().nodes().first() else {
            return false;
        };
        if !same_mirror_source(arg, initial) {
            return false;
        }
        effect_calls += 1;
    }
    effect_calls >= 1
}

fn check_component(component: P<Node>, imports: &FileImports, reports: &mut Vec<P<Node>>) {
    let Some(body) = component.body().filter(|body| body.kind() == Kind::Block) else {
        return;
    };
    let mut scope = ComponentScope {
        params: FxHashSet::default(),
        hook_results: FxHashSet::default(),
    };
    for &param in component.parameters() {
        binding_identifiers(param.as_parameter_declaration().name(), &mut scope.params);
    }
    for &stmt in body.as_block().statements().nodes() {
        if stmt.kind() != Kind::VariableStatement {
            continue;
        }
        let list = stmt.as_variable_statement().declaration_list();
        for &decl in list.as_variable_declaration_list().declarations().nodes() {
            let var_decl = decl.as_variable_declaration();
            if let Some((state_call, setter)) = state_pair_setter(decl, imports)
                && let Some(&initial) = state_call.as_call_expression().arguments().nodes().first()
                && is_prop_or_hook_derived(initial, &scope)
                && is_effect_only_mirror(component, body, setter, initial, imports)
            {
                reports.push(state_call);
                continue;
            }
            if ast::is_identifier(var_decl.name())
                && var_decl.initializer().and_then(hook_call_name).is_some()
            {
                scope
                    .hook_results
                    .insert(var_decl.name().as_identifier().text());
            }
        }
    }
}

fn expr_mentions_any(node: P<Node>, targets: &FxHashSet<&'static str>) -> bool {
    if targets.is_empty() {
        return false;
    }
    if ast::is_identifier(node) && targets.contains(node.as_identifier().text()) {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if expr_mentions_any(child, targets) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn expr_mentions_catch(node: P<Node>, catch_params: &[Option<&'static str>]) -> bool {
    if ast::is_identifier(node)
        && catch_params
            .iter()
            .flatten()
            .any(|&param| param == node.as_identifier().text())
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if expr_mentions_catch(child, catch_params) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn unwrap_object_literal_target(argument: P<Node>) -> Option<P<Node>> {
    let written = unwrap_expression(argument);
    if written.kind() == Kind::ObjectLiteralExpression {
        return Some(written);
    }
    if matches!(
        written.kind(),
        Kind::ArrowFunction | Kind::FunctionExpression
    ) && let Some(body) = written.body()
    {
        let expr = if body.kind() == Kind::Block {
            let stmts = body.as_block().statements().nodes();
            if stmts.len() != 1 || stmts[0].kind() != Kind::ReturnStatement {
                return None;
            }
            stmts[0].as_return_statement().expression()?
        } else {
            body
        };
        let unwrapped = unwrap_expression(expr);
        if unwrapped.kind() == Kind::ObjectLiteralExpression {
            return Some(unwrapped);
        }
    }
    None
}

pub(super) fn classify_object_literal_writes(
    argument: P<Node>,
    awaited: &FxHashSet<&'static str>,
    catch_params: &[Option<&'static str>],
) -> Option<Vec<(&'static str, WriteClass)>> {
    let obj = unwrap_object_literal_target(argument)?;
    let props = obj.as_object_literal_expression().properties().nodes();
    if props.len() < 2 {
        return None;
    }
    let mut out = Vec::new();
    for &prop in props {
        let (prop_name, value) = match prop.kind() {
            Kind::PropertyAssignment => {
                let assign = prop.as_property_assignment();
                let name = assign.name();
                if !ast::is_identifier(name) {
                    continue;
                }
                (
                    name.as_identifier().text(),
                    unwrap_expression(assign.initializer()),
                )
            }
            Kind::ShorthandPropertyAssignment => {
                let short = prop.as_shorthand_property_assignment();
                let name = short.name();
                if !ast::is_identifier(name) {
                    continue;
                }
                (name.as_identifier().text(), name)
            }
            _ => continue,
        };
        let class = match value.kind() {
            Kind::TrueKeyword => Some(WriteClass::TrueConst),
            Kind::FalseKeyword => Some(WriteClass::FalseConst),
            Kind::NullKeyword => Some(WriteClass::NullConst),
            Kind::Identifier if value.as_identifier().text() == "undefined" => {
                Some(WriteClass::NullConst)
            }
            _ if expr_mentions_catch(value, catch_params) => Some(WriteClass::CaughtError),
            _ if expr_mentions_any(value, awaited) => Some(WriteClass::Awaited),
            _ => None,
        };
        if let Some(write_class) = class {
            out.push((prop_name, write_class));
        }
    }
    (out.len() >= 2
        && out
            .iter()
            .any(|(_, c)| matches!(c, WriteClass::TrueConst | WriteClass::FalseConst)))
    .then_some(out)
}

pub(super) fn non_computed_member(expression: P<Node>, target: &str) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    if inner.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = inner.as_property_access_expression();
    let prop = access.name();
    (ast::is_identifier(prop) && prop.as_identifier().text() == target).then(|| access.expression())
}

fn is_known_controller(expression: P<Node>, stack: &[StateFrame]) -> bool {
    let inner = unwrap_expression(expression);
    if ast::is_identifier(inner) {
        let name = inner.as_identifier().text();
        return stack.iter().any(|frame| frame.has_abort_controller(name));
    }
    non_computed_member(expression, "current").is_some_and(|obj| {
        let inner_obj = unwrap_expression(obj);
        ast::is_identifier(inner_obj)
            && stack
                .iter()
                .any(|frame| frame.has_abort_controller_ref(inner_obj.as_identifier().text()))
    })
}

fn is_abort_status_test(test: P<Node>, stack: &[StateFrame]) -> bool {
    let inner = unwrap_expression(test);
    if inner.kind() == Kind::BinaryExpression {
        let bin = inner.as_binary_expression();
        if matches!(
            bin.operator_token().kind(),
            Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
        ) {
            return is_abort_status_test(bin.left(), stack)
                || is_abort_status_test(bin.right(), stack);
        }
    }
    non_computed_member(test, "aborted")
        .and_then(|signal| non_computed_member(signal, "signal"))
        .is_some_and(|controller| is_known_controller(controller, stack))
}

fn statement_exits(statement: Option<P<Node>>) -> bool {
    let Some(stmt) = statement else { return false };
    match stmt.kind() {
        Kind::ReturnStatement
        | Kind::ThrowStatement
        | Kind::BreakStatement
        | Kind::ContinueStatement => true,
        Kind::Block => statement_exits(stmt.as_block().statements().nodes().last().copied()),
        Kind::IfStatement => {
            statement_exits(Some(stmt.as_if_statement().then_statement()))
                && statement_exits(stmt.as_if_statement().else_statement())
        }
        _ => false,
    }
}

fn statement_block(node: P<Node>) -> Option<P<Node>> {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if matches!(ancestor.kind(), Kind::Block | Kind::SourceFile) {
            return Some(ancestor);
        }
        if is_function_like(ancestor) {
            return None;
        }
        cursor = ancestor.parent();
    }
    None
}

pub(super) fn if_statement_guards(if_node: P<Node>, stack: &[StateFrame]) -> Vec<AbortGuard> {
    let mut guards = Vec::new();
    let stmt = if_node.as_if_statement();
    let (test, consequent) = (stmt.expression(), stmt.then_statement());
    if is_abort_status_test(test, stack)
        && statement_exits(Some(consequent))
        && let Some(block) = statement_block(if_node)
    {
        guards.push(AbortGuard {
            block,
            start: None,
            end: if_node.end(),
        });
    }
    let inner_test = unwrap_expression(test);
    if inner_test.kind() == Kind::PrefixUnaryExpression
        && inner_test.as_prefix_unary_expression().operator() == Kind::ExclamationToken
        && is_abort_status_test(inner_test.as_prefix_unary_expression().operand(), stack)
        && consequent.kind() == Kind::Block
    {
        guards.push(AbortGuard {
            block: consequent,
            start: Some(consequent.pos()),
            end: consequent.end(),
        });
    }
    guards
}

pub(super) fn is_guarded(guards: &[AbortGuard], node: P<Node>) -> bool {
    statement_block(node).is_some_and(|block| {
        let start = node.pos();
        guards.iter().any(|guard| {
            guard.block == block
                && guard
                    .start
                    .map_or(guard.end <= start, |s| s <= start && start <= guard.end)
        })
    })
}
