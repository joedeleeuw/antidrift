use antidrift_kernel::{boundary, provenance, tsrs_kernel};
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node, NodeFlags};
use tsrs_checker::{Checker, ContextFlags, SignatureKind, TypeFlags};
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrslint::utils::{is_type_flag_set, type_to_string};

pub const RULE_NAME: &str = "antidrift/unknown-input-must-be-decoded";

const DEFAULT_PROBE_THRESHOLD: usize = 4;

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::NewExpression),
    Listener::Enter(Kind::AsExpression),
    Listener::Enter(Kind::TypeAssertionExpression),
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::BinaryExpression),
    Listener::Enter(Kind::ReturnStatement),
];

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct UnknownInputOptions {
    pub defensive_shape_probe_threshold: Option<usize>,
}

pub struct UnknownInputMustBeDecoded {
    pub(super) probe_threshold: usize,
}

pub static DEFAULT_RULE: UnknownInputMustBeDecoded = UnknownInputMustBeDecoded {
    probe_threshold: DEFAULT_PROBE_THRESHOLD,
};

impl UnknownInputMustBeDecoded {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = super::decode_rule_options::<UnknownInputOptions>(RULE_NAME, options)?;
        let threshold = match parsed.defensive_shape_probe_threshold {
            Some(0) => {
                return Err(format!(
                    "invalid options for {RULE_NAME}: defensiveShapeProbeThreshold must be > 0"
                ));
            }
            Some(count) => count,
            None => DEFAULT_PROBE_THRESHOLD,
        };
        Ok(Self {
            probe_threshold: threshold,
        })
    }
}

impl Rule for UnknownInputMustBeDecoded {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor { rule: self })
    }
}

struct Visitor {
    rule: &'static UnknownInputMustBeDecoded,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::CallExpression => self.rule.check_call(node, ctx),
            Kind::NewExpression => UnknownInputMustBeDecoded::check_call_arguments(node, ctx),
            Kind::AsExpression | Kind::TypeAssertionExpression => {
                UnknownInputMustBeDecoded::check_assertion_sink(node, ctx);
            }
            Kind::VariableDeclaration => {
                UnknownInputMustBeDecoded::check_declaration_sink(node, ctx);
            }
            Kind::BinaryExpression => {
                UnknownInputMustBeDecoded::check_assignment_sink(node, ctx);
            }
            Kind::ReturnStatement => {
                UnknownInputMustBeDecoded::check_return_sink(node, ctx);
            }
            _ => {}
        }
    }
}

impl UnknownInputMustBeDecoded {
    fn check_call(&self, node: P<Node>, ctx: &mut Ctx) {
        if self.is_object_entries_shape_probe(node, ctx.checker) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "unknown-input-must-be-decoded",
                    "Do not probe unknown entry values with repeated `typeof` / `in` checks inside `Object.entries(...)` loops; decode or narrow the record boundary once with a schema or owned type guard.",
                ),
            );
        }
        Self::check_type_argument_sink(node, ctx);
        Self::check_call_arguments(node, ctx);
    }

    fn owned_by_cast_chain(expr: P<Node>) -> bool {
        matches!(
            tsrs_kernel::unwrap_awaited_expression(expr).kind(),
            Kind::AsExpression | Kind::TypeAssertionExpression
        )
    }

    fn check_type_argument_sink(node: P<Node>, ctx: &mut Ctx) {
        let call = node.as_call_expression();
        let Some(type_args) = call.type_arguments() else {
            return;
        };
        let Some(&first_type_arg) = type_args.nodes().first() else {
            return;
        };
        if boundary::schema_validation_call_parts(node, ctx.checker).is_some() {
            return;
        }
        let target_type = ctx.checker.get_type_from_type_node_exported(first_type_arg);
        Self::report_if_untrusted_boundary_sink(node, node, target_type, ctx);
    }

    fn check_call_arguments(node: P<Node>, ctx: &mut Ctx) {
        if node.kind() == Kind::CallExpression
            && boundary::schema_validation_call_parts(node, ctx.checker).is_some()
        {
            return;
        }
        let args: &[P<Node>] = match node.kind() {
            Kind::CallExpression => node.as_call_expression().arguments().nodes(),
            Kind::NewExpression => {
                let Some(arg_list) = node.as_new_expression().arguments() else {
                    return;
                };
                arg_list.nodes()
            }
            _ => return,
        };
        for (idx, &arg) in args.iter().enumerate() {
            if Self::owned_by_cast_chain(arg) {
                continue;
            }
            if let Some(target_type) = Self::call_argument_target_type(node, arg, idx, ctx.checker)
            {
                Self::report_if_untrusted_boundary_sink(arg, arg, target_type, ctx);
            }
        }
    }

    fn call_argument_target_type(
        call_or_new: P<Node>,
        arg: P<Node>,
        idx: usize,
        checker: &mut Checker,
    ) -> Option<P<tsrs_checker::Type>> {
        if let Some(contextual) = checker.get_contextual_type_exported(arg, ContextFlags::None) {
            return Some(contextual);
        }
        let (callee, sig_kind) = match call_or_new.kind() {
            Kind::CallExpression => (
                call_or_new.as_call_expression().expression(),
                SignatureKind::Call,
            ),
            Kind::NewExpression => (
                call_or_new.as_new_expression().expression(),
                SignatureKind::Construct,
            ),
            _ => return None,
        };
        let callable_type = checker.get_type_at_location(callee);
        let &first_sig = checker
            .get_signatures_of_type(callable_type, sig_kind)
            .first()?;
        let &param_sym = first_sig.parameters().get(idx)?;
        checker.get_type_of_symbol_at_location(param_sym, Some(call_or_new))
    }

    fn check_assertion_sink(node: P<Node>, ctx: &mut Ctx) {
        if let Some(parent) = node.parent()
            && matches!(
                parent.kind(),
                Kind::AsExpression | Kind::TypeAssertionExpression
            )
        {
            return;
        }
        let expr = if node.kind() == Kind::AsExpression {
            node.as_as_expression().expression()
        } else {
            node.as_type_assertion().expression()
        };
        let unwrapped_once = tsrs_kernel::unwrap_parentheses(expr);
        if matches!(
            unwrapped_once.kind(),
            Kind::AsExpression | Kind::TypeAssertionExpression
        ) {
            return;
        }
        let target_type = ctx.checker.get_type_at_location(node);
        Self::report_if_untrusted_boundary_sink(node, expr, target_type, ctx);
    }

    fn check_declaration_sink(node: P<Node>, ctx: &mut Ctx) {
        let decl = node.as_variable_declaration();
        let (Some(type_node), Some(init)) = (decl.type_(), decl.initializer()) else {
            return;
        };
        if Self::owned_by_cast_chain(init) {
            return;
        }
        let target_type = ctx.checker.get_type_from_type_node_exported(type_node);
        Self::report_if_untrusted_boundary_sink(node, init, target_type, ctx);
    }

    fn check_assignment_sink(node: P<Node>, ctx: &mut Ctx) {
        let bin = node.as_binary_expression();
        if bin.operator_token().kind() != Kind::EqualsToken {
            return;
        }
        let right = bin.right();
        if Self::owned_by_cast_chain(right) {
            return;
        }
        let target_type = ctx.checker.get_type_at_location(bin.left());
        Self::report_if_untrusted_boundary_sink(node, right, target_type, ctx);
    }

    fn check_return_sink(node: P<Node>, ctx: &mut Ctx) {
        let Some(expr) = node.as_return_statement().expression() else {
            return;
        };
        if Self::owned_by_cast_chain(expr) {
            return;
        };
        let Some(enclosing) = tsrs_kernel::enclosing_function(node) else {
            return;
        };
        let Some(return_type_node) = tsrs_kernel::function_return_type_node(enclosing) else {
            return;
        };
        if return_type_node.kind() == Kind::TypePredicate {
            return;
        }
        let declared_return = ctx
            .checker
            .get_type_from_type_node_exported(return_type_node);
        let target_type = ctx
            .checker
            .get_awaited_type_exported(declared_return)
            .unwrap_or(declared_return);
        Self::report_if_untrusted_boundary_sink(node, expr, target_type, ctx);
    }

    fn report_if_untrusted_boundary_sink(
        sink_node: P<Node>,
        expr: P<Node>,
        target_type: P<tsrs_checker::Type>,
        ctx: &mut Ctx,
    ) {
        if is_type_flag_set(
            target_type,
            TypeFlags::AnyOrUnknown | TypeFlags::Void | TypeFlags::TypeParameter,
        ) {
            return;
        }
        let inner = tsrs_kernel::unwrap_awaited_expression(expr);
        let expr_type = ctx.checker.get_type_at_location(expr);
        let flow_type = ctx
            .checker
            .get_awaited_type_exported(expr_type)
            .unwrap_or(expr_type);
        if !is_type_flag_set(flow_type, TypeFlags::AnyOrUnknown) {
            return;
        }
        let Some(source_kind) =
            Self::untrusted_boundary_source_kind(inner, ctx.program, ctx.checker)
        else {
            return;
        };
        let target_str = type_to_string(ctx.checker, target_type);
        ctx.report_node(
            sink_node,
            RuleMessage::new(
                "unknown-input-must-be-decoded",
                format!(
                    "Untrusted {source_kind} input reaches '{target_str}' without a runtime decode or proving type guard."
                ),
            ),
        );
    }

    fn untrusted_boundary_source_kind(
        expr: P<Node>,
        program: &Program,
        checker: &mut Checker,
    ) -> Option<&'static str> {
        let unwrapped = tsrs_kernel::unwrap_awaited_expression(expr);
        if unwrapped.kind() == Kind::CallExpression {
            return Self::direct_boundary_call_kind(unwrapped, program, checker);
        }
        if !ast::is_identifier(unwrapped) {
            return None;
        }
        let sym = provenance::symbol_at_node(checker, unwrapped)?;
        let decl = sym.value_declaration()?;
        if decl.kind() == Kind::VariableDeclaration
            && decl
                .parent()
                .is_some_and(|list| list.flags().intersects(NodeFlags::Const))
            && let Some(init) = decl.as_variable_declaration().initializer()
        {
            let init_unwrapped = tsrs_kernel::unwrap_awaited_expression(init);
            if init_unwrapped.kind() == Kind::CallExpression {
                return Self::direct_boundary_call_kind(init_unwrapped, program, checker);
            }
        }
        None
    }

    fn direct_boundary_call_kind(
        call_node: P<Node>,
        program: &Program,
        checker: &mut Checker,
    ) -> Option<&'static str> {
        if boundary::is_global_json_parse(Some(program), checker, call_node) {
            return Some("json");
        }
        let callee = tsrs_kernel::unwrap_expression(call_node.as_call_expression().expression());
        if callee.kind() != Kind::PropertyAccessExpression {
            return None;
        }
        let prop = callee.as_property_access_expression();
        let name = prop.name();
        if !ast::is_identifier(name) || name.as_identifier().text() != "json" {
            return None;
        }
        let receiver_type = checker.get_type_at_location(prop.expression());
        let sym = receiver_type.symbol()?;
        matches!(sym.name(), "Response" | "Request" | "Body" | "BodyMixin").then_some("http-body")
    }
}
