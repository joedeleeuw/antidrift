use super::syntax::{
    Binding, binding_for_declarator, const_initializer, declaration, identifier, in_scope,
    is_write_reference, member, object_property, property_name, symbol, symbol_is_mutated, unwrap,
    without_parens,
};
use antidrift_kernel::rule_scope::RuleScope;
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-fetch-timeout";

#[derive(Clone, Copy, PartialEq, Eq)]
enum SignalState {
    Absent,
    Present,
    Opaque,
}

pub struct RequireFetchTimeout {
    scope: RuleScope,
}

pub static DEFAULT_RULE: RequireFetchTimeout = RequireFetchTimeout {
    scope: RuleScope::DEFAULT,
};

impl RequireFetchTimeout {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::BinaryExpression),
    Listener::Enter(Kind::CallExpression),
];

impl Rule for RequireFetchTimeout {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            enabled: in_scope(ctx, &self.scope),
            signals: FxHashMap::default(),
        })
    }
}

struct Visitor {
    enabled: bool,
    signals: FxHashMap<Binding, SignalState>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::VariableDeclaration => self.declare(node),
            Kind::BinaryExpression => self.assign(node),
            Kind::CallExpression if self.missing_signal(ctx.file, node) => {
                ctx.report_node(
                    node,
                    RuleMessage::new(
                        "missingSignal",
                        "fetch() must pass `signal` (e.g. `{ signal: AbortSignal.timeout(10_000) }`) so upstream hangs cannot stall the handler.",
                    ),
                );
            }
            _ => {}
        }
    }
}

impl Visitor {
    fn declare(&mut self, decl_node: P<Node>) {
        let Some(binding) = binding_for_declarator(decl_node) else {
            return;
        };
        let decl = decl_node.as_variable_declaration();
        let annotated = decl.type_().is_some_and(|ty| {
            ty.kind() == Kind::TypeReference && {
                let tn = ty.as_type_reference_node().type_name();
                ast::is_identifier(tn) && tn.as_identifier().text() == "Request"
            }
        });
        let annotated_state = if annotated {
            SignalState::Opaque
        } else {
            SignalState::Absent
        };
        self.signals.insert(
            binding,
            decl.initializer()
                .and_then(request_signal)
                .unwrap_or(annotated_state),
        );
    }

    fn assign(&mut self, bin_node: P<Node>) {
        let bin = bin_node.as_binary_expression();
        if !ast::is_assignment_operator(bin.operator_token().kind()) {
            return;
        }
        let Some(ident) = identifier(bin.left()) else {
            self.clear_assigned(bin.left());
            return;
        };
        let Some(binding) = symbol(ident) else {
            return;
        };
        let prior = self
            .signals
            .get(&binding)
            .copied()
            .unwrap_or(SignalState::Absent);
        let preserved = if prior == SignalState::Opaque {
            prior
        } else {
            SignalState::Absent
        };
        self.signals
            .insert(binding, request_signal(bin.right()).unwrap_or(preserved));
    }

    fn clear_assigned(&mut self, target: P<Node>) {
        if ast::is_identifier(target)
            && is_write_reference(target)
            && let Some(binding) = symbol(target)
        {
            self.signals.insert(binding, SignalState::Absent);
        }
        target.for_each_child(&mut |child| {
            self.clear_assigned(child);
            false
        });
    }

    fn missing_signal(&self, sf: P<SourceFile>, call_node: P<Node>) -> bool {
        let call = call_node.as_call_expression();
        if !fetch_origin(sf, call.expression(), &mut FxHashSet::default()) {
            return false;
        }
        let args = call.arguments().nodes();
        let input = args
            .first()
            .copied()
            .filter(|arg| arg.kind() != Kind::SpreadElement);
        let input_state = input
            .and_then(request_signal)
            .or_else(|| {
                input
                    .and_then(identifier)
                    .and_then(symbol)
                    .and_then(|binding| self.signals.get(&binding).copied())
            })
            .unwrap_or(SignalState::Absent);
        let options_state = args.get(1).map_or(SignalState::Absent, |&argument| {
            if argument.kind() == Kind::SpreadElement {
                SignalState::Opaque
            } else {
                object_signal(argument)
            }
        });
        input_state == SignalState::Absent && options_state == SignalState::Absent
    }
}

fn object_signal(expression: P<Node>) -> SignalState {
    let inner = unwrap(expression);
    if inner.kind() != Kind::ObjectLiteralExpression {
        return SignalState::Opaque;
    }
    for &prop in inner.as_object_literal_expression().properties().nodes() {
        if prop.kind() == Kind::SpreadAssignment {
            return SignalState::Opaque;
        }
        if let Some((key, _, _)) = object_property(prop)
            && property_name(key) == Some("signal")
        {
            return SignalState::Present;
        }
    }
    SignalState::Absent
}

fn request_signal(expression: P<Node>) -> Option<SignalState> {
    let inner = unwrap(expression);
    if inner.kind() != Kind::NewExpression {
        return None;
    }
    let ctor = inner.as_new_expression();
    if !identifier(ctor.expression()).is_some_and(|id| id.as_identifier().text() == "Request") {
        return None;
    }
    let second_arg = ctor
        .arguments()
        .and_then(|args| args.nodes().get(1).copied());
    Some(second_arg.map_or(SignalState::Absent, |arg| {
        if arg.kind() == Kind::SpreadElement {
            return SignalState::Opaque;
        }
        let unwrapped = without_parens(arg);
        if unwrapped.kind() == Kind::ObjectLiteralExpression {
            object_signal(unwrapped)
        } else {
            SignalState::Opaque
        }
    }))
}

fn fetch_origin(sf: P<SourceFile>, expression: P<Node>, visited: &mut FxHashSet<Binding>) -> bool {
    let inner = unwrap(expression);
    let Some(ident) = identifier(inner) else {
        return inner.kind() == Kind::PropertyAccessExpression
            && member(inner).is_some_and(|(object, method)| {
                method == "fetch"
                    && identifier(object).is_some_and(|host| {
                        ["globalThis", "window", "self", "global"]
                            .contains(&host.as_identifier().text())
                    })
            });
    };
    let Some(binding) = symbol(ident) else {
        return ident.as_identifier().text() == "fetch";
    };
    if !visited.insert(binding) {
        return false;
    }
    let (annotation, initializer) = if binding.decl.kind() == Kind::Parameter {
        let param = binding.decl.as_parameter_declaration();
        (param.type_(), param.initializer())
    } else {
        (
            declaration(binding).and_then(|decl| decl.as_variable_declaration().type_()),
            None,
        )
    };
    if annotation.is_some_and(|ty| {
        ty.kind() == Kind::TypeQuery && {
            let expr_name = ty.as_type_query_node().expr_name();
            ast::is_identifier(expr_name) && expr_name.as_identifier().text() == "fetch"
        }
    }) {
        return true;
    }
    if let Some(initializer) = initializer {
        return fetch_origin(sf, initializer, visited);
    }
    !symbol_is_mutated(sf.as_node(), binding)
        && const_initializer(binding)
            .is_some_and(|initializer| fetch_origin(sf, initializer, visited))
}
