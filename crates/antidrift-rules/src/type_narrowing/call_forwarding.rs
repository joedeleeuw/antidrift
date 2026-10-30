use antidrift_kernel::{provenance, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, Node, Symbol};
use tsrs_checker::Checker;
use tsrs_core::P;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum BodyForwarding {
    Direct,
    BoundLiteral,
    PrecedingEffect,
    BoundLiteralAndPrecedingEffect,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanStatus {
    Clean(BodyForwarding),
    ArgumentsHazard,
}

impl ScanStatus {
    fn record_bound_literal(&mut self) {
        if let Self::Clean(curr) = *self {
            let next = match curr {
                BodyForwarding::Direct | BodyForwarding::BoundLiteral => {
                    BodyForwarding::BoundLiteral
                }
                BodyForwarding::PrecedingEffect
                | BodyForwarding::BoundLiteralAndPrecedingEffect => {
                    BodyForwarding::BoundLiteralAndPrecedingEffect
                }
            };
            *self = Self::Clean(next);
        }
    }

    fn record_preceding_effect(&mut self) {
        if let Self::Clean(curr) = *self {
            let next = match curr {
                BodyForwarding::Direct | BodyForwarding::PrecedingEffect => {
                    BodyForwarding::PrecedingEffect
                }
                BodyForwarding::BoundLiteral | BodyForwarding::BoundLiteralAndPrecedingEffect => {
                    BodyForwarding::BoundLiteralAndPrecedingEffect
                }
            };
            *self = Self::Clean(next);
        }
    }
}

struct BodyUseScan {
    param_symbols: Vec<Option<P<Symbol>>>,
    used_indices: Vec<usize>,
    status: ScanStatus,
}

pub(super) fn is_literal_kind(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::StringLiteral
            | Kind::NumericLiteral
            | Kind::BigIntLiteral
            | Kind::RegularExpressionLiteral
            | Kind::TrueKeyword
            | Kind::FalseKeyword
            | Kind::NullKeyword
            | Kind::NoSubstitutionTemplateLiteral
    )
}

fn consists_of_literals(node: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if is_literal_kind(unwrapped.kind()) {
        return true;
    }
    if unwrapped.kind() == Kind::PrefixUnaryExpression {
        return consists_of_literals(unwrapped.as_prefix_unary_expression().operand());
    }
    if unwrapped.kind() == Kind::ArrayLiteralExpression {
        return unwrapped
            .as_array_literal_expression()
            .elements()
            .nodes()
            .iter()
            .copied()
            .all(consists_of_literals);
    }
    false
}

fn is_literal_constant(checker: &mut Checker, sym: Option<P<Symbol>>) -> bool {
    let Some(symbol) = sym else {
        return false;
    };
    let resolved = provenance::resolve_aliased_symbol(checker, symbol);
    let Some(decl) = resolved
        .value_declaration()
        .or_else(|| resolved.declarations().first().copied())
    else {
        return false;
    };
    if decl.kind() == Kind::VariableDeclaration
        && ast::get_combined_node_flags(decl).intersects(ast::NodeFlags::Const)
        && let Some(init) = decl.as_variable_declaration().initializer()
    {
        return consists_of_literals(init);
    }
    false
}

fn scan_call_body(node: P<Node>, checker: &mut Checker, state: &mut BodyUseScan) {
    if is_literal_kind(node.kind()) {
        state.status.record_bound_literal();
    }
    if ast::is_identifier(node) {
        let sym = checker.get_symbol_at_location_exported(node);
        if let Some(pos) = state
            .param_symbols
            .iter()
            .position(|&param_sym| param_sym.is_some() && param_sym == sym)
        {
            state.used_indices.push(pos);
        } else if sym.is_none() && node.as_identifier().text() == "arguments" {
            state.status = ScanStatus::ArgumentsHazard;
        } else if is_literal_constant(checker, sym) {
            state.status.record_bound_literal();
        }
        return;
    }
    if ast::is_shorthand_property_assignment(node) {
        let sym = checker.get_shorthand_assignment_value_symbol(Some(node));
        if let Some(pos) = state
            .param_symbols
            .iter()
            .position(|&param_sym| param_sym.is_some() && param_sym == sym)
        {
            state.used_indices.push(pos);
        }
        return;
    }
    if ast::is_property_access_expression(node) {
        if state.used_indices.is_empty() {
            state.status.record_preceding_effect();
        }
        scan_call_body(
            node.as_property_access_expression().expression(),
            checker,
            state,
        );
        return;
    }
    if ast::is_property_assignment(node) {
        let prop = node.as_property_assignment();
        if prop.name().kind() == Kind::ComputedPropertyName {
            scan_call_body(prop.name(), checker, state);
        }
        scan_call_body(prop.initializer(), checker, state);
        return;
    }
    node.for_each_child(&mut |child| {
        scan_call_body(child, checker, state);
        false
    });
}

pub(super) fn parameters_match_in_order(
    fn_node: P<Node>,
    call_node: P<Node>,
    checker: &mut Checker,
) -> Option<BodyForwarding> {
    let params = fn_node.parameters();
    let param_symbols: Vec<_> = params
        .iter()
        .map(|&p| {
            p.name()
                .and_then(|n| checker.get_symbol_at_location_exported(n))
        })
        .collect();
    let mut scan = BodyUseScan {
        param_symbols,
        used_indices: Vec::new(),
        status: ScanStatus::Clean(BodyForwarding::Direct),
    };
    scan_call_body(call_node, checker, &mut scan);
    let ScanStatus::Clean(forwarding) = scan.status else {
        return None;
    };
    (scan.used_indices.len() == params.len()
        && scan
            .used_indices
            .iter()
            .enumerate()
            .all(|(expected, &actual)| expected == actual))
    .then_some(forwarding)
}
