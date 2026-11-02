use antidrift_kernel::rule::Ctx;
use antidrift_kernel::{boundary, provenance, shape, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, Node, SourceFile, Symbol};
use tsrs_checker::{Checker, TypeFlags};
use tsrs_core::P;
use tsrslint::utils::is_type_flag_set;

use super::unknown_input_must_be_decoded::UnknownInputMustBeDecoded;

impl UnknownInputMustBeDecoded {
    pub(super) fn is_object_entries_shape_probe(
        &self,
        node: P<Node>,
        checker: &mut Checker,
    ) -> bool {
        let Some((entries_arg, method_name, callback)) = Self::object_entries_loop_parts(node)
        else {
            return false;
        };
        let param_index = usize::from(method_name == "reduce");
        let Some(value_ident) = Self::entry_value_binding(callback, param_index, checker) else {
            return false;
        };
        if !Self::is_broad_entry_value(value_ident, entries_arg, checker) {
            return false;
        }
        let Some(value_sym) = provenance::symbol_at_node(checker, value_ident) else {
            return false;
        };
        let Some(body) = tsrs_kernel::function_body_node(callback) else {
            return false;
        };
        let mut count = 0;
        Self::count_shape_probes(body, checker, value_sym, &mut count);
        count >= self.probe_threshold
    }

    fn object_entries_loop_parts(node: P<Node>) -> Option<(P<Node>, &'static str, P<Node>)> {
        let call = node.as_call_expression();
        let callee = tsrs_kernel::unwrap_expression(call.expression());
        if callee.kind() != Kind::PropertyAccessExpression {
            return None;
        }
        let prop = callee.as_property_access_expression();
        let prop_name = prop.name();
        if !ast::is_identifier(prop_name) {
            return None;
        }
        let method_name = match prop_name.as_identifier().text() {
            "map" => "map",
            "flatMap" => "flatMap",
            "reduce" => "reduce",
            _ => return None,
        };
        let receiver = tsrs_kernel::unwrap_expression(prop.expression());
        if receiver.kind() != Kind::CallExpression {
            return None;
        }
        let entries_call = receiver.as_call_expression();
        let entries_callee = tsrs_kernel::unwrap_expression(entries_call.expression());
        if entries_callee.kind() != Kind::PropertyAccessExpression {
            return None;
        }
        let entries_prop = entries_callee.as_property_access_expression();
        let obj_ident = tsrs_kernel::unwrap_expression(entries_prop.expression());
        let entries_ident = entries_prop.name();
        if !ast::is_identifier(obj_ident)
            || obj_ident.as_identifier().text() != "Object"
            || !ast::is_identifier(entries_ident)
            || entries_ident.as_identifier().text() != "entries"
        {
            return None;
        }
        let &entries_arg = entries_call.arguments().nodes().first()?;
        let &callback_arg = call.arguments().nodes().first()?;
        let callback = tsrs_kernel::unwrap_expression(callback_arg);
        if !matches!(
            callback.kind(),
            Kind::ArrowFunction | Kind::FunctionExpression
        ) {
            return None;
        }
        Some((entries_arg, method_name, callback))
    }

    fn entry_value_binding(
        callback: P<Node>,
        param_index: usize,
        checker: &mut Checker,
    ) -> Option<P<Node>> {
        let &param_node = callback.parameters().get(param_index)?;
        let param_name = param_node.as_parameter_declaration().name();
        if param_name.kind() == Kind::ArrayBindingPattern {
            return Self::second_tuple_binding_identifier(param_name);
        }
        if !ast::is_identifier(param_name) {
            return None;
        }
        let entry_sym = provenance::symbol_at_node(checker, param_name)?;
        let body = tsrs_kernel::function_body_node(callback)?;
        if body.kind() != Kind::Block {
            return None;
        }
        for &stmt in body.as_block().statements().nodes() {
            if let Some(found) = Self::destructured_entry_in_statement(stmt, entry_sym, checker) {
                return Some(found);
            }
        }
        None
    }

    fn destructured_entry_in_statement(
        stmt: P<Node>,
        entry_sym: P<Symbol>,
        checker: &mut Checker,
    ) -> Option<P<Node>> {
        if stmt.kind() != Kind::VariableStatement {
            return None;
        }
        let decls = stmt
            .as_variable_statement()
            .declaration_list()
            .as_variable_declaration_list()
            .declarations()
            .nodes();
        for &decl_node in decls {
            if let Some(found) =
                Self::destructured_entry_in_declaration(decl_node, entry_sym, checker)
            {
                return Some(found);
            }
        }
        None
    }

    fn destructured_entry_in_declaration(
        decl_node: P<Node>,
        entry_sym: P<Symbol>,
        checker: &mut Checker,
    ) -> Option<P<Node>> {
        let decl = decl_node.as_variable_declaration();
        let init = decl.initializer()?;
        let init_unwrapped = tsrs_kernel::unwrap_expression(init);
        if ast::is_identifier(init_unwrapped)
            && provenance::symbol_at_node(checker, init_unwrapped) == Some(entry_sym)
            && decl.name().kind() == Kind::ArrayBindingPattern
        {
            return Self::second_tuple_binding_identifier(decl.name());
        }
        None
    }

    fn second_tuple_binding_identifier(pattern: P<Node>) -> Option<P<Node>> {
        let &second = pattern.as_binding_pattern().elements().nodes().get(1)?;
        let elem = (second.kind() == Kind::BindingElement)
            .then(|| second.as_binding_element())
            .filter(|e| e.dot_dot_dot_token().is_none())?;
        elem.name().filter(|&n| ast::is_identifier(n))
    }

    fn is_broad_entry_value(
        value_ident: P<Node>,
        entries_arg: P<Node>,
        checker: &mut Checker,
    ) -> bool {
        let val_type = checker.get_type_at_location(value_ident);
        is_type_flag_set(val_type, TypeFlags::AnyOrUnknown)
            || shape::non_nullish_type_parts(val_type)
                .into_iter()
                .any(|part| is_type_flag_set(part, TypeFlags::AnyOrUnknown))
            || is_type_flag_set(
                checker.get_type_at_location(entries_arg),
                TypeFlags::AnyOrUnknown,
            )
    }

    fn count_shape_probes(
        node: P<Node>,
        checker: &mut Checker,
        value_sym: P<Symbol>,
        count: &mut usize,
    ) {
        if match node.kind() {
            Kind::BinaryExpression => Self::is_binary_shape_probe(node, checker, value_sym),
            Kind::CallExpression => Self::is_call_shape_probe(node, checker, value_sym),
            _ => false,
        } {
            *count += 1;
        }
        node.for_each_child(&mut |child| {
            if !tsrs_kernel::is_function_like(child) {
                Self::count_shape_probes(child, checker, value_sym, count);
            }
            false
        });
    }

    fn is_binary_shape_probe(node: P<Node>, checker: &mut Checker, value_sym: P<Symbol>) -> bool {
        let bin = node.as_binary_expression();
        let op = bin.operator_token().kind();
        let left = tsrs_kernel::unwrap_expression(bin.left());
        let right = tsrs_kernel::unwrap_expression(bin.right());
        match op {
            Kind::InKeyword => Self::is_symbol_ident(right, checker, value_sym),
            Kind::InstanceOfKeyword => Self::is_symbol_ident(left, checker, value_sym),
            Kind::EqualsEqualsEqualsToken
            | Kind::ExclamationEqualsEqualsToken
            | Kind::EqualsEqualsToken
            | Kind::ExclamationEqualsToken => {
                Self::is_typeof_or_nullish_check(left, right, checker, value_sym)
                    || Self::is_typeof_or_nullish_check(right, left, checker, value_sym)
            }
            _ => false,
        }
    }

    fn is_call_shape_probe(node: P<Node>, checker: &mut Checker, value_sym: P<Symbol>) -> bool {
        let call = node.as_call_expression();
        call.arguments().nodes().first().is_some_and(|&arg| {
            Self::is_symbol_ident(tsrs_kernel::unwrap_expression(arg), checker, value_sym)
        }) && Self::is_array_is_array_or_has_own(tsrs_kernel::unwrap_expression(call.expression()))
    }

    fn is_typeof_or_nullish_check(
        candidate: P<Node>,
        other: P<Node>,
        checker: &mut Checker,
        value_sym: P<Symbol>,
    ) -> bool {
        if candidate.kind() == Kind::TypeOfExpression {
            let operand =
                tsrs_kernel::unwrap_expression(candidate.as_type_of_expression().expression());
            return Self::is_symbol_ident(operand, checker, value_sym);
        }
        Self::is_symbol_ident(candidate, checker, value_sym)
            && (other.kind() == Kind::NullKeyword
                || (ast::is_identifier(other) && other.as_identifier().text() == "undefined"))
    }

    fn is_array_is_array_or_has_own(callee: P<Node>) -> bool {
        let Some((root, members)) = tsrs_kernel::static_member_chain(callee) else {
            return false;
        };
        if !ast::is_identifier(root) {
            return false;
        }
        let root_name = root.as_identifier().text();
        (root_name == "Array" && members.as_slice() == ["isArray"])
            || (root_name == "Object"
                && (members.as_slice() == ["hasOwn"]
                    || members.as_slice() == ["prototype", "hasOwnProperty", "call"]))
    }

    fn is_symbol_ident(node: P<Node>, checker: &mut Checker, target_sym: P<Symbol>) -> bool {
        ast::is_identifier(node) && provenance::symbol_at_node(checker, node) == Some(target_sym)
    }

    pub(super) fn is_discarded_decode_call(node: P<Node>, ctx: &mut Ctx) -> bool {
        let Some(stmt) = Self::enclosing_expression_statement(node) else {
            return false;
        };
        let (Some(scope), Some(arg_node)) = (
            tsrs_kernel::enclosing_function(node),
            Self::discarded_decode_arg(node, ctx),
        ) else {
            return false;
        };
        let targets = Self::raw_arg_targets(ctx.file, arg_node);
        !targets.is_empty() && Self::flows_to_sink_after(ctx.file, scope, stmt.end(), &targets)
    }

    fn enclosing_expression_statement(node: P<Node>) -> Option<P<Node>> {
        let mut curr = node;
        while let Some(parent) = curr.parent() {
            if !matches!(
                parent.kind(),
                Kind::ParenthesizedExpression | Kind::AwaitExpression
            ) {
                return (parent.kind() == Kind::ExpressionStatement).then_some(parent);
            }
            curr = parent;
        }
        None
    }

    fn discarded_decode_arg(node: P<Node>, ctx: &mut Ctx) -> Option<P<Node>> {
        if let Some(parts) = boundary::schema_validation_call_parts(node, ctx.checker) {
            let text = tsrs_kernel::node_text(ctx.file, parts.schema_node);
            return (parts.returns_schema_output
                && !text.contains(".passthrough(")
                && !text.contains(".strict("))
            .then_some(parts.arg_node);
        }
        let call = node.as_call_expression();
        let &[only_arg] = call.arguments().nodes() else {
            return None;
        };
        let callee = tsrs_kernel::unwrap_expression(call.expression());
        let name = match callee.kind() {
            Kind::Identifier => callee.as_identifier().text(),
            Kind::PropertyAccessExpression => {
                let prop = callee.as_property_access_expression().name();
                ast::is_identifier(prop).then(|| prop.as_identifier().text())?
            }
            _ => return None,
        };
        let is_named = name.starts_with("decode")
            || name.starts_with("parse")
            || name.ends_with("FromSnapshot")
            || name.ends_with("FromJson");
        let ret_type = is_named.then(|| ctx.checker.get_type_at_location(node))?;
        (!is_type_flag_set(
            ret_type,
            TypeFlags::Void | TypeFlags::Undefined | TypeFlags::BooleanLike,
        ))
        .then_some(only_arg)
    }

    fn raw_arg_targets(sf: P<SourceFile>, arg_node: P<Node>) -> Vec<&'static str> {
        let inner = tsrs_kernel::unwrap_expression(arg_node);
        if matches!(
            inner.kind(),
            Kind::Identifier | Kind::PropertyAccessExpression
        ) {
            let text = tsrs_kernel::node_text(sf, inner).trim();
            return (!text.is_empty()).then_some(vec![text]).unwrap_or_default();
        }
        if inner.kind() != Kind::ObjectLiteralExpression {
            return Vec::new();
        }
        inner
            .as_object_literal_expression()
            .properties()
            .nodes()
            .iter()
            .filter_map(|&p| {
                let init = (p.kind() == Kind::PropertyAssignment).then(|| {
                    tsrs_kernel::unwrap_expression(p.as_property_assignment().initializer())
                })?;
                matches!(
                    init.kind(),
                    Kind::Identifier | Kind::PropertyAccessExpression
                )
                .then(|| tsrs_kernel::node_text(sf, init).trim())
                .filter(|t| !t.is_empty())
            })
            .collect()
    }

    fn is_db_mutation_call(node: P<Node>) -> bool {
        let Some(callee) = (node.kind() == Kind::CallExpression)
            .then(|| tsrs_kernel::unwrap_expression(node.as_call_expression().expression()))
            .filter(|c| c.kind() == Kind::PropertyAccessExpression)
        else {
            return false;
        };
        let prop = callee.as_property_access_expression();
        if !ast::is_identifier(prop.name())
            || !matches!(prop.name().as_identifier().text(), "insert" | "patch")
        {
            return false;
        }
        let recv = tsrs_kernel::unwrap_expression(prop.expression());
        (ast::is_identifier(recv) && recv.as_identifier().text() == "db")
            || (recv.kind() == Kind::PropertyAccessExpression
                && ast::is_identifier(recv.as_property_access_expression().name())
                && recv
                    .as_property_access_expression()
                    .name()
                    .as_identifier()
                    .text()
                    == "db")
    }

    fn node_contains_target(sf: P<SourceFile>, node: P<Node>, targets: &[&str]) -> bool {
        if matches!(
            node.kind(),
            Kind::Identifier | Kind::PropertyAccessExpression
        ) && targets.contains(&tsrs_kernel::node_text(sf, node).trim())
        {
            return true;
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            if !found && !tsrs_kernel::is_function_like(child) {
                found = Self::node_contains_target(sf, child, targets);
            }
            found
        });
        found
    }

    fn flows_to_sink_after(
        sf: P<SourceFile>,
        node: P<Node>,
        after_pos: tsrs_core::TextPos,
        targets: &[&str],
    ) -> bool {
        if node.pos() >= after_pos
            && (node.kind() == Kind::ReturnStatement || Self::is_db_mutation_call(node))
            && Self::node_contains_target(sf, node, targets)
        {
            return true;
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            if !found && !tsrs_kernel::is_function_like(child) && child.end() > after_pos {
                found = Self::flows_to_sink_after(sf, child, after_pos, targets);
            }
            found
        });
        found
    }
}
