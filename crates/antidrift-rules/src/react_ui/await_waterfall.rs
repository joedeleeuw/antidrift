use antidrift_kernel::local_binding::{Binding, declared_bindings, for_each_resolved_reference};
use antidrift_kernel::tsrs_kernel::{callee_name, member_chain_root_identifier, unwrap_expression};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

const MUTATION_PREFIXES: [&str; 13] = [
    "write", "update", "delete", "remove", "insert", "create", "mutate", "exec", "commit", "push",
    "set", "save", "checkout",
];
const INDEPENDENT_RUN_LENGTH: usize = 3;

#[must_use]
pub fn independent_await_runs(body: P<Node>) -> Vec<P<Node>> {
    let mut reported = Vec::new();
    scan_block(body, &mut reported);
    reported
}

fn scan_block(block: P<Node>, reported: &mut Vec<P<Node>>) {
    if block.kind() != Kind::Block {
        return;
    }
    let mut run = IndependentRun::default();
    for &statement in block.as_block().statements().nodes() {
        if run.extend(statement) {
            reported.push(statement);
        }
        scan_nested_blocks(statement, reported);
    }
}

fn scan_nested_blocks(statement: P<Node>, reported: &mut Vec<P<Node>>) {
    match statement.kind() {
        Kind::Block => scan_block(statement, reported),
        Kind::IfStatement => {
            let branch = statement.as_if_statement();
            scan_nested_blocks(branch.then_statement(), reported);
            if let Some(otherwise) = branch.else_statement() {
                scan_nested_blocks(otherwise, reported);
            }
        }
        _ => {}
    }
}

#[derive(Default)]
struct IndependentRun {
    bindings: FxHashSet<Binding>,
    length: usize,
}

impl IndependentRun {
    fn extend(&mut self, statement: P<Node>) -> bool {
        let Some((declaration, call)) = awaited_read_declaration(statement) else {
            *self = Self::default();
            return false;
        };
        let mut dependent = false;
        for_each_resolved_reference(call, true, &mut |binding| {
            dependent |= self.bindings.contains(&binding);
        });
        if dependent {
            *self = Self::default();
        }
        self.bindings.extend(declared_bindings(declaration));
        self.length += 1;
        self.length == INDEPENDENT_RUN_LENGTH
    }
}

fn awaited_read_declaration(statement: P<Node>) -> Option<(P<Node>, P<Node>)> {
    if statement.kind() != Kind::VariableStatement {
        return None;
    }
    let list = statement.as_variable_statement().declaration_list();
    let &[declaration] = list.as_variable_declaration_list().declarations().nodes() else {
        return None;
    };
    let awaited = unwrap_expression(declaration.as_variable_declaration().initializer()?);
    if !ast::is_await_expression(awaited) {
        return None;
    }
    let call = unwrap_expression(awaited.as_await_expression().expression());
    if call.kind() != Kind::CallExpression {
        return None;
    }
    let callee = call.as_call_expression().expression();
    if member_chain_root_identifier(callee) == Some("Promise") {
        return None;
    }
    let name = callee_name(call)?;
    let mutates = MUTATION_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix));
    (!mutates).then_some((declaration, call))
}
