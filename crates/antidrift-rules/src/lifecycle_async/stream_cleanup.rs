use super::require_stream_reader_disposal::ReaderAnalysis;
use super::syntax::{
    Span, assignment_identifier, binding_for_declarator, call_expression, declaration, identifier,
    is_let_decl, is_var_decl, member, object_property, symbol, unwrap,
};
use tsrs_ast::{Kind, Node, NodeFlags};
use tsrs_core::P;

#[derive(Clone, Copy)]
pub(super) enum Cleanup {
    Unprotected,
    Released,
    CancelledAndReleased,
}

impl Cleanup {
    pub(super) fn releases(self) -> bool {
        !matches!(self, Self::Unprotected)
    }
    pub(super) fn cancels(self) -> bool {
        matches!(self, Self::CancelledAndReleased)
    }
}

impl ReaderAnalysis {
    pub(super) fn finalizer_cleanup(&self, block: P<Node>) -> Cleanup {
        let mut handled_cancel = false;
        for &statement in block.as_block().statements().nodes() {
            match self.cleanup_step(statement) {
                CleanupStep::Cancel => handled_cancel = true,
                CleanupStep::Release(cancelled) => return released(handled_cancel || cancelled),
                CleanupStep::Stop => return Cleanup::Unprotected,
            }
        }
        Cleanup::Unprotected
    }

    fn cleanup_step(&self, statement: P<Node>) -> CleanupStep {
        if self.statement_method(statement, "releaseLock") {
            return CleanupStep::Release(false);
        }
        if self.statement_method(statement, "cancel") {
            return if self.handled_cancel(statement) {
                CleanupStep::Cancel
            } else {
                CleanupStep::Stop
            };
        }
        if statement.kind() != Kind::TryStatement {
            return CleanupStep::Stop;
        }
        let protecting = statement.as_try_statement();
        let Some(finalizer) = protecting.finally_block() else {
            return CleanupStep::Stop;
        };
        let cleanup = self.finalizer_cleanup(finalizer);
        if !cleanup.releases() {
            return CleanupStep::Stop;
        }
        CleanupStep::Release(
            cleanup.cancels()
                || protecting
                    .try_block()
                    .as_block()
                    .statements()
                    .nodes()
                    .iter()
                    .any(|&stmt| self.statement_method(stmt, "cancel")),
        )
    }

    pub(super) fn statement_method(&self, statement: P<Node>, method: &str) -> bool {
        statement.kind() == Kind::ExpressionStatement
            && self.unconditional_call(statement.as_expression_statement().expression(), method)
    }

    fn unconditional_call(&self, expression: P<Node>, method: &str) -> bool {
        if let Some(call) = call_expression(expression) {
            return self.unconditional_invocation(call, method);
        }
        let inner = unwrap(expression);
        match inner.kind() {
            Kind::AwaitExpression => {
                self.unconditional_call(inner.as_await_expression().expression(), method)
            }
            Kind::BinaryExpression => {
                let bin = inner.as_binary_expression();
                match bin.operator_token().kind() {
                    Kind::EqualsToken
                        if assignment_identifier(bin.left())
                            .is_some_and(|ident| self.can_write(ident)) =>
                    {
                        self.unconditional_call(bin.right(), method)
                    }
                    Kind::CommaToken => self.sequence_call(inner, method),
                    _ => false,
                }
            }
            _ => false,
        }
    }

    fn unconditional_invocation(&self, call_node: P<Node>, method: &str) -> bool {
        let call = call_node.as_call_expression();
        let callee = call.expression();
        if call.question_dot_token().is_some()
            && !member(callee).is_some_and(|(_, name)| name == "releaseLock")
        {
            return false;
        }
        if self.method_call(call_node, method) {
            return true;
        }
        if let Some((object, _)) = member(callee)
            && !optional_member(callee)
            && self.unconditional_call(object, method)
        {
            return true;
        }
        call.arguments()
            .nodes()
            .iter()
            .copied()
            .filter(|arg| arg.kind() != Kind::SpreadElement)
            .any(|argument| self.unconditional_call(argument, method))
    }

    fn sequence_call(&self, expression: P<Node>, method: &str) -> bool {
        let mut items = Vec::new();
        collect_comma_items(expression, &mut items);
        for item in items {
            if self.unconditional_call(item, method) {
                return true;
            }
            let inner = unwrap(item);
            if !matches!(inner.kind(), Kind::Identifier | Kind::ThisKeyword) && !is_literal(inner) {
                return false;
            }
        }
        false
    }

    fn handled_cancel(&self, statement: P<Node>) -> bool {
        if statement.kind() != Kind::ExpressionStatement {
            return false;
        }
        let mut expression = unwrap(statement.as_expression_statement().expression());
        while let Some(next) = self.unwrap_cancel_step(expression) {
            expression = next;
        }
        let Some(call) = call_expression(expression) else {
            return false;
        };
        member(call.as_call_expression().expression())
            .is_some_and(|(object, name)| name == "catch" && self.method(object, "cancel"))
    }

    fn unwrap_cancel_step(&self, expression: P<Node>) -> Option<P<Node>> {
        match expression.kind() {
            Kind::AwaitExpression => Some(unwrap(expression.as_await_expression().expression())),
            Kind::BinaryExpression => {
                let bin = expression.as_binary_expression();
                (bin.operator_token().kind() == Kind::EqualsToken
                    && assignment_identifier(bin.left()).is_some_and(|ident| self.can_write(ident)))
                .then(|| unwrap(bin.right()))
            }
            _ => None,
        }
    }

    pub(super) fn can_write(&self, ident: P<Node>) -> bool {
        self.binding_access(ident, true)
    }

    fn binding_access(&self, ident: P<Node>, write: bool) -> bool {
        let Some(binding) = symbol(ident) else {
            return false;
        };
        if binding.decl.kind() == Kind::Parameter
            || binding
                .decl
                .parent()
                .is_some_and(|p| p.kind() == Kind::CatchClause)
        {
            return true;
        }
        declaration(binding).is_some_and(|decl| {
            is_var_decl(decl)
                || ((!write || is_let_decl(decl))
                    && Span::of(self.sf, ident).start >= Span::of(self.sf, decl).end)
        })
    }

    pub(super) fn safe_prefix(&self, statements: &[P<Node>], assignments: bool) -> bool {
        statements.iter().all(|&statement| match statement.kind() {
            Kind::VariableStatement => {
                let list = statement.as_variable_statement().declaration_list();
                !list.flags().intersects(NodeFlags::Using)
                    && list
                        .as_variable_declaration_list()
                        .declarations()
                        .nodes()
                        .iter()
                        .all(|&decl| {
                            binding_for_declarator(decl).is_some()
                                && decl
                                    .as_variable_declaration()
                                    .initializer()
                                    .is_none_or(|init| self.cannot_throw(init))
                        })
            }
            Kind::ExpressionStatement if assignments => {
                let expr = unwrap(statement.as_expression_statement().expression());
                if expr.kind() != Kind::BinaryExpression {
                    return false;
                }
                let bin = expr.as_binary_expression();
                bin.operator_token().kind() == Kind::EqualsToken
                    && assignment_identifier(bin.left()).is_some_and(|ident| self.can_write(ident))
                    && self.cannot_throw(bin.right())
            }
            _ => false,
        })
    }

    fn cannot_throw(&self, expression: P<Node>) -> bool {
        let inner = unwrap(expression);
        if is_literal(inner) {
            return true;
        }
        match inner.kind() {
            Kind::ArrowFunction
            | Kind::FunctionExpression
            | Kind::NoSubstitutionTemplateLiteral => true,
            Kind::ArrayLiteralExpression => inner
                .as_array_literal_expression()
                .elements()
                .nodes()
                .iter()
                .all(|&elem| {
                    elem.kind() == Kind::OmittedExpression
                        || (elem.kind() != Kind::SpreadElement && self.cannot_throw(elem))
                }),
            Kind::ObjectLiteralExpression => inner
                .as_object_literal_expression()
                .properties()
                .nodes()
                .iter()
                .all(|&prop| {
                    object_property(prop)
                        .is_some_and(|(_, value, computed)| !computed && self.cannot_throw(value))
                }),
            _ => identifier(inner).is_some_and(|ident| self.binding_access(ident, false)),
        }
    }
}

fn collect_comma_items(expression: P<Node>, out: &mut Vec<P<Node>>) {
    let inner = unwrap(expression);
    if inner.kind() == Kind::BinaryExpression {
        let bin = inner.as_binary_expression();
        if bin.operator_token().kind() == Kind::CommaToken {
            collect_comma_items(bin.left(), out);
            collect_comma_items(bin.right(), out);
            return;
        }
    }
    out.push(expression);
}

fn is_literal(expression: P<Node>) -> bool {
    matches!(
        expression.kind(),
        Kind::StringLiteral
            | Kind::NumericLiteral
            | Kind::BigIntLiteral
            | Kind::TrueKeyword
            | Kind::FalseKeyword
            | Kind::NullKeyword
            | Kind::RegularExpressionLiteral
    )
}

fn optional_member(expression: P<Node>) -> bool {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::PropertyAccessExpression => inner
            .as_property_access_expression()
            .question_dot_token()
            .is_some(),
        Kind::ElementAccessExpression => inner
            .as_element_access_expression()
            .question_dot_token()
            .is_some(),
        _ => false,
    }
}

enum CleanupStep {
    Cancel,
    Release(bool),
    Stop,
}

fn released(cancelled: bool) -> Cleanup {
    if cancelled {
        Cleanup::CancelledAndReleased
    } else {
        Cleanup::Released
    }
}
