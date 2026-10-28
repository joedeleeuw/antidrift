use antidrift_kernel::{provenance, shape, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, Node, Symbol};
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
        if second.kind() != Kind::BindingElement {
            return None;
        }
        let elem = second.as_binding_element();
        if elem.dot_dot_dot_token().is_some() {
            return None;
        }
        let name = elem.name()?;
        ast::is_identifier(name).then_some(name)
    }

    fn is_broad_entry_value(
        value_ident: P<Node>,
        entries_arg: P<Node>,
        checker: &mut Checker,
    ) -> bool {
        let val_type = checker.get_type_at_location(value_ident);
        if is_type_flag_set(val_type, TypeFlags::AnyOrUnknown)
            || shape::non_nullish_type_parts(val_type)
                .into_iter()
                .any(|part| is_type_flag_set(part, TypeFlags::AnyOrUnknown))
        {
            return true;
        }
        let subj_type = checker.get_type_at_location(entries_arg);
        is_type_flag_set(subj_type, TypeFlags::AnyOrUnknown)
    }

    fn count_shape_probes(
        node: P<Node>,
        checker: &mut Checker,
        value_sym: P<Symbol>,
        count: &mut usize,
    ) {
        if Self::is_shape_probe_node(node, checker, value_sym) {
            *count += 1;
        }
        node.for_each_child(&mut |child| {
            if !tsrs_kernel::is_function_like(child) {
                Self::count_shape_probes(child, checker, value_sym, count);
            }
            false
        });
    }

    fn is_shape_probe_node(node: P<Node>, checker: &mut Checker, value_sym: P<Symbol>) -> bool {
        match node.kind() {
            Kind::BinaryExpression => Self::is_binary_shape_probe(node, checker, value_sym),
            Kind::CallExpression => Self::is_call_shape_probe(node, checker, value_sym),
            _ => false,
        }
    }

    fn is_binary_shape_probe(node: P<Node>, checker: &mut Checker, value_sym: P<Symbol>) -> bool {
        let bin = node.as_binary_expression();
        let op = bin.operator_token().kind();
        let left = tsrs_kernel::unwrap_expression(bin.left());
        let right = tsrs_kernel::unwrap_expression(bin.right());
        if op == Kind::InKeyword {
            return Self::is_symbol_ident(right, checker, value_sym);
        }
        if op == Kind::InstanceOfKeyword {
            return Self::is_symbol_ident(left, checker, value_sym);
        }
        matches!(
            op,
            Kind::EqualsEqualsEqualsToken
                | Kind::ExclamationEqualsEqualsToken
                | Kind::EqualsEqualsToken
                | Kind::ExclamationEqualsToken
        ) && (Self::is_typeof_or_nullish_check(left, right, checker, value_sym)
            || Self::is_typeof_or_nullish_check(right, left, checker, value_sym))
    }

    fn is_call_shape_probe(node: P<Node>, checker: &mut Checker, value_sym: P<Symbol>) -> bool {
        let call = node.as_call_expression();
        let Some(&first_arg) = call.arguments().nodes().first() else {
            return false;
        };
        if !Self::is_symbol_ident(
            tsrs_kernel::unwrap_expression(first_arg),
            checker,
            value_sym,
        ) {
            return false;
        }
        let callee = tsrs_kernel::unwrap_expression(call.expression());
        Self::is_array_is_array_or_has_own(callee)
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
}
