use antidrift_kernel::file_role;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{provenance, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, Symbol};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-argument-mutation-side-effect";

const ACCUMULATOR_NAMES: &[&str] = &[
    "cache",
    "memo",
    "headers",
    "res",
    "response",
    "out",
    "acc",
    "accumulator",
];

pub struct NoArgumentMutationSideEffect {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoArgumentMutationSideEffect = NoArgumentMutationSideEffect {
    scope: RuleScope::DEFAULT,
};

impl NoArgumentMutationSideEffect {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

impl Rule for NoArgumentMutationSideEffect {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) || !file_role::is_authored_source_file(ctx.file) {
            return Box::new(EmptyVisitor);
        }
        for &stmt in ctx.file.statements().nodes() {
            for fn_node in module_scope_functions(stmt) {
                check_function(ctx, fn_node);
            }
        }
        Box::new(EmptyVisitor)
    }
}

fn module_scope_functions(stmt: P<Node>) -> Vec<P<Node>> {
    match stmt.kind() {
        Kind::FunctionDeclaration => vec![stmt],
        Kind::VariableStatement if ast::has_syntactic_modifier(stmt, ModifierFlags::Export) => stmt
            .as_variable_statement()
            .declaration_list()
            .as_variable_declaration_list()
            .declarations()
            .nodes()
            .iter()
            .filter_map(|&decl| tsrs_kernel::function_node_from_declaration(decl))
            .filter(|func| matches!(func.kind(), Kind::ArrowFunction | Kind::FunctionExpression))
            .collect(),
        _ => Vec::new(),
    }
}

fn is_middleware_signature(params: &[P<Node>]) -> bool {
    let [_, _, last] = params else {
        return false;
    };
    let name = last.as_parameter_declaration().name();
    ast::is_identifier(name) && name.as_identifier().text() == "next"
}

fn is_void_type(type_node: P<Node>) -> bool {
    if type_node.kind() == Kind::VoidKeyword {
        return true;
    }
    if type_node.kind() != Kind::TypeReference {
        return false;
    }
    let reference = type_node.as_type_reference_node();
    let type_name = reference.type_name();
    let args = reference
        .type_arguments()
        .map_or(&[][..], |list| list.nodes());
    ast::is_identifier(type_name)
        && type_name.as_identifier().text() == "Promise"
        && matches!(args, [only] if only.kind() == Kind::VoidKeyword)
}

fn returns_nothing(fn_node: P<Node>, body: P<Node>) -> bool {
    body.kind() == Kind::Block
        && tsrs_kernel::collect_return_expressions(Some(body)).is_empty()
        && tsrs_kernel::function_return_type_node(fn_node).is_none_or(is_void_type)
}

fn has_only_data_members(members: &[P<Node>]) -> bool {
    members.iter().all(|member| {
        !matches!(
            member.kind(),
            Kind::MethodSignature | Kind::CallSignature | Kind::ConstructSignature
        )
    })
}

fn is_data_declaration(decl: P<Node>) -> bool {
    match decl.kind() {
        Kind::InterfaceDeclaration => {
            let iface = decl.as_interface_declaration();
            iface.heritage_clauses().is_none() && has_only_data_members(iface.members().nodes())
        }
        Kind::TypeAliasDeclaration => {
            decl.as_type_alias_declaration()
                .type_()
                .is_some_and(|aliased| {
                    aliased.kind() == Kind::TypeLiteral
                        && has_only_data_members(aliased.as_type_literal_node().members().nodes())
                })
        }
        _ => false,
    }
}

fn is_data_bag_type(checker: &mut Checker, type_node: P<Node>) -> bool {
    match type_node.kind() {
        Kind::TypeLiteral => {
            has_only_data_members(type_node.as_type_literal_node().members().nodes())
        }
        Kind::TypeReference => {
            let type_name = type_node.as_type_reference_node().type_name();
            if ast::is_identifier(type_name)
                && matches!(type_name.as_identifier().text(), "Record" | "Map")
            {
                return true;
            }
            let decls = provenance::symbol_at_node(checker, type_name)
                .map(|sym| sym.declarations().to_vec())
                .unwrap_or_default();
            !decls.is_empty() && decls.iter().all(|&decl| is_data_declaration(decl))
        }
        _ => false,
    }
}

fn is_param_reference(checker: &mut Checker, node: P<Node>, param_symbol: P<Symbol>) -> bool {
    let inner = tsrs_kernel::unwrap_expression(node);
    ast::is_identifier(inner)
        && checker.get_symbol_at_location_exported(inner) == Some(param_symbol)
}

fn is_assignment_target(node: P<Node>) -> bool {
    node.parent().is_some_and(|parent| match parent.kind() {
        Kind::BinaryExpression => {
            let binary = parent.as_binary_expression();
            binary.left() == node && ast::is_assignment_operator(binary.operator_token().kind())
        }
        Kind::PrefixUnaryExpression => matches!(
            parent.as_prefix_unary_expression().operator(),
            Kind::PlusPlusToken | Kind::MinusMinusToken
        ),
        Kind::PostfixUnaryExpression => true,
        _ => false,
    })
}

enum ParamWrite {
    Mutation,
    Reassignment,
}

fn classify_write(
    checker: &mut Checker,
    node: P<Node>,
    param_symbol: P<Symbol>,
) -> Option<ParamWrite> {
    match node.kind() {
        Kind::Identifier => (is_assignment_target(node)
            && is_param_reference(checker, node, param_symbol))
        .then_some(ParamWrite::Reassignment),
        Kind::PropertyAccessExpression | Kind::ElementAccessExpression => {
            let receiver = if node.kind() == Kind::PropertyAccessExpression {
                node.as_property_access_expression().expression()
            } else {
                node.as_element_access_expression().expression()
            };
            (is_assignment_target(node) && is_param_reference(checker, receiver, param_symbol))
                .then_some(ParamWrite::Mutation)
        }
        Kind::CallExpression => {
            let callee = tsrs_kernel::unwrap_expression(node.as_call_expression().expression());
            (callee.kind() == Kind::PropertyAccessExpression
                && tsrs_kernel::property_name_text(callee.as_property_access_expression().name())
                    == Some("set")
                && is_param_reference(
                    checker,
                    callee.as_property_access_expression().expression(),
                    param_symbol,
                ))
            .then_some(ParamWrite::Mutation)
        }
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ParamWriteState {
    Unwritten,
    MutatedInPlace,
    Reassigned,
}

fn scan_writes(
    checker: &mut Checker,
    node: P<Node>,
    param_symbol: P<Symbol>,
    state: &mut ParamWriteState,
) {
    match classify_write(checker, node, param_symbol) {
        Some(ParamWrite::Reassignment) => *state = ParamWriteState::Reassigned,
        Some(ParamWrite::Mutation) if *state == ParamWriteState::Unwritten => {
            *state = ParamWriteState::MutatedInPlace;
        }
        Some(ParamWrite::Mutation) | None => {}
    }
    node.for_each_child(&mut |child| {
        scan_writes(checker, child, param_symbol, state);
        false
    });
}

fn check_function(ctx: &mut Ctx, fn_node: P<Node>) {
    let Some(body) = fn_node.body() else {
        return;
    };
    let params = fn_node.parameters();
    if tsrs_kernel::is_generator_function(fn_node)
        || is_middleware_signature(params)
        || !returns_nothing(fn_node, body)
    {
        return;
    }
    for &param in params {
        let decl = param.as_parameter_declaration();
        let name = decl.name();
        if !ast::is_identifier(name) || ACCUMULATOR_NAMES.contains(&name.as_identifier().text()) {
            continue;
        }
        let Some(type_node) = decl.type_() else {
            continue;
        };
        if !is_data_bag_type(ctx.checker, type_node) {
            continue;
        }
        let Some(param_symbol) = ctx.checker.get_symbol_at_location_exported(name) else {
            continue;
        };
        let mut state = ParamWriteState::Unwritten;
        scan_writes(ctx.checker, body, param_symbol, &mut state);
        if state != ParamWriteState::MutatedInPlace {
            continue;
        }
        let text = name.as_identifier().text();
        ctx.report_node(
            param,
            RuleMessage::new(
                "argumentMutationSideEffect",
                format!(
                    "This function returns nothing and mutates its argument '{text}' in place, so the caller's object changes as a hidden side effect. Return the new value and let the caller own the update."
                ),
            ),
        );
    }
}
