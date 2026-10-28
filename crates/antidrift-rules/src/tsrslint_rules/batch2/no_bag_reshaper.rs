use antidrift_kernel::{projection, tsrs_kernel};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub struct NoBagReshaper;

pub static RULE: NoBagReshaper = NoBagReshaper;

fn build_bag_to_contract_message(parameter_name: &str, target_contract: &str) -> RuleMessage {
    RuleMessage::new(
        "bagToContract",
        format!(
            "Function reshapes unowned bag parameter `{parameter_name}` into `{target_contract}` via key lookups and fallback defaults. Decode unknown input at the boundary or accept the owned contract directly."
        ),
    )
}

fn build_bag_to_bag_message(parameter_name: &str) -> RuleMessage {
    RuleMessage::new(
        "bagToBag",
        format!(
            "Function reshapes unowned bag parameter `{parameter_name}` into another unowned bag. Decode at the ingestion boundary and pass a named domain type instead."
        ),
    )
}

fn check_function_candidate(ctx: &mut Ctx, function: P<Node>, candidate: P<Node>) {
    let Some(classification) =
        projection::classify_bag_reshaper(function, candidate, ctx.checker, ctx.file)
    else {
        return;
    };
    match classification.kind {
        "bagToContract" => {
            ctx.report_node(
                candidate,
                build_bag_to_contract_message(
                    &classification.parameter_name,
                    &classification.target_contract,
                ),
            );
        }
        "bagToBag" => {
            ctx.report_node(
                candidate,
                build_bag_to_bag_message(&classification.parameter_name),
            );
        }
        _ => {}
    }
}

impl Rule for NoBagReshaper {
    fn name(&self) -> &'static str {
        "antidrift/no-bag-reshaper"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor)
    }
}

struct Visitor;

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
        if let Some(fn_node) = tsrs_kernel::function_node_from_declaration(node) {
            check_function_candidate(ctx, fn_node, node);
        }
    }
}
