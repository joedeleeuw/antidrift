use antidrift_kernel::imports::FileImports;
use antidrift_kernel::jsx::{is_component_or_hook_function, is_hook_name};
use antidrift_kernel::tsrs_kernel::{is_function_like, unwrap_expression};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

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
    let root = unwrap_expression(inner.as_property_access_expression().expression());
    ast::is_identifier(root) && {
        let root_name = root.as_identifier().text();
        scope.params.contains(root_name) || scope.hook_results.contains(root_name)
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
        if is_function_like(ancestor) && is_effect_callback(ancestor, imports) {
            return true;
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
    imports: &FileImports,
) -> bool {
    let mut references = Vec::new();
    collect_references(body, setter.as_identifier().text(), setter, &mut references);
    let mut effect_calls = 0usize;
    for reference in references {
        if !is_inside_effect(reference, component, imports) {
            return false;
        }
        let is_call = reference.parent().is_some_and(|parent| {
            parent.kind() == Kind::CallExpression
                && parent.as_call_expression().expression() == reference
        });
        effect_calls += usize::from(is_call);
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
                && is_effect_only_mirror(component, body, setter, imports)
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
