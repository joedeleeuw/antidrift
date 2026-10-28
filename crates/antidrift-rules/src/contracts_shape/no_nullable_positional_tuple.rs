use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_checker::{Checker, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

const RULE_NAME: &str = "antidrift/no-nullable-positional-tuple";

pub struct NoNullablePositionalTuple {
    scope: RuleScope,
}

pub static RULE: NoNullablePositionalTuple = NoNullablePositionalTuple {
    scope: RuleScope::DEFAULT,
};

impl NoNullablePositionalTuple {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

fn build_nullable_positional_tuple_message() -> RuleMessage {
    RuleMessage::new(
        "nullablePositionalTuple",
        "Do not model multi-field nullable state as a positional tuple. Use a named object or explicit state union.",
    )
}

fn tuple_element_is_optional(element: P<Node>) -> bool {
    match element.kind() {
        Kind::OptionalType => true,
        Kind::NamedTupleMember => {
            let member = element.as_named_tuple_member();
            member.question_token().is_some() || member.type_().kind() == Kind::OptionalType
        }
        _ => false,
    }
}

fn tuple_element_type_node(element: P<Node>) -> P<Node> {
    match element.kind() {
        Kind::NamedTupleMember => tuple_element_type_node(element.as_named_tuple_member().type_()),
        Kind::OptionalType => element.as_optional_type_node().type_(),
        Kind::RestType => element.as_rest_type_node().type_(),
        _ => element,
    }
}

fn type_node_includes_direct_nullish(type_node: P<Node>) -> bool {
    match type_node.kind() {
        Kind::NullKeyword | Kind::UndefinedKeyword | Kind::VoidKeyword => true,
        Kind::LiteralType => type_node.as_literal_type_node().literal().kind() == Kind::NullKeyword,
        Kind::UnionType => type_node
            .as_union_type_node()
            .types()
            .nodes()
            .iter()
            .copied()
            .any(type_node_includes_direct_nullish),
        Kind::ParenthesizedType => {
            type_node_includes_direct_nullish(type_node.as_parenthesized_type_node().type_())
        }
        _ => false,
    }
}

fn type_includes_null_or_undefined(typ: P<Type>, seen: &mut FxHashSet<P<Type>>) -> bool {
    if !seen.insert(typ) {
        return false;
    }
    if typ
        .flags()
        .intersects(TypeFlags::Null | TypeFlags::Undefined)
    {
        return true;
    }
    if typ
        .flags()
        .intersects(TypeFlags::UnionOrIntersection | TypeFlags::TemplateLiteral)
    {
        return typ
            .types()
            .iter()
            .copied()
            .any(|member| type_includes_null_or_undefined(member, seen));
    }
    false
}

fn tuple_element_resolves_to_nullish(checker: &mut Checker, element: P<Node>) -> bool {
    let type_node = tuple_element_type_node(element);
    if !ast::is_type_node(type_node) {
        return false;
    }
    let resolved = checker.get_type_from_type_node_exported(type_node);
    let mut seen = FxHashSet::default();
    type_includes_null_or_undefined(resolved, &mut seen)
}

fn tuple_element_is_nullish_slot(checker: &mut Checker, element: P<Node>) -> bool {
    let type_node = tuple_element_type_node(element);
    tuple_element_is_optional(element)
        || type_node_includes_direct_nullish(type_node)
        || tuple_element_resolves_to_nullish(checker, element)
}

impl Rule for NoNullablePositionalTuple {
    fn name(&self) -> &'static str {
        "antidrift/no-nullable-positional-tuple"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

struct Visitor;

const LISTENERS: [Listener; 1] = [Listener::Enter(Kind::TupleType)];

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        &LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if node.kind() != Kind::TupleType {
            return;
        }
        let elements = node.as_tuple_type_node().elements().nodes();
        let nullish_slots = elements
            .iter()
            .copied()
            .filter(|&element| tuple_element_is_nullish_slot(ctx.checker, element))
            .take(2)
            .count();
        if nullish_slots >= 2 {
            ctx.report_node(node, build_nullable_positional_tuple_message());
        }
    }
}
