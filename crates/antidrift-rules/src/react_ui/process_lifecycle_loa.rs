use antidrift_kernel::imports::FileImports;
use antidrift_kernel::tsrs_kernel::{
    callee_name, is_function_like, property_name_text, unwrap_expression,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, NodeFlags, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, RuleMessage};

const RAW_PROCESS_MODULES: &[&str] = &["node:child_process", "child_process"];
const RAW_PROCESS_PRIMITIVES: &[&str] = &["spawn", "exec", "execFile", "fork", "spawnSync"];
const POLLING_HELPERS: &[&str] = &["waitFor", "pollUntil", "waitUntil", "setInterval"];
const STREAM_EVENTS: &[&str] = &["data", "message", "line", "readable"];

pub(super) fn check_process_lifecycle_loa(sf: P<SourceFile>, imports: &FileImports, ctx: &mut Ctx) {
    let root = sf.as_node();
    check_inline_hold_open_scripts(root, ctx);
    check_dual_process_primitives(root, imports, ctx);
    check_polling_event_target_state(root, ctx);
    check_nested_cleanup_pyramids(root, 0, ctx);
}

fn check_inline_hold_open_scripts(node: P<Node>, ctx: &mut Ctx) {
    if node.kind() == Kind::VariableDeclaration {
        let decl = node.as_variable_declaration();
        let name = decl.name();
        if ast::is_identifier(name)
            && name.as_identifier().text().ends_with("Script")
            && let Some(init) = decl.initializer().map(unwrap_expression)
            && let Some(text) = literal_text(init)
            && is_hold_open_or_raw_socket_script(text)
        {
            ctx.report_node(
                init,
                RuleMessage::new(
                    "inlineProcessHoldOpenHack",
                    "This inline foreign/child script uses a wall-clock sleep/interval hold-open timer or raw socket loop instead of parent-bound stdin EOF or native runtime server primitives.",
                ),
            );
        }
    }
    node.for_each_child(&mut |child| {
        check_inline_hold_open_scripts(child, ctx);
        false
    });
}

fn literal_text(node: P<Node>) -> Option<&'static str> {
    match node.kind() {
        Kind::StringLiteral => Some(node.as_string_literal().text()),
        Kind::NoSubstitutionTemplateLiteral => Some(node.text()),
        _ => None,
    }
}

fn is_hold_open_or_raw_socket_script(text: &str) -> bool {
    let has_ready_signal =
        text.contains("print(") || text.contains("stdout.write") || text.contains("console.log(");
    let has_hold_open_timer =
        text.contains("time.sleep(") || text.contains("setInterval(") || text.contains("\nsleep ");
    let has_stdin_lifetime = text.contains("stdin");
    if has_ready_signal && has_hold_open_timer && !has_stdin_lifetime {
        return true;
    }
    text.contains("socket.socket(") && text.contains(".bind(") && text.contains("while True:")
}

fn has_owned_process_helper_import(root: P<Node>) -> bool {
    let mut found = false;
    root.for_each_child(&mut |stmt| {
        if stmt.kind() != Kind::ImportDeclaration {
            return false;
        }
        let import_decl = stmt.as_import_declaration();
        let spec = import_decl.module_specifier();
        if !ast::is_string_literal(spec) {
            return false;
        }
        let module_name = spec.as_string_literal().text();
        if RAW_PROCESS_MODULES.contains(&module_name) || module_name.starts_with("node:") {
            return false;
        }
        let Some(clause) = import_decl.import_clause() else {
            return false;
        };
        let Some(bindings) = clause.as_import_clause().named_bindings() else {
            return false;
        };
        if bindings.kind() != Kind::NamedImports {
            return false;
        }
        for &elem in bindings.as_named_imports().elements().nodes() {
            let name = elem.as_import_specifier().name().as_identifier().text();
            if (name.starts_with("spawn") && name != "spawn")
                || name.contains("ChildProcess")
                || name == "runCommand"
            {
                found = true;
                return true;
            }
        }
        false
    });
    found
}

fn check_dual_process_primitives(root: P<Node>, imports: &FileImports, ctx: &mut Ctx) {
    if !has_owned_process_helper_import(root) {
        return;
    }
    fn walk(node: P<Node>, imports: &FileImports, ctx: &mut Ctx) {
        if node.kind() == Kind::CallExpression {
            let callee = node.as_call_expression().expression();
            let is_raw = RAW_PROCESS_MODULES
                .iter()
                .any(|m| imports.is_unshadowed_call(callee, m, RAW_PROCESS_PRIMITIVES));
            if is_raw {
                ctx.report_node(
                    node,
                    RuleMessage::new(
                        "dualProcessPrimitive",
                        "This module mixes raw `node:child_process` spawning with an owned child-process lifecycle helper. Route all child processes through the owned lifecycle helper.",
                    ),
                );
            }
        }
        node.for_each_child(&mut |child| {
            walk(child, imports, ctx);
            false
        });
    }
    walk(root, imports, ctx);
}

fn check_polling_event_target_state(node: P<Node>, ctx: &mut Ctx) {
    if is_function_like(node)
        && let Some(body) = node.body()
    {
        let mut let_vars = FxHashSet::default();
        collect_mutable_let_names(body, &mut let_vars);
        if !let_vars.is_empty() {
            let mut stream_mutated = FxHashSet::default();
            collect_stream_event_mutated_vars(body, &let_vars, &mut stream_mutated);
            if !stream_mutated.is_empty() {
                report_polling_reads(body, &stream_mutated, ctx);
            }
        }
    }
    node.for_each_child(&mut |child| {
        check_polling_event_target_state(child, ctx);
        false
    });
}

fn collect_mutable_let_names(node: P<Node>, out: &mut FxHashSet<&'static str>) {
    if node.kind() == Kind::VariableDeclarationList && node.flags().intersects(NodeFlags::Let) {
        for &decl in node.as_variable_declaration_list().declarations().nodes() {
            let name = decl.as_variable_declaration().name();
            if ast::is_identifier(name) {
                out.insert(name.as_identifier().text());
            }
        }
    }
    node.for_each_child(&mut |child| {
        if !is_function_like(child) {
            collect_mutable_let_names(child, out);
        }
        false
    });
}

fn is_stream_event_listener_call(call_node: P<Node>) -> Option<P<Node>> {
    let call = call_node.as_call_expression();
    let callee = unwrap_expression(call.expression());
    if callee.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let prop_name = property_name_text(callee.as_property_access_expression().name())?;
    if !matches!(prop_name, "on" | "addListener" | "addEventListener") {
        return None;
    }
    let args = call.arguments().nodes();
    if args.len() < 2 {
        return None;
    }
    let event_name = literal_text(unwrap_expression(args[0]))?;
    if !STREAM_EVENTS.contains(&event_name) {
        return None;
    }
    let cb = unwrap_expression(args[1]);
    is_function_like(cb).then_some(cb)
}

fn collect_stream_event_mutated_vars(
    node: P<Node>,
    let_vars: &FxHashSet<&'static str>,
    out: &mut FxHashSet<&'static str>,
) {
    if node.kind() == Kind::CallExpression
        && let Some(cb) = is_stream_event_listener_call(node)
    {
        collect_mutated_targets(cb, let_vars, out);
    }
    node.for_each_child(&mut |child| {
        if !is_function_like(child) {
            collect_stream_event_mutated_vars(child, let_vars, out);
        }
        false
    });
}

fn collect_mutated_targets(
    node: P<Node>,
    let_vars: &FxHashSet<&'static str>,
    out: &mut FxHashSet<&'static str>,
) {
    if node.kind() == Kind::BinaryExpression {
        let bin = node.as_binary_expression();
        if ast::is_assignment_operator(bin.operator_token().kind()) {
            let left = unwrap_expression(bin.left());
            if ast::is_identifier(left) && let_vars.contains(left.as_identifier().text()) {
                out.insert(left.as_identifier().text());
            }
        }
    }
    if node.kind() == Kind::CallExpression {
        let callee = unwrap_expression(node.as_call_expression().expression());
        if callee.kind() == Kind::PropertyAccessExpression {
            let access = callee.as_property_access_expression();
            let recv = unwrap_expression(access.expression());
            if property_name_text(access.name()) == Some("push")
                && ast::is_identifier(recv)
                && let_vars.contains(recv.as_identifier().text())
            {
                out.insert(recv.as_identifier().text());
            }
        }
    }
    node.for_each_child(&mut |child| {
        collect_mutated_targets(child, let_vars, out);
        false
    });
}

fn expr_reads_any(node: P<Node>, targets: &FxHashSet<&'static str>) -> bool {
    if ast::is_identifier(node) && targets.contains(node.as_identifier().text()) {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if expr_reads_any(child, targets) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn report_polling_reads(node: P<Node>, stream_mutated: &FxHashSet<&'static str>, ctx: &mut Ctx) {
    if node.kind() == Kind::CallExpression
        && let Some(name) = callee_name(node)
        && POLLING_HELPERS.contains(&name)
        && let Some(&first_arg) = node.as_call_expression().arguments().nodes().first()
        && is_function_like(unwrap_expression(first_arg))
        && expr_reads_any(first_arg, stream_mutated)
    {
        ctx.report_node(
            node,
            RuleMessage::new(
                "pollingEventTargetState",
                "This polling callback inspects a mutable buffer accumulated by an event/stream listener. Await a stream-readiness promise or `events.once(...)` instead of timer-polling event state.",
            ),
        );
    }
    node.for_each_child(&mut |child| {
        if !is_function_like(child) {
            report_polling_reads(child, stream_mutated, ctx);
        }
        false
    });
}

fn check_nested_cleanup_pyramids(node: P<Node>, finally_depth: usize, ctx: &mut Ctx) {
    let next_depth = if is_function_like(node) {
        0
    } else if node.kind() == Kind::TryStatement && node.as_try_statement().finally_block().is_some()
    {
        let depth = finally_depth + 1;
        if depth == 3 {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "nestedCleanupPyramid",
                    "Three or more nested `try ... finally` blocks hand-roll LIFO resource teardown. Register cleanups on a single `AsyncDisposableStack` or cleanup stack instead.",
                ),
            );
        }
        depth
    } else {
        finally_depth
    };
    node.for_each_child(&mut |child| {
        check_nested_cleanup_pyramids(child, next_depth, ctx);
        false
    });
}
