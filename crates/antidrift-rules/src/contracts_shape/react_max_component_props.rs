use antidrift_kernel::jsx::function_returns_jsx;
use antidrift_kernel::local_binding::{Binding, binding_for_declarator, resolve_lexical_binding};
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, ScopeOptions, decode_rule_options};
use antidrift_kernel::tsrs_kernel;
use rustc_hash::FxHashSet;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node, Symbol};
use tsrs_checker::{Checker, SignatureKind, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

const RULE_NAME: &str = "antidrift/react-max-component-props";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct MaxComponentPropsOptions {
    max: Option<usize>,
    #[serde(flatten)]
    scope: ScopeOptions,
}

pub struct ReactMaxComponentProps {
    max: usize,
    scope: RuleScope,
}

pub static RULE: ReactMaxComponentProps = ReactMaxComponentProps {
    max: 12,
    scope: RuleScope::DEFAULT,
};

impl ReactMaxComponentProps {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<MaxComponentPropsOptions>(RULE_NAME, options)?;
        let max = parsed.max.unwrap_or(12);
        if max == 0 {
            return Err(format!("invalid options for {RULE_NAME}: max must be >= 1"));
        }
        let scope = RuleScope::from_scope_options(RULE_NAME, &parsed.scope)?;
        Ok(Self { max, scope })
    }
}

fn build_max_component_props_message(count: usize, max: usize) -> RuleMessage {
    RuleMessage::new(
        "maxComponentProps",
        format!(
            "React component accepts too many locally-owned props ({count} > {max}). Split cohesive props into an owned object, resource, or smaller component boundary."
        ),
    )
}

fn callee_terminal_name(callee: P<Node>) -> Option<&'static str> {
    let unwrapped = tsrs_kernel::unwrap_expression(callee);
    match unwrapped.kind() {
        Kind::Identifier => Some(unwrapped.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            let name = unwrapped.as_property_access_expression().name();
            ast::is_identifier(name).then(|| name.as_identifier().text())
        }
        _ => None,
    }
}

fn unwrap_react_callable(expr: P<Node>) -> Option<P<Node>> {
    let mut current = tsrs_kernel::unwrap_expression(expr);
    for _ in 0..4 {
        if current.kind() != Kind::CallExpression {
            break;
        }
        let call = current.as_call_expression();
        let Some(name) = callee_terminal_name(call.expression()) else {
            break;
        };
        if !matches!(name, "forwardRef" | "memo") {
            break;
        }
        let Some(&first_arg) = call.arguments().nodes().first() else {
            break;
        };
        current = tsrs_kernel::unwrap_expression(first_arg);
    }
    matches!(
        current.kind(),
        Kind::ArrowFunction | Kind::FunctionExpression
    )
    .then_some(current)
}

fn get_function_node(node: P<Node>) -> Option<P<Node>> {
    match node.kind() {
        Kind::FunctionDeclaration | Kind::MethodDeclaration => Some(node),
        Kind::VariableDeclaration => node
            .as_variable_declaration()
            .initializer()
            .and_then(unwrap_react_callable),
        Kind::PropertyDeclaration => node
            .as_property_declaration()
            .initializer()
            .and_then(unwrap_react_callable),
        Kind::PropertyAssignment => {
            unwrap_react_callable(node.as_property_assignment().initializer())
        }
        _ => None,
    }
}

fn is_external_declaration(decl: P<Node>) -> bool {
    let Some(sf) = ast::get_source_file_of_node(decl) else {
        return true;
    };
    tsrs_kernel::normalize_path(sf.file_name()).contains("/node_modules/")
}

fn is_locally_declared_property(symbol: P<Symbol>) -> bool {
    let declarations = symbol.declarations();
    !declarations.is_empty()
        && declarations
            .iter()
            .copied()
            .any(|decl| !is_external_declaration(decl))
}

fn local_prop_names_for_type(checker: &mut Checker, typ: P<Type>) -> FxHashSet<String> {
    if typ.flags().intersects(TypeFlags::Union) {
        let mut best = FxHashSet::default();
        for &part in typ.types() {
            let names = local_prop_names_for_type(checker, part);
            if names.len() > best.len() {
                best = names;
            }
        }
        return best;
    }
    let apparent = checker.get_apparent_type_exported(typ);
    let mut names = FxHashSet::default();
    for &prop in checker.get_properties_of_type(apparent) {
        let name = prop.name();
        if !name.is_empty() && !name.starts_with("__") && is_locally_declared_property(prop) {
            names.insert(name.to_owned());
        }
    }
    names
}

fn fc_props_type_node(type_node: P<Node>) -> Option<P<Node>> {
    if type_node.kind() != Kind::TypeReference {
        return None;
    }
    let type_ref = type_node.as_type_reference_node();
    let type_name = type_ref.type_name();
    let is_fc = match type_name.kind() {
        Kind::Identifier => matches!(type_name.as_identifier().text(), "FC" | "FunctionComponent"),
        Kind::QualifiedName => {
            let qn = type_name.as_qualified_name();
            qn.left().kind() == Kind::Identifier
                && qn.left().as_identifier().text() == "React"
                && matches!(
                    qn.right().as_identifier().text(),
                    "FC" | "FunctionComponent"
                )
        }
        _ => false,
    };
    if !is_fc {
        return None;
    }
    type_ref
        .type_arguments()
        .and_then(|args| args.nodes().first().copied())
}

fn fc_annotated_prop_count(checker: &mut Checker, type_node: Option<P<Node>>) -> usize {
    let Some(props_node) = type_node.and_then(fc_props_type_node) else {
        return 0;
    };
    if !ast::is_type_node(props_node) {
        return 0;
    }
    let props_type = checker.get_type_from_type_node_exported(props_node);
    local_prop_names_for_type(checker, props_type).len()
}

fn typed_prop_count_for_callable_node(checker: &mut Checker, node: P<Node>) -> usize {
    if node.kind() != Kind::VariableDeclaration {
        return 0;
    }
    let var_decl = node.as_variable_declaration();
    let var_name = var_decl.name();
    if var_name.kind() != Kind::Identifier {
        return 0;
    }
    let fc_count = fc_annotated_prop_count(checker, var_decl.type_());
    if fc_count > 0 {
        return fc_count;
    }
    let callable_type = checker.get_type_at_location(var_name);
    let Some(&first_sig) = checker
        .get_signatures_of_type(callable_type, SignatureKind::Call)
        .first()
    else {
        return 0;
    };
    let Some(&first_param) = first_sig.parameters().first() else {
        return 0;
    };
    let Some(param_type) = checker.get_type_of_symbol_at_location(first_param, Some(var_name))
    else {
        return 0;
    };
    local_prop_names_for_type(checker, param_type).len()
}

fn object_pattern_prop_count(param_name: P<Node>) -> usize {
    if param_name.kind() != Kind::ObjectBindingPattern {
        return 0;
    }
    param_name
        .as_binding_pattern()
        .elements()
        .nodes()
        .iter()
        .copied()
        .filter(|elem| {
            elem.kind() == Kind::BindingElement
                && elem.as_binding_element().dot_dot_dot_token().is_none()
        })
        .count()
}

fn collect_spread_bindings(first_param: P<Node>, param_name: P<Node>) -> FxHashSet<Binding> {
    let mut bindings = FxHashSet::default();
    if let Some(binding) = binding_for_declarator(first_param) {
        bindings.insert(binding);
        return bindings;
    }
    if param_name.kind() != Kind::ObjectBindingPattern {
        return bindings;
    }
    for &elem in param_name.as_binding_pattern().elements().nodes() {
        if elem.kind() == Kind::BindingElement
            && elem.as_binding_element().dot_dot_dot_token().is_some()
            && let Some(binding) = binding_for_declarator(elem)
        {
            bindings.insert(binding);
        }
    }
    bindings
}

fn is_matching_spread_attr(node: P<Node>, spread_bindings: &FxHashSet<Binding>) -> bool {
    if node.kind() != Kind::JsxSpreadAttribute {
        return false;
    }
    let expr = tsrs_kernel::unwrap_expression(node.as_jsx_spread_attribute().expression());
    resolve_lexical_binding(expr).is_some_and(|binding| spread_bindings.contains(&binding))
}

fn contains_jsx_spread_of(node: Option<P<Node>>, spread_bindings: &FxHashSet<Binding>) -> bool {
    let Some(current) = node else {
        return false;
    };
    if is_matching_spread_attr(current, spread_bindings) {
        return true;
    }
    if tsrs_kernel::is_function_like(current) {
        return false;
    }
    current.for_each_child(&mut |child| contains_jsx_spread_of(Some(child), spread_bindings))
}

fn forwards_props_as_spread(
    fn_node: P<Node>,
    first_param: P<Node>,
    param_name: P<Node>,
    max: usize,
) -> bool {
    let spread_bindings = collect_spread_bindings(first_param, param_name);
    if spread_bindings.is_empty() || !contains_jsx_spread_of(fn_node.body(), &spread_bindings) {
        return false;
    }
    param_name.kind() != Kind::ObjectBindingPattern || object_pattern_prop_count(param_name) <= max
}

fn check_component_node(ctx: &mut Ctx, node: P<Node>, max: usize) {
    let Some(fn_node) = get_function_node(node) else {
        return;
    };
    if !function_returns_jsx(fn_node) {
        return;
    }
    let Some(&first_param) = fn_node.parameters().first() else {
        return;
    };
    let param_name = first_param.as_parameter_declaration().name();
    if forwards_props_as_spread(fn_node, first_param, param_name, max) {
        return;
    }
    let param_type = ctx.checker.get_type_at_location(first_param);
    let param_typed_count = local_prop_names_for_type(ctx.checker, param_type).len();
    let callable_typed_count = typed_prop_count_for_callable_node(ctx.checker, node);
    let typed_count = param_typed_count.max(callable_typed_count);
    let count = object_pattern_prop_count(param_name).max(typed_count);
    if count > max {
        ctx.report_node(first_param, build_max_component_props_message(count, max));
    }
}

impl Rule for ReactMaxComponentProps {
    fn name(&self) -> &'static str {
        "antidrift/react-max-component-props"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor { max: self.max })
    }
}

struct Visitor {
    max: usize,
}

const LISTENERS: [Listener; 5] = [
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::PropertyDeclaration),
    Listener::Enter(Kind::PropertyAssignment),
];

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        &LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        check_component_node(ctx, node, self.max);
    }
}
