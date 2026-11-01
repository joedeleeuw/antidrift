use antidrift_kernel::directives::effective_token_start;
use antidrift_kernel::file_role;
use antidrift_kernel::jsx::{is_pascal_case_name, react_function_name};
use antidrift_kernel::line_caps::{CappedUnit, LineCapFinding};
use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use antidrift_kernel::tsrs_kernel::{is_function_like, property_name_text, unwrap_expression};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

pub struct LineCapRule {
    unit: CappedUnit,
}

pub static MODULE_RULE: LineCapRule = LineCapRule {
    unit: CappedUnit::Module,
};

pub static FUNCTION_RULE: LineCapRule = LineCapRule {
    unit: CappedUnit::Function,
};

pub static COMPONENT_RULE: LineCapRule = LineCapRule {
    unit: CappedUnit::Component,
};

const MODULE_LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];

const FUNCTION_LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::Constructor),
    Listener::Enter(Kind::GetAccessor),
    Listener::Enter(Kind::SetAccessor),
];

impl Rule for LineCapRule {
    fn name(&self) -> &'static str {
        self.unit.cap().rule_id
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = !file_role::is_declaration_file(ctx.file.file_name());
        Box::new(Visitor {
            unit: self.unit,
            enabled,
        })
    }
}

struct Visitor {
    unit: CappedUnit,
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        match (self.enabled, self.unit) {
            (false, _) => &[],
            (true, CappedUnit::Module) => MODULE_LISTENERS,
            (true, _) => FUNCTION_LISTENERS,
        }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if self.unit == CappedUnit::Module {
            let text = ctx.file.text();
            if let Some(finding) = self.unit.cap().judge("Module", text) {
                report_first_line(ctx, 0, text.len(), finding);
            }
            return;
        }
        if node.body().is_none() || is_immediately_invoked(node) || is_suite_container(node) {
            return;
        }
        let react_name = react_function_name(node);
        let is_component = react_name.is_some_and(is_pascal_case_name)
            && node.body().is_some_and(body_contains_jsx);
        if is_component != (self.unit == CappedUnit::Component) {
            return;
        }
        let (start, end) = ctx.trim(node);
        let (start, end) = (
            usize::try_from(start).unwrap_or(0),
            usize::try_from(end).unwrap_or(0),
        );
        let Some(span) = ctx.file.text().get(start..end) else {
            return;
        };
        let noun = if is_component {
            "Component"
        } else {
            "Function"
        };
        let subject = react_name.map_or_else(|| noun.to_owned(), |name| format!("{noun} `{name}`"));
        if let Some(finding) = self.unit.cap().judge(&subject, span) {
            report_first_line(ctx, start, end, finding);
        }
    }
}

fn body_contains_jsx(node: P<Node>) -> bool {
    if matches!(
        node.kind(),
        Kind::JsxElement | Kind::JsxSelfClosingElement | Kind::JsxFragment
    ) {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if found {
            return true;
        }
        if matches!(child.kind(), Kind::ClassDeclaration | Kind::ClassExpression) {
            return false;
        }
        if is_function_like(child) {
            if is_inline_render_callback(child) && child.body().is_some_and(body_contains_jsx) {
                found = true;
                return true;
            }
            return false;
        }
        if body_contains_jsx(child) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn is_inline_render_callback(func: P<Node>) -> bool {
    matches!(func.kind(), Kind::ArrowFunction | Kind::FunctionExpression)
        && func.parent().is_some_and(|parent| {
            parent.kind() == Kind::CallExpression
                && parent.as_call_expression().expression() != func
        })
}

fn is_immediately_invoked(node: P<Node>) -> bool {
    let mut callee = node;
    let mut parent = node.parent();
    while let Some(wrapper) =
        parent.filter(|candidate| candidate.kind() == Kind::ParenthesizedExpression)
    {
        callee = wrapper;
        parent = wrapper.parent();
    }
    parent.is_some_and(|call| {
        call.kind() == Kind::CallExpression && call.as_call_expression().expression() == callee
    })
}

const SUITE_ROOTS: &[&str] = &["describe", "fdescribe", "xdescribe", "suite", "context"];

const SUITE_MODIFIERS: &[&str] = &[
    "concurrent",
    "each",
    "fails",
    "for",
    "only",
    "runIf",
    "sequential",
    "shuffle",
    "skip",
    "skipIf",
    "todo",
];

fn is_suite_container(node: P<Node>) -> bool {
    node.parent()
        .filter(|parent| parent.kind() == Kind::CallExpression)
        .is_some_and(|call| {
            let callee = call.as_call_expression().expression();
            callee != node && is_suite_callee(callee)
        })
}

fn is_suite_callee(expression: P<Node>) -> bool {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::Identifier => SUITE_ROOTS.contains(&inner.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            let access = inner.as_property_access_expression();
            property_name_text(access.name()).is_some_and(|name| SUITE_MODIFIERS.contains(&name))
                && is_suite_callee(access.expression())
        }
        Kind::CallExpression => is_suite_callee(inner.as_call_expression().expression()),
        _ => false,
    }
}

fn report_first_line(ctx: &mut Ctx, start: usize, end: usize, finding: LineCapFinding) {
    let text = ctx.file.text();
    let token_start = effective_token_start(
        text,
        i32::try_from(start).unwrap_or(i32::MAX),
        i32::try_from(end).unwrap_or(i32::MAX),
    ) as usize;
    let line_end = text
        .get(token_start..end)
        .and_then(|rest| rest.find('\n'))
        .map_or(end, |offset| token_start + offset);
    ctx.report_range(
        i32::try_from(token_start).unwrap_or(i32::MAX),
        i32::try_from(line_end).unwrap_or(i32::MAX),
        RuleMessage::new(finding.tier.message_id(), finding.message),
    );
}
