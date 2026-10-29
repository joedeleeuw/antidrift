use super::shadow_state_mirror::{SHADOW_STATE_MIRROR_MESSAGE, shadow_state_mirrors};
use antidrift_kernel::imports::FileImports;
use antidrift_kernel::local_binding::resolve_lexical_binding;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::tsrs_kernel::{is_function_like, static_member_chain, unwrap_expression};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::{P, TextPos};
use tsrslint::rule::{Ctx, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-handrolled-resource-lifecycle-cells";
const MESSAGE: &str = "This async transition hand-rolls a resource lifecycle: a constant lifecycle cell is toggled around the request while sibling cells receive the resource value and caught error. Model one resource/reducer value instead of coupled setters.";
const GLOBAL_OBJECTS: [&str; 3] = ["globalThis", "window", "self"];

pub struct NoHandrolledResourceLifecycleCells {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoHandrolledResourceLifecycleCells = NoHandrolledResourceLifecycleCells {
    scope: RuleScope::DEFAULT,
};

impl NoHandrolledResourceLifecycleCells {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

impl Rule for NoHandrolledResourceLifecycleCells {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        let mut traversal = LifecycleTraversal {
            imports: FileImports::collect(ctx.file),
            stack: Vec::new(),
            catch_params: Vec::new(),
            reports: Vec::new(),
        };
        traversal.walk(ctx.file.as_node());
        for node in traversal.reports {
            ctx.report_node(
                node,
                RuleMessage::new("handrolledResourceLifecycle", MESSAGE),
            );
        }
        for node in shadow_state_mirrors(ctx.file, &traversal.imports) {
            ctx.report_node(
                node,
                RuleMessage::new("shadowStateMirror", SHADOW_STATE_MIRROR_MESSAGE),
            );
        }
        Box::new(EmptyVisitor)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum WriteClass {
    TrueConst,
    FalseConst,
    NullConst,
    Awaited,
    CaughtError,
}

enum ArgumentClass {
    Updater,
    Other,
    Recorded(WriteClass),
}

struct AbortGuard {
    block: P<Node>,
    start: Option<TextPos>,
    end: TextPos,
}

#[derive(Default)]
struct FrameCells {
    setters: FxHashSet<&'static str>,
    cell_of: FxHashMap<&'static str, &'static str>,
    awaited_names: FxHashSet<&'static str>,
    writes: Vec<(&'static str, FxHashSet<WriteClass>)>,
    is_transition: bool,
    source_member_setters: Vec<&'static str>,
    catch_setters: Vec<&'static str>,
    updater_setters: FxHashSet<&'static str>,
    abort_controllers: FxHashSet<&'static str>,
    abort_controller_refs: FxHashSet<&'static str>,
    abort_guards: Vec<AbortGuard>,
    abort_guarded_setters: FxHashSet<&'static str>,
}

struct StateFrame {
    node: P<Node>,
    cells: FrameCells,
}

impl StateFrame {
    fn new(node: P<Node>) -> Self {
        Self {
            node,
            cells: FrameCells::default(),
        }
    }

    fn record_write(&mut self, setter: &'static str, class: WriteClass) {
        if let Some((_, classes)) = self.cells.writes.iter_mut().find(|(n, _)| *n == setter) {
            classes.insert(class);
        } else {
            self.cells
                .writes
                .push((setter, FxHashSet::from_iter([class])));
        }
    }

    fn lifecycle_payload_cell(&self, owned: &FxHashSet<&'static str>) -> Option<&'static str> {
        if self
            .cells
            .updater_setters
            .iter()
            .any(|setter| owned.contains(setter))
        {
            return None;
        }
        let entries: Vec<&(&'static str, FxHashSet<WriteClass>)> = self
            .cells
            .writes
            .iter()
            .filter(|(setter, _)| owned.contains(setter))
            .collect();
        let bool_cell = entries.iter().find_map(|(setter, classes)| {
            (classes.contains(&WriteClass::TrueConst) && classes.contains(&WriteClass::FalseConst))
                .then_some(*setter)
        })?;
        let error_cell = self
            .cells
            .catch_setters
            .iter()
            .copied()
            .find(|name| *name != bool_cell && owned.contains(name))?;
        let blocked = [bool_cell, error_cell];
        entries
            .iter()
            .find_map(|(name, classes)| {
                (!blocked.contains(name) && classes.contains(&WriteClass::Awaited)).then_some(*name)
            })
            .or_else(|| {
                self.cells
                    .source_member_setters
                    .iter()
                    .copied()
                    .find(|setter| owned.contains(setter) && !blocked.contains(setter))
            })
    }
}

struct LifecycleTraversal {
    imports: FileImports,
    stack: Vec<StateFrame>,
    catch_params: Vec<Option<&'static str>>,
    reports: Vec<P<Node>>,
}

impl LifecycleTraversal {
    fn walk(&mut self, node: P<Node>) {
        let is_fn = matches!(
            node.kind(),
            Kind::FunctionDeclaration
                | Kind::FunctionExpression
                | Kind::ArrowFunction
                | Kind::MethodDeclaration
        );
        if is_fn {
            self.stack.push(StateFrame::new(node));
        }
        let is_catch = node.kind() == Kind::CatchClause;
        if is_catch {
            let param = node
                .as_catch_clause()
                .variable_declaration()
                .and_then(|decl| decl.name())
                .filter(|id| ast::is_identifier(*id))
                .map(|id| id.as_identifier().text());
            self.catch_params.push(param);
        }
        match node.kind() {
            Kind::AwaitExpression | Kind::TryStatement => self.mark_transition(),
            Kind::IfStatement => self.record_if_guards(node),
            Kind::VariableDeclaration => self.record_declarator(node),
            Kind::CallExpression => self.record_call(node),
            _ => {}
        }
        node.for_each_child(&mut |child| {
            self.walk(child);
            false
        });
        if is_catch {
            self.catch_params.pop();
        }
        if is_fn {
            self.exit_frame();
        }
    }

    fn record_if_guards(&mut self, node: P<Node>) {
        let guards = if_statement_guards(node, &self.stack);
        if let Some(frame) = self.stack.last_mut() {
            frame.cells.abort_guards.extend(guards);
        }
    }

    fn is_hook_callee(&self, callee: P<Node>, hook_name: &str) -> bool {
        self.imports
            .is_unshadowed_call(callee, "react", &[hook_name])
    }

    fn exit_frame(&mut self) {
        let Some(frame) = self.stack.pop() else {
            return;
        };
        if !frame.cells.is_transition {
            return;
        }
        let mut owned = frame.cells.setters.clone();
        if let Some(parent) = self.stack.last() {
            owned.extend(parent.cells.setters.iter().copied());
        }
        if let Some(payload) = frame.lifecycle_payload_cell(&owned)
            && !frame.cells.abort_guarded_setters.contains(payload)
        {
            self.reports.push(frame.node);
        }
    }

    fn mark_transition(&mut self) {
        if let Some(frame) = self.stack.last_mut() {
            frame.cells.is_transition = true;
        }
    }

    fn record_declarator(&mut self, decl_node: P<Node>) {
        let decl = decl_node.as_variable_declaration();
        let Some(init) = decl.initializer().map(unwrap_expression) else {
            return;
        };
        let pattern = decl.name();
        let name = ast::is_identifier(pattern).then(|| pattern.as_identifier().text());
        let is_controller = is_new_abort_controller(Some(init));
        let is_controller_ref = init.kind() == Kind::CallExpression && {
            let call = init.as_call_expression();
            self.is_hook_callee(call.expression(), "useRef")
                && is_new_abort_controller(first_argument(call.arguments().nodes()))
        };
        let state_pair = (init.kind() == Kind::CallExpression
            && pattern.kind() == Kind::ArrayBindingPattern
            && self.is_hook_callee(init.as_call_expression().expression(), "useState"))
        .then(|| array_state_pair(pattern));
        let Some(frame) = self.stack.last_mut() else {
            return;
        };
        if let Some(name) = name {
            if is_controller {
                frame.cells.abort_controllers.insert(name);
            }
            if is_controller_ref {
                frame.cells.abort_controller_refs.insert(name);
            }
            if init.kind() == Kind::AwaitExpression {
                frame.cells.awaited_names.insert(name);
            }
        }
        if let Some((cell, Some(setter))) = state_pair {
            frame.cells.setters.insert(setter);
            if let Some(cell) = cell {
                frame.cells.cell_of.insert(setter, cell);
            }
        }
    }

    fn record_call(&mut self, call_node: P<Node>) {
        let call = call_node.as_call_expression();
        let callee = call.expression();
        if is_global_fetch_call(callee) {
            self.mark_transition();
        }
        if !ast::is_identifier(callee) {
            return;
        }
        let setter = callee.as_identifier().text();
        if !self.stack.iter().any(|f| f.cells.setters.contains(setter)) {
            return;
        }
        let cell = self
            .stack
            .iter()
            .rev()
            .find_map(|f| f.cells.cell_of.get(setter).copied());
        let guarded = self
            .stack
            .last()
            .is_some_and(|f| is_guarded(&f.cells.abort_guards, call_node));
        let in_catch = !self.catch_params.is_empty();
        let class = first_argument(call.arguments().nodes()).map(|arg| {
            let awaited = self.stack.last().map(|f| &f.cells.awaited_names);
            (
                awaited.is_some_and(|a| is_source_member_write(arg, a)),
                awaited.map(|a| classify_write(arg, a, &self.catch_params)),
            )
        });
        let Some(frame) = self.stack.last_mut() else {
            return;
        };
        if guarded {
            frame.cells.abort_guarded_setters.insert(setter);
        }
        if in_catch && !frame.cells.catch_setters.contains(&setter) {
            frame.cells.catch_setters.push(setter);
        }
        let Some((source_write, class)) = class else {
            return;
        };
        if let Some(cell) = cell {
            frame.cells.cell_of.entry(setter).or_insert(cell);
            if source_write {
                frame.cells.source_member_setters.push(setter);
            }
        }
        match class {
            Some(ArgumentClass::Updater) => {
                frame.cells.updater_setters.insert(setter);
            }
            Some(ArgumentClass::Recorded(write)) => frame.record_write(setter, write),
            Some(ArgumentClass::Other) | None => {}
        }
    }
}

fn is_unshadowed_global(expression: P<Node>, name: &str) -> bool {
    ast::is_identifier(expression)
        && expression.as_identifier().text() == name
        && resolve_lexical_binding(expression).is_none()
}

fn is_global_fetch_call(callee: P<Node>) -> bool {
    is_unshadowed_global(callee, "fetch")
        || non_computed_member(callee, "fetch")
            .is_some_and(|obj| GLOBAL_OBJECTS.iter().any(|n| is_unshadowed_global(obj, n)))
}

fn is_new_abort_controller(expression: Option<P<Node>>) -> bool {
    expression
        .map(unwrap_expression)
        .filter(|expr| expr.kind() == Kind::NewExpression)
        .map(|expr| expr.as_new_expression().expression())
        .is_some_and(|c| ast::is_identifier(c) && c.as_identifier().text() == "AbortController")
}

fn array_state_pair(pattern: P<Node>) -> (Option<&'static str>, Option<&'static str>) {
    let elems = pattern.as_binding_pattern().elements().nodes();
    let elem_id = |idx: usize| {
        let elem = *elems.get(idx)?;
        let id = (elem.kind() == Kind::BindingElement)
            .then(|| elem.name())
            .flatten()?;
        ast::is_identifier(id).then(|| id.as_identifier().text())
    };
    (elem_id(0), elem_id(1))
}

fn non_computed_member(expression: P<Node>, target: &str) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    if inner.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = inner.as_property_access_expression();
    let prop = access.name();
    (ast::is_identifier(prop) && prop.as_identifier().text() == target).then(|| access.expression())
}

fn is_source_member_write(expression: P<Node>, awaited: &FxHashSet<&str>) -> bool {
    static_member_chain(expression).is_some_and(|(root, members)| {
        members.len() == 1
            && !members[0].is_empty()
            && ast::is_identifier(root)
            && awaited.contains(root.as_identifier().text())
    })
}

fn classify_write(
    argument: P<Node>,
    awaited: &FxHashSet<&str>,
    catch_params: &[Option<&str>],
) -> ArgumentClass {
    let written = unwrap_expression(argument);
    let recorded = match written.kind() {
        Kind::ArrowFunction | Kind::FunctionExpression => return ArgumentClass::Updater,
        Kind::TrueKeyword => WriteClass::TrueConst,
        Kind::FalseKeyword => WriteClass::FalseConst,
        Kind::NullKeyword => WriteClass::NullConst,
        Kind::AwaitExpression => WriteClass::Awaited,
        Kind::Identifier => match written.as_identifier().text() {
            "undefined" => WriteClass::NullConst,
            name if awaited.contains(name) => WriteClass::Awaited,
            name if catch_params.contains(&Some(name)) => WriteClass::CaughtError,
            _ => return ArgumentClass::Other,
        },
        _ => return ArgumentClass::Other,
    };
    ArgumentClass::Recorded(recorded)
}

fn first_argument(arguments: &[P<Node>]) -> Option<P<Node>> {
    arguments
        .first()
        .copied()
        .filter(|first| first.kind() != Kind::SpreadElement)
}

fn is_known_controller(expression: P<Node>, stack: &[StateFrame]) -> bool {
    let inner = unwrap_expression(expression);
    if ast::is_identifier(inner) {
        let name = inner.as_identifier().text();
        return stack
            .iter()
            .any(|frame| frame.cells.abort_controllers.contains(name));
    }
    non_computed_member(expression, "current").is_some_and(|obj| {
        let inner_obj = unwrap_expression(obj);
        ast::is_identifier(inner_obj)
            && stack.iter().any(|frame| {
                frame
                    .cells
                    .abort_controller_refs
                    .contains(inner_obj.as_identifier().text())
            })
    })
}

fn is_abort_status_test(test: P<Node>, stack: &[StateFrame]) -> bool {
    let inner = unwrap_expression(test);
    if inner.kind() == Kind::BinaryExpression {
        let bin = inner.as_binary_expression();
        if matches!(
            bin.operator_token().kind(),
            Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
        ) {
            return is_abort_status_test(bin.left(), stack)
                || is_abort_status_test(bin.right(), stack);
        }
    }
    non_computed_member(test, "aborted")
        .and_then(|signal| non_computed_member(signal, "signal"))
        .is_some_and(|controller| is_known_controller(controller, stack))
}

fn statement_exits(statement: Option<P<Node>>) -> bool {
    let Some(stmt) = statement else { return false };
    match stmt.kind() {
        Kind::ReturnStatement
        | Kind::ThrowStatement
        | Kind::BreakStatement
        | Kind::ContinueStatement => true,
        Kind::Block => statement_exits(stmt.as_block().statements().nodes().last().copied()),
        Kind::IfStatement => {
            statement_exits(Some(stmt.as_if_statement().then_statement()))
                && statement_exits(stmt.as_if_statement().else_statement())
        }
        _ => false,
    }
}

fn statement_block(node: P<Node>) -> Option<P<Node>> {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if matches!(ancestor.kind(), Kind::Block | Kind::SourceFile) {
            return Some(ancestor);
        }
        if is_function_like(ancestor) {
            return None;
        }
        cursor = ancestor.parent();
    }
    None
}

fn if_statement_guards(if_node: P<Node>, stack: &[StateFrame]) -> Vec<AbortGuard> {
    let mut guards = Vec::new();
    let stmt = if_node.as_if_statement();
    let (test, consequent) = (stmt.expression(), stmt.then_statement());
    if is_abort_status_test(test, stack)
        && statement_exits(Some(consequent))
        && let Some(block) = statement_block(if_node)
    {
        guards.push(AbortGuard {
            block,
            start: None,
            end: if_node.end(),
        });
    }
    let inner_test = unwrap_expression(test);
    if inner_test.kind() == Kind::PrefixUnaryExpression
        && inner_test.as_prefix_unary_expression().operator() == Kind::ExclamationToken
        && is_abort_status_test(inner_test.as_prefix_unary_expression().operand(), stack)
        && consequent.kind() == Kind::Block
    {
        guards.push(AbortGuard {
            block: consequent,
            start: Some(consequent.pos()),
            end: consequent.end(),
        });
    }
    guards
}

fn is_guarded(guards: &[AbortGuard], node: P<Node>) -> bool {
    statement_block(node).is_some_and(|block| {
        let start = node.pos();
        guards.iter().any(|guard| {
            guard.block == block
                && guard
                    .start
                    .map_or(guard.end <= start, |s| s <= start && start <= guard.end)
        })
    })
}
