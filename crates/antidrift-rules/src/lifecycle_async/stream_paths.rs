use super::require_stream_reader_disposal::ReaderAnalysis;
use super::syntax::{
    Span, binding_property, declaration, identifier, is_const_decl, is_function, member, symbol,
    symbol_is_mutated, unwrap,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

#[derive(PartialEq, Eq)]
enum ReadResult {
    Complete,
    Record,
}

impl ReaderAnalysis {
    pub(super) fn read_paths_require_cancel(&self, protecting_node: P<Node>) -> bool {
        let protecting = protecting_node.as_try_statement();
        let try_block = protecting.try_block();
        let try_span = Span::of(self.sf, try_block);
        let reads: Vec<P<Node>> = self
            .nodes_within(try_span)
            .into_iter()
            .filter(|&node| node.kind() == Kind::CallExpression && self.method_call(node, "read"))
            .collect();
        if reads.is_empty() {
            return false;
        }
        if reads.len() == 1 && self.trailing_cancel(protecting_node, reads[0]) {
            return false;
        }
        let mut loops = Vec::new();
        let mut seen = FxHashSet::default();
        for read in reads {
            let Some(enclosing) = self.nearest_loop(read, try_span) else {
                return true;
            };
            if !infinite(enclosing) {
                return true;
            }
            if seen.insert(enclosing) {
                loops.push(enclosing);
            }
        }
        let catch_cancels = self.catch_cancels(protecting_node);
        loops
            .into_iter()
            .any(|enclosing| self.unsafe_loop(enclosing, catch_cancels))
    }

    fn catch_cancels(&self, protecting_node: P<Node>) -> bool {
        let Some(catch_clause) = protecting_node.as_try_statement().catch_clause() else {
            return false;
        };
        let stmts = catch_clause
            .as_catch_clause()
            .block()
            .as_block()
            .statements()
            .nodes();
        stmts
            .iter()
            .position(|&stmt| self.statement_method(stmt, "cancel"))
            .is_some_and(|index| self.safe_prefix(&stmts[..index], true))
    }

    fn trailing_cancel(&self, protecting_node: P<Node>, read: P<Node>) -> bool {
        let Some((body, index)) = Self::statement_site(read) else {
            return false;
        };
        let try_stmts = protecting_node
            .as_try_statement()
            .try_block()
            .as_block()
            .statements()
            .nodes();
        std::ptr::eq(body, try_stmts)
            && body
                .get(index + 1)
                .is_some_and(|&stmt| self.statement_method(stmt, "cancel"))
    }

    fn nearest_loop(&self, node: P<Node>, boundary: Span) -> Option<P<Node>> {
        let mut cursor = node.parent();
        while let Some(ancestor) = cursor {
            if Span::of(self.sf, ancestor) == boundary || is_function(ancestor) {
                return None;
            }
            if is_loop(ancestor) {
                return Some(ancestor);
            }
            cursor = ancestor.parent();
        }
        None
    }

    fn unsafe_loop(&self, enclosing: P<Node>, catch_cancels: bool) -> bool {
        self.nodes_within(Span::of(self.sf, enclosing))
            .into_iter()
            .any(|node| match node.kind() {
                Kind::ThrowStatement => !catch_cancels && !self.prior_cancel(node),
                Kind::YieldExpression => true,
                Kind::AwaitExpression => {
                    let arg_span = Span::of(self.sf, node.as_await_expression().expression());
                    !self.done_dominates(node)
                        && !self.contains_method(arg_span, "read")
                        && !self.contains_method(arg_span, "cancel")
                        && !catch_cancels
                        && !self.prior_cancel(node)
                }
                Kind::ReturnStatement => !self.done_dominates(node) && !self.prior_cancel(node),
                Kind::BreakStatement if self.break_exits(node, enclosing) => {
                    !self.done_dominates(node) && !self.prior_cancel(node)
                }
                _ => false,
            })
    }

    fn contains_method(&self, span: Span, method: &str) -> bool {
        self.nodes_within(span)
            .into_iter()
            .any(|node| node.kind() == Kind::CallExpression && self.method_call(node, method))
    }

    fn prior_cancel(&self, node: P<Node>) -> bool {
        Self::statement_site(node).is_some_and(|(body, index)| {
            body[..index]
                .iter()
                .any(|&stmt| self.statement_method(stmt, "cancel"))
        })
    }

    fn done_dominates(&self, node: P<Node>) -> bool {
        let mut child = node;
        let mut cursor = node.parent();
        while let Some(ancestor) = cursor {
            if is_function(ancestor) {
                break;
            }
            if ancestor.kind() == Kind::IfStatement && self.if_branch_done_guarded(ancestor, child)
            {
                return true;
            }
            child = ancestor;
            cursor = ancestor.parent();
        }
        false
    }

    fn if_branch_done_guarded(&self, ancestor: P<Node>, child: P<Node>) -> bool {
        let branch = ancestor.as_if_statement();
        Span::of(self.sf, branch.then_statement()) == Span::of(self.sf, child)
            && self.done_guard(branch.expression())
    }

    fn done_guard(&self, expression: P<Node>) -> bool {
        let inner = unwrap(expression);
        if identifier(inner).is_some() {
            return self.read_result(inner) == Some(ReadResult::Complete);
        }
        if let Some((object, "done")) = member(inner) {
            return self.read_result(object) == Some(ReadResult::Record);
        }
        if inner.kind() != Kind::BinaryExpression {
            return false;
        }
        let bin = inner.as_binary_expression();
        matches!(
            bin.operator_token().kind(),
            Kind::EqualsEqualsToken | Kind::EqualsEqualsEqualsToken
        ) && ((self.done_guard(bin.left()) && literal_true(bin.right()))
            || (literal_true(bin.left()) && self.done_guard(bin.right())))
    }

    fn read_result(&self, expression: P<Node>) -> Option<ReadResult> {
        let ident = identifier(expression)?;
        let binding = symbol(ident)?;
        if symbol_is_mutated(self.sf.as_node(), binding) {
            return None;
        }
        let decl = declaration(binding)?;
        if !is_const_decl(decl) {
            return None;
        }
        let mut initializer = unwrap(decl.as_variable_declaration().initializer()?);
        if initializer.kind() == Kind::AwaitExpression {
            initializer = unwrap(initializer.as_await_expression().expression());
        }
        if !self.method(initializer, "read") {
            return None;
        }
        let pattern = decl.name()?;
        match pattern.kind() {
            Kind::Identifier => Some(ReadResult::Record),
            Kind::ObjectBindingPattern => pattern
                .as_binding_pattern()
                .elements()
                .nodes()
                .iter()
                .any(|&elem| {
                    binding_property(elem).is_some_and(|(key, value)| {
                        key == "done"
                            && ast::is_identifier(value)
                            && value.pos() == binding.ident.pos()
                            && value.end() == binding.ident.end()
                    })
                })
                .then_some(ReadResult::Complete),
            _ => None,
        }
    }

    fn break_exits(&self, node: P<Node>, enclosing: P<Node>) -> bool {
        if node.kind() != Kind::BreakStatement {
            return false;
        }
        let label = node.as_break_statement().label();
        let mut cursor = node.parent();
        while let Some(ancestor) = cursor {
            if is_function(ancestor) {
                return false;
            }
            let target = if let Some(label) = label {
                ancestor.kind() == Kind::LabeledStatement
                    && ancestor
                        .as_labeled_statement()
                        .label()
                        .as_identifier()
                        .text()
                        == label.as_identifier().text()
            } else {
                is_loop(ancestor) || ancestor.kind() == Kind::SwitchStatement
            };
            if target {
                return Span::of(self.sf, ancestor)
                    .contains_inclusive(Span::of(self.sf, enclosing));
            }
            cursor = ancestor.parent();
        }
        false
    }
}

fn is_loop(node: P<Node>) -> bool {
    matches!(
        node.kind(),
        Kind::ForStatement
            | Kind::ForInStatement
            | Kind::ForOfStatement
            | Kind::WhileStatement
            | Kind::DoStatement
    )
}

fn infinite(node: P<Node>) -> bool {
    match node.kind() {
        Kind::ForStatement => node.as_for_statement().condition().is_none(),
        Kind::WhileStatement => literal_true(node.as_while_statement().expression()),
        Kind::DoStatement => literal_true(node.as_do_statement().expression()),
        _ => false,
    }
}

fn literal_true(expression: P<Node>) -> bool {
    unwrap(expression).kind() == Kind::TrueKeyword
}
