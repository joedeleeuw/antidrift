use antidrift_kernel::{shape, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, Node, Symbol};
use tsrs_checker::{Checker, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrslint::utils::{
    get_call_signatures, get_construct_signatures, is_object_type, is_type_flag_set,
    union_type_parts,
};

fn is_double_cast_chain(node: P<Node>, operand: P<Node>) -> bool {
    if let Some((_, inner_type)) =
        tsrs_kernel::assertion_parts(tsrs_kernel::unwrap_parentheses(operand))
        && matches!(inner_type.kind(), Kind::AnyKeyword | Kind::UnknownKeyword)
    {
        return true;
    }
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == Kind::ParenthesizedExpression {
            current = parent.parent();
            continue;
        }
        return matches!(
            parent.kind(),
            Kind::AsExpression | Kind::TypeAssertionExpression
        );
    }
    false
}

fn symbol_aliases_symbol(checker: &mut Checker, sym: P<Symbol>, target_sym: P<Symbol>) -> bool {
    let Some(decl) = sym.value_declaration() else {
        return false;
    };
    if decl.kind() != Kind::VariableDeclaration {
        return false;
    }
    let Some(init) = decl.as_variable_declaration().initializer() else {
        return false;
    };
    let unwrapped = tsrs_kernel::unwrap_expression(init);
    ast::is_identifier(unwrapped)
        && checker.get_symbol_at_location_exported(unwrapped) == Some(target_sym)
}

fn is_type_predicate_subject(checker: &mut Checker, node: P<Node>, operand: P<Node>) -> bool {
    let Some(func) = tsrs_kernel::enclosing_function(node) else {
        return false;
    };
    let Some(return_type) = tsrs_kernel::function_return_type_node(func) else {
        return false;
    };
    if return_type.kind() != Kind::TypePredicate {
        return false;
    }
    let pred_param = return_type.as_type_predicate_node().parameter_name();
    if !ast::is_identifier(pred_param) {
        return false;
    }
    let Some(pred_sym) = checker.get_symbol_at_location_exported(pred_param) else {
        return false;
    };
    let Some(root_ident) = tsrs_kernel::member_chain_root_node(operand) else {
        return false;
    };
    let Some(op_sym) = checker.get_symbol_at_location_exported(root_ident) else {
        return false;
    };
    op_sym == pred_sym || symbol_aliases_symbol(checker, op_sym, pred_sym)
}

fn is_auto_typed_variable(sym: P<Symbol>) -> bool {
    let Some(decl) = sym.value_declaration() else {
        return false;
    };
    if decl.kind() != Kind::VariableDeclaration {
        return false;
    }
    let var_decl = decl.as_variable_declaration();
    var_decl.type_().is_none() && var_decl.initializer().is_none()
}

fn declared_operand_type(checker: &mut Checker, operand: P<Node>, flow_type: P<Type>) -> P<Type> {
    let reference =
        ast::skip_outer_expressions(operand, ast::OEK::Parentheses | ast::OEK::NonNullAssertions);
    if ast::is_identifier(reference) {
        let Some(sym) = checker.get_symbol_at_location_exported(reference) else {
            return flow_type;
        };
        if is_auto_typed_variable(sym) {
            return flow_type;
        }
        return checker.get_type_of_symbol(sym);
    }
    if ast::is_property_access_expression(reference) {
        let prop = reference.as_property_access_expression();
        let object_type = checker.get_type_at_location(prop.expression());
        if is_type_flag_set(object_type, TypeFlags::Any) {
            return object_type;
        }
        if let Some(sym) = checker.get_symbol_at_location_exported(prop.name()) {
            return checker.get_type_of_symbol(sym);
        }
    }
    flow_type
}

fn is_broad_source_type(checker: &mut Checker, typ: P<Type>) -> bool {
    if is_type_flag_set(typ, TypeFlags::TypeParameter) {
        let Some(constraint) = checker.get_base_constraint_of_type(typ) else {
            return true;
        };
        return is_type_flag_set(constraint, TypeFlags::AnyOrUnknown);
    }
    is_type_flag_set(typ, TypeFlags::AnyOrUnknown)
}

fn is_non_primitive_type(typ: P<Type>) -> bool {
    let parts = union_type_parts(typ);
    !parts.is_empty()
        && parts
            .into_iter()
            .all(|part| is_type_flag_set(part, TypeFlags::Object | TypeFlags::NonPrimitive))
}

fn type_allows_unknown(typ: P<Type>) -> bool {
    union_type_parts(typ)
        .into_iter()
        .any(|part| is_type_flag_set(part, TypeFlags::AnyOrUnknown))
}

fn part_claims_only_unknown_keys(checker: &mut Checker, part: P<Type>) -> bool {
    if !is_object_type(part)
        || !get_call_signatures(checker, part).is_empty()
        || !get_construct_signatures(checker, part).is_empty()
    {
        return false;
    }
    let props = checker.get_properties_of_type(part);
    let str_type = checker.string_type;
    let num_type = checker.number_type;
    let str_idx = checker.get_index_type_of_type(part, str_type);
    let num_idx = checker.get_index_type_of_type(part, num_type);
    if props.is_empty() && str_idx.is_none() && num_idx.is_none() {
        return false;
    }
    for &prop in props {
        if !type_allows_unknown(checker.get_type_of_symbol(prop)) {
            return false;
        }
    }
    str_idx.is_none_or(type_allows_unknown) && num_idx.is_none_or(type_allows_unknown)
}

fn claims_only_unknown_valued_keys(checker: &mut Checker, target_type: P<Type>) -> bool {
    let parts = union_type_parts(target_type);
    !parts.is_empty()
        && parts
            .into_iter()
            .all(|part| part_claims_only_unknown_keys(checker, part))
}

fn is_checker_narrowing_proof(
    checker: &mut Checker,
    flow_type: P<Type>,
    target_type: P<Type>,
) -> bool {
    if is_broad_source_type(checker, flow_type)
        || is_type_flag_set(target_type, TypeFlags::AnyOrUnknown)
    {
        return false;
    }
    if shape::same_type(checker, flow_type, target_type)
        || checker.is_type_assignable_to(flow_type, target_type)
    {
        return true;
    }
    is_non_primitive_type(flow_type)
        && !checker.is_array_type(target_type)
        && !tsrs_checker::is_tuple_type_exported(target_type)
        && claims_only_unknown_valued_keys(checker, target_type)
}

fn is_explicit_any_or_unknown_type_node(checker: &mut Checker, type_node: P<Node>) -> bool {
    if matches!(type_node.kind(), Kind::AnyKeyword | Kind::UnknownKeyword) {
        return true;
    }
    if type_node.kind() != Kind::TypeReference {
        return false;
    }
    let type_name = type_node.as_type_reference_node().type_name();
    let Some(sym) = antidrift_kernel::provenance::symbol_at_node(checker, type_name) else {
        return false;
    };
    sym.declarations().iter().any(|&decl| {
        decl.kind() == Kind::TypeAliasDeclaration
            && decl
                .as_type_alias_declaration()
                .type_()
                .is_some_and(|aliased| {
                    matches!(aliased.kind(), Kind::AnyKeyword | Kind::UnknownKeyword)
                })
    })
}

fn is_closed_literal_union_for_primitive(declared_type: P<Type>, target_type: P<Type>) -> bool {
    let parts = shape::non_nullish_type_parts(target_type);
    if parts.len() < 2 {
        return false;
    }
    if is_type_flag_set(declared_type, TypeFlags::String) {
        return parts
            .into_iter()
            .all(|part| is_type_flag_set(part, TypeFlags::StringLiteral));
    }
    if is_type_flag_set(declared_type, TypeFlags::Number) {
        return parts
            .into_iter()
            .all(|part| is_type_flag_set(part, TypeFlags::NumberLiteral));
    }
    false
}

fn check_assertion(ctx: &mut Ctx, node: P<Node>) {
    let Some((operand, type_node)) = tsrs_kernel::assertion_parts(node) else {
        return;
    };
    if tsrs_kernel::is_const_assertion(type_node) || is_double_cast_chain(node, operand) {
        return;
    }
    if is_explicit_any_or_unknown_type_node(ctx.checker, type_node)
        || is_type_predicate_subject(ctx.checker, node, operand)
        || antidrift_kernel::boundary::is_global_json_parse(
            Some(ctx.program),
            ctx.checker,
            tsrs_kernel::unwrap_expression(operand),
        )
    {
        return;
    }
    let target_type = ctx.checker.get_type_from_type_node(type_node);
    if is_type_flag_set(target_type, TypeFlags::Unknown) {
        return;
    }
    let flow_type = ctx.checker.get_type_at_location(operand);
    let declared_type = declared_operand_type(ctx.checker, operand, flow_type);
    let unproven_source = is_broad_source_type(ctx.checker, declared_type)
        || is_closed_literal_union_for_primitive(declared_type, target_type);
    if !unproven_source || is_checker_narrowing_proof(ctx.checker, flow_type, target_type) {
        return;
    }
    ctx.report_node(
        node,
        RuleMessage::new(
            "appeasementCast",
            "This cast forces an unproven value into a named contract. Declare the input type or use a type guard before assigning it.",
        ),
    );
}

pub struct NoAppeasementCast {
    pub scope: antidrift_kernel::rule_scope::RuleScope,
}

pub static DEFAULT_INSTANCE: NoAppeasementCast = NoAppeasementCast {
    scope: antidrift_kernel::rule_scope::RuleScope::DEFAULT,
};

impl NoAppeasementCast {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: antidrift_kernel::rule_scope::RuleScope::from_options(
                "antidrift/no-appeasement-cast",
                options,
            )?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::AsExpression),
    Listener::Enter(Kind::TypeAssertionExpression),
];

impl Rule for NoAppeasementCast {
    fn name(&self) -> &'static str {
        "antidrift/no-appeasement-cast"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(antidrift_kernel::rule_scope::EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        check_assertion(ctx, node);
    }
}
