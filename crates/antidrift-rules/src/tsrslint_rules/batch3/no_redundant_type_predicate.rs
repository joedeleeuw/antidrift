use tsrs_ast::{self as ast, Kind, Node};
use tsrs_checker::{Checker, Signature, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrslint::utils::{
    find_modifier, get_construct_signatures, is_intrinsic_error_type, is_type_flag_set,
    is_union_type, union_type_parts,
};

#[derive(Clone, Copy)]
enum TypeofTarget {
    String,
    Number,
    BigInt,
    Boolean,
    Symbol,
    Undefined,
}

impl TypeofTarget {
    fn from_literal(text: &str) -> Option<Self> {
        match text {
            "string" => Some(Self::String),
            "number" => Some(Self::Number),
            "bigint" => Some(Self::BigInt),
            "boolean" => Some(Self::Boolean),
            "symbol" => Some(Self::Symbol),
            "undefined" => Some(Self::Undefined),
            _ => None,
        }
    }

    fn like_flags(self) -> TypeFlags {
        match self {
            Self::String => TypeFlags::StringLike,
            Self::Number => TypeFlags::NumberLike,
            Self::BigInt => TypeFlags::BigIntLike,
            Self::Boolean => TypeFlags::BooleanLike,
            Self::Symbol => TypeFlags::ESSymbolLike,
            Self::Undefined => TypeFlags::Undefined,
        }
    }

    fn exact_flag(self) -> TypeFlags {
        match self {
            Self::String => TypeFlags::String,
            Self::Number => TypeFlags::Number,
            Self::BigInt => TypeFlags::BigInt,
            Self::Boolean => TypeFlags::Boolean,
            Self::Symbol => TypeFlags::ESSymbol,
            Self::Undefined => TypeFlags::Undefined,
        }
    }
}

enum NativeCheck {
    InstanceOf(P<Node>),
    TypeOf(TypeofTarget),
    Discriminant {
        property: &'static str,
        optional: bool,
        literal: P<Node>,
    },
    NonNullish(TypeFlags),
}

fn is_callback_argument(node: P<Node>) -> bool {
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

fn single_returned_expression(node: P<Node>) -> Option<P<Node>> {
    let body = node.body()?;
    if !ast::is_block(body) {
        return Some(body);
    }
    let stmts = body.as_block().statements().nodes();
    if stmts.len() != 1 || !ast::is_return_statement(stmts[0]) {
        return None;
    }
    stmts[0].as_return_statement().expression()
}

fn is_param_ident(node: P<Node>, param_name: &str) -> bool {
    ast::is_identifier(node) && node.as_identifier().text() == param_name
}

fn is_primitive_literal(node: P<Node>) -> bool {
    matches!(
        node.kind(),
        Kind::StringLiteral | Kind::NumericLiteral | Kind::TrueKeyword | Kind::FalseKeyword
    )
}

fn member_of_param(node: P<Node>, param_name: &str) -> Option<(&'static str, bool)> {
    if !ast::is_property_access_expression(node) {
        return None;
    }
    let prop = node.as_property_access_expression();
    if !is_param_ident(prop.expression(), param_name) || !ast::is_identifier(prop.name()) {
        return None;
    }
    Some((
        prop.name().as_identifier().text(),
        prop.question_dot_token().is_some(),
    ))
}

fn check_equality_sides(side: P<Node>, other: P<Node>, param_name: &str) -> Option<NativeCheck> {
    if side.kind() == Kind::TypeOfExpression
        && is_param_ident(side.as_type_of_expression().expression(), param_name)
        && ast::is_string_literal(other)
        && let Some(target) = TypeofTarget::from_literal(other.as_string_literal().text())
    {
        return Some(NativeCheck::TypeOf(target));
    }
    let (property, optional) = member_of_param(side, param_name)?;
    is_primitive_literal(other).then_some(NativeCheck::Discriminant {
        property,
        optional,
        literal: other,
    })
}

fn check_inequality_sides(
    op: Kind,
    side: P<Node>,
    other: P<Node>,
    param_name: &str,
) -> Option<NativeCheck> {
    if !is_param_ident(side, param_name) {
        return None;
    }
    let is_null = other.kind() == Kind::NullKeyword;
    let is_undef = ast::is_identifier(other) && other.as_identifier().text() == "undefined";
    if !is_null && !is_undef {
        return None;
    }
    let flags = if op == Kind::ExclamationEqualsToken {
        TypeFlags::Null | TypeFlags::Undefined | TypeFlags::Void
    } else if is_null {
        TypeFlags::Null
    } else {
        TypeFlags::Undefined | TypeFlags::Void
    };
    Some(NativeCheck::NonNullish(flags))
}

fn parse_native_check(expr: P<Node>, param_name: &str) -> Option<NativeCheck> {
    if !ast::is_binary_expression(expr) {
        return None;
    }
    let bin = expr.as_binary_expression();
    let op = bin.operator_token().kind();
    let left = bin.left();
    let right = bin.right();
    match op {
        Kind::InstanceOfKeyword => {
            is_param_ident(left, param_name).then_some(NativeCheck::InstanceOf(right))
        }
        Kind::EqualsEqualsEqualsToken | Kind::EqualsEqualsToken => {
            check_equality_sides(left, right, param_name)
                .or_else(|| check_equality_sides(right, left, param_name))
        }
        Kind::ExclamationEqualsEqualsToken | Kind::ExclamationEqualsToken => {
            check_inequality_sides(op, left, right, param_name)
                .or_else(|| check_inequality_sides(op, right, left, param_name))
        }
        _ => None,
    }
}

fn signature_has_type_params(sig: P<Signature>) -> bool {
    !sig.type_parameters().is_empty()
}

fn instance_type_of(checker: &mut Checker, ctor_type: P<Type>) -> Option<P<Type>> {
    if get_construct_signatures(checker, ctor_type)
        .iter()
        .copied()
        .any(signature_has_type_params)
    {
        return None;
    }
    let proto = checker.get_property_of_type(ctor_type, "prototype")?;
    let instance = checker.get_type_of_symbol(proto);
    (!is_type_flag_set(instance, TypeFlags::AnyOrUnknown)).then_some(instance)
}

fn is_unit_type(typ: P<Type>) -> bool {
    is_type_flag_set(
        typ,
        TypeFlags::StringLiteral
            | TypeFlags::NumberLiteral
            | TypeFlags::BigIntLiteral
            | TypeFlags::BooleanLiteral
            | TypeFlags::EnumLiteral
            | TypeFlags::Null
            | TypeFlags::Undefined,
    )
}

fn filter_discriminant_parts(
    checker: &mut Checker,
    parts: &[P<Type>],
    property: &str,
    optional: bool,
    literal: P<Node>,
) -> Option<Vec<P<Type>>> {
    let literal_type = checker.get_type_at_location(literal);
    let mut kept = Vec::new();
    for &part in parts {
        if is_type_flag_set(
            part,
            TypeFlags::Null | TypeFlags::Undefined | TypeFlags::Void,
        ) {
            if !optional {
                return None;
            }
            continue;
        }
        let prop_sym = checker.get_property_of_type(part, property)?;
        let prop_type = checker.get_type_of_symbol(prop_sym);
        if !union_type_parts(prop_type).into_iter().all(is_unit_type) {
            return None;
        }
        if !checker.is_type_assignable_to(literal_type, prop_type) {
            continue;
        }
        if is_union_type(prop_type) {
            return None;
        }
        kept.push(part);
    }
    Some(kept)
}

fn matches_inferred_parts(checker: &mut Checker, asserted: P<Type>, inferred: &[P<Type>]) -> bool {
    if is_type_flag_set(asserted, TypeFlags::AnyOrUnknown) {
        return false;
    }
    inferred
        .iter()
        .all(|&part| checker.is_type_assignable_to(part, asserted))
        && union_type_parts(asserted).into_iter().all(|part| {
            inferred
                .iter()
                .any(|&cand| checker.is_type_assignable_to(part, cand))
        })
}

fn matches_native_narrowing(
    checker: &mut Checker,
    check: &NativeCheck,
    param_type: P<Type>,
    asserted: P<Type>,
) -> bool {
    let broad = is_type_flag_set(param_type, TypeFlags::AnyOrUnknown);
    let parts = union_type_parts(param_type);
    let kept: Vec<P<Type>> = match check {
        NativeCheck::InstanceOf(ctor) => {
            let ctor_type = checker.get_type_at_location(*ctor);
            let Some(instance) = instance_type_of(checker, ctor_type) else {
                return false;
            };
            if broad {
                return matches_inferred_parts(checker, asserted, &[instance]);
            }
            parts
                .iter()
                .copied()
                .filter(|&part| checker.is_type_assignable_to(part, instance))
                .collect()
        }
        NativeCheck::TypeOf(target) => {
            if broad {
                return is_type_flag_set(asserted, target.exact_flag());
            }
            let flags = target.like_flags();
            parts
                .iter()
                .copied()
                .filter(|&part| is_type_flag_set(part, flags))
                .collect()
        }
        NativeCheck::NonNullish(flags) => {
            if broad {
                return false;
            }
            parts
                .iter()
                .copied()
                .filter(|&part| !is_type_flag_set(part, *flags))
                .collect()
        }
        NativeCheck::Discriminant {
            property,
            optional,
            literal,
        } => {
            if broad || !is_union_type(param_type) {
                return false;
            }
            let Some(filtered) =
                filter_discriminant_parts(checker, &parts, property, *optional, *literal)
            else {
                return false;
            };
            filtered
        }
    };
    !kept.is_empty() && kept.len() < parts.len() && matches_inferred_parts(checker, asserted, &kept)
}

fn find_simple_parameter(node: P<Node>, param_name: &str) -> Option<P<Node>> {
    for &param in node.parameters() {
        let decl = param.as_parameter_declaration();
        if decl.dot_dot_dot_token().is_some() || decl.initializer().is_some() {
            continue;
        }
        if let Some(name_node) = param.name()
            && is_param_ident(name_node, param_name)
        {
            return Some(name_node);
        }
    }
    None
}

fn check_callback(ctx: &mut Ctx, node: P<Node>) {
    if find_modifier(node, Kind::AsyncKeyword).is_some()
        || antidrift_kernel::tsrs_kernel::is_generator_function(node)
        || !is_callback_argument(node)
    {
        return;
    }
    let Some(ret_type) = antidrift_kernel::tsrs_kernel::function_return_type_node(node) else {
        return;
    };
    if ret_type.kind() != Kind::TypePredicate {
        return;
    }
    let pred = ret_type.as_type_predicate_node();
    if pred.asserts_modifier().is_some() || !ast::is_identifier(pred.parameter_name()) {
        return;
    }
    let Some(target_type_node) = pred.type_() else {
        return;
    };
    let param_name = pred.parameter_name().as_identifier().text();
    let Some(param_ident) = find_simple_parameter(node, param_name) else {
        return;
    };
    let Some(returned) = single_returned_expression(node) else {
        return;
    };
    let Some(check) = parse_native_check(returned, param_name) else {
        return;
    };
    let param_type = ctx.checker.get_type_at_location(param_ident);
    if is_type_flag_set(param_type, TypeFlags::TypeParameter) || is_intrinsic_error_type(param_type)
    {
        return;
    }
    let asserted_type = ctx.checker.get_type_from_type_node(target_type_node);
    if matches_native_narrowing(ctx.checker, &check, param_type, asserted_type) {
        ctx.report_node(
            ret_type,
            RuleMessage::new(
                "redundantTypePredicate",
                "TypeScript infers this type predicate from the check. Delete the explicit `x is T` annotation so the assertion cannot drift from the check.",
            ),
        );
    }
}

pub struct NoRedundantTypePredicate;

#[must_use]
pub fn create(_options: Option<&serde_json::Value>) -> Box<dyn Rule> {
    Box::new(NoRedundantTypePredicate)
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::FunctionExpression),
];

impl Rule for NoRedundantTypePredicate {
    fn name(&self) -> &'static str {
        "antidrift/no-redundant-type-predicate"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        check_callback(ctx, node);
    }
}
