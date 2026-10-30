use super::bindings::{Callback, Oracle};
use super::syntax::{
    Span, expression_key, identifier_of, numeric_literal_value, object_property, static_member,
    unwrap_awaited_expression,
};
use antidrift_kernel::local_binding::{
    Binding, collect_binding_references, is_identifier_reference_position, resolve_lexical_binding,
};
use antidrift_kernel::tsrs_kernel::cooked_text;
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

#[derive(PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Identity {
    String(String),
    Number(u64),
    Boolean(bool),
    Null,
    BigInt(String),
    Array(Vec<Identity>),
    Object(Vec<(String, Identity)>),
}

fn identity(
    expression: P<Node>,
    oracle: &Oracle,
    ancestors: &FxHashSet<(i32, i32)>,
) -> Option<Identity> {
    let expression = unwrap_awaited_expression(expression);
    let mut seen = ancestors.clone();
    if !seen.insert(expression_key(oracle.sf, expression)) {
        return None;
    }
    match expression.kind() {
        Kind::Identifier => identity(oracle.initializer(expression, true)?, oracle, &seen),
        Kind::StringLiteral => {
            cooked_text(expression).map(|text| Identity::String(text.to_owned()))
        }
        Kind::NumericLiteral => Some(Identity::Number(
            numeric_literal_value(expression)?.to_bits(),
        )),
        Kind::TrueKeyword => Some(Identity::Boolean(true)),
        Kind::FalseKeyword => Some(Identity::Boolean(false)),
        Kind::NullKeyword => Some(Identity::Null),
        Kind::BigIntLiteral => Some(Identity::BigInt(
            expression
                .as_big_int_literal()
                .text()
                .trim_end_matches('n')
                .to_owned(),
        )),
        Kind::PrefixUnaryExpression => {
            let unary = expression.as_prefix_unary_expression();
            let val = numeric_literal_value(unary.operand())?;
            match unary.operator() {
                Kind::MinusToken => Some(Identity::Number((-val).to_bits())),
                Kind::PlusToken => Some(Identity::Number(val.to_bits())),
                _ => None,
            }
        }
        Kind::ArrayLiteralExpression => Some(Identity::Array(
            expression
                .as_array_literal_expression()
                .elements()
                .nodes()
                .iter()
                .copied()
                .map(|elem| {
                    if matches!(elem.kind(), Kind::SpreadElement | Kind::OmittedExpression) {
                        return None;
                    }
                    identity(elem, oracle, &seen)
                })
                .collect::<Option<Vec<_>>>()?,
        )),
        Kind::ObjectLiteralExpression => {
            let mut properties = std::collections::BTreeMap::new();
            for &prop in expression
                .as_object_literal_expression()
                .properties()
                .nodes()
            {
                let (name, value, _) = object_property(prop)?;
                properties.insert(name, identity(value, oracle, &seen)?);
            }
            Some(Identity::Object(properties.into_iter().collect()))
        }
        _ => None,
    }
}

#[derive(Default)]
struct Dependencies {
    nodes: FxHashSet<(i32, i32)>,
    symbols: FxHashSet<Binding>,
    calls: Vec<P<Node>>,
}

struct DependencyWalker<'o> {
    oracle: &'o Oracle,
    dependencies: Dependencies,
}

impl DependencyWalker<'_> {
    fn binding(&mut self, ident: P<Node>) {
        let Some(binding) = resolve_lexical_binding(ident) else {
            return;
        };
        if !self.dependencies.symbols.insert(binding) {
            return;
        }
        match binding.decl.kind() {
            Kind::VariableDeclaration => {
                if let Some(initializer) = binding.decl.as_variable_declaration().initializer() {
                    self.visit_expression(initializer);
                }
                if let Some(list) = binding.decl.parent()
                    && let Some(for_of) = list.parent()
                    && for_of.kind() == Kind::ForOfStatement
                {
                    self.visit_expression(for_of.as_for_in_or_of_statement().expression());
                }
            }
            Kind::FunctionDeclaration => {
                if let Some(body) = binding.decl.body() {
                    self.visit_subtree(body);
                }
            }
            _ => {}
        }
        for reference in collect_binding_references(self.oracle.sf.as_node(), binding) {
            self.mutation(reference);
        }
    }

    fn mutation(&mut self, node: P<Node>) {
        let mut target_span = Span::of(self.oracle.sf, node);
        let mut cursor = node.parent();
        while let Some(ancestor) = cursor {
            match ancestor.kind() {
                Kind::PropertyAccessExpression
                    if Span::of(
                        self.oracle.sf,
                        ancestor.as_property_access_expression().expression(),
                    ) == target_span =>
                {
                    target_span = Span::of(self.oracle.sf, ancestor);
                }
                Kind::ElementAccessExpression
                    if Span::of(
                        self.oracle.sf,
                        ancestor.as_element_access_expression().expression(),
                    ) == target_span =>
                {
                    target_span = Span::of(self.oracle.sf, ancestor);
                }
                Kind::BinaryExpression => {
                    self.visit_binary_assignment(ancestor, target_span);
                    break;
                }
                Kind::CallExpression => {
                    self.mutation_call(ancestor, target_span);
                    break;
                }
                _ => break,
            }
            cursor = ancestor.parent();
        }
    }

    fn visit_binary_assignment(&mut self, ancestor: P<Node>, target_span: Span) {
        let bin = ancestor.as_binary_expression();
        if ast::is_assignment_operator(bin.operator_token().kind())
            && Span::of(self.oracle.sf, bin.left()) == target_span
        {
            self.visit_expression(bin.right());
        }
    }

    fn mutation_call(&mut self, call_node: P<Node>, target: Span) {
        let call = call_node.as_call_expression();
        let mut arguments = call
            .arguments()
            .nodes()
            .iter()
            .copied()
            .filter(|arg| arg.kind() != Kind::SpreadElement);
        let callee = call.expression();
        let Some((object, method)) = static_member(callee) else {
            return;
        };
        let mutates = Span::of(self.oracle.sf, callee) == target
            && matches!(
                method.as_str(),
                "push" | "unshift" | "splice" | "fill" | "set" | "add"
            );
        let assigns = method == "assign"
            && identifier_of(object).is_some_and(|ident| ident.as_identifier().text() == "Object")
            && arguments
                .next()
                .is_some_and(|argument| Span::of(self.oracle.sf, argument) == target);
        if mutates || assigns {
            for argument in arguments {
                self.visit_expression(argument);
            }
        }
    }

    fn callee(&mut self, expression: P<Node>) {
        let callee = unwrap_awaited_expression(expression);
        match callee.kind() {
            Kind::PropertyAccessExpression => {
                self.visit_expression(callee.as_property_access_expression().expression());
            }
            Kind::ElementAccessExpression => {
                let elem = callee.as_element_access_expression();
                self.visit_expression(elem.expression());
                self.visit_expression(elem.argument_expression());
            }
            _ => {
                if let Some(callback) = self.oracle.local_function(callee) {
                    self.callback(callback);
                }
            }
        }
    }

    fn callback(&mut self, callback: Callback) {
        let span = callback.span(self.oracle.sf);
        if !self.dependencies.nodes.insert((span.start, span.end)) {
            return;
        }
        if let Some(expression) = callback.expression_body() {
            self.visit_expression(expression);
        } else if let Some(body) = callback.body() {
            self.visit_subtree(body);
        }
    }

    fn visit_expression(&mut self, expression: P<Node>) {
        let expression = unwrap_awaited_expression(expression);
        if !self
            .dependencies
            .nodes
            .insert(expression_key(self.oracle.sf, expression))
        {
            return;
        }
        if matches!(
            expression.kind(),
            Kind::CallExpression | Kind::NewExpression
        ) {
            self.dependencies.calls.push(expression);
        }
        self.visit_node_contents(expression);
    }

    fn visit_subtree(&mut self, node: P<Node>) {
        if ast::is_expression(node) {
            self.visit_expression(node);
            return;
        }
        self.visit_node_contents(node);
    }

    fn visit_node_contents(&mut self, node: P<Node>) {
        match node.kind() {
            Kind::Identifier if is_identifier_reference_position(node) => {
                self.binding(node);
            }
            Kind::CallExpression => {
                let call = node.as_call_expression();
                for &argument in call.arguments().nodes() {
                    self.visit_subtree(argument);
                }
                self.callee(call.expression());
            }
            Kind::NewExpression => {
                let call = node.as_new_expression();
                for &argument in call.arguments().map_or(&[][..], |args| args.nodes()) {
                    self.visit_subtree(argument);
                }
                self.callee(call.expression());
            }
            _ => {
                node.for_each_child(&mut |child| {
                    self.visit_subtree(child);
                    false
                });
            }
        }
    }
}

fn dependencies(expressions: &[P<Node>], oracle: &Oracle) -> Dependencies {
    let mut walker = DependencyWalker {
        oracle,
        dependencies: Dependencies::default(),
    };
    for &expression in expressions {
        walker.visit_expression(expression);
    }
    walker.dependencies
}

pub(super) fn independent(inputs: &[P<Node>], expected: &[P<Node>], oracle: &Oracle) -> bool {
    let actual = dependencies(inputs, oracle);
    let mut literal_inputs = FxHashSet::default();
    let ancestors = FxHashSet::default();
    for &input in inputs {
        if let Some(id) = identity(input, oracle, &ancestors) {
            literal_inputs.insert(id);
        }
    }
    for &call_node in &actual.calls {
        let arguments: &[P<Node>] = match call_node.kind() {
            Kind::CallExpression => call_node.as_call_expression().arguments().nodes(),
            Kind::NewExpression => call_node
                .as_new_expression()
                .arguments()
                .map_or(&[], |args| args.nodes()),
            _ => continue,
        };
        for &argument in arguments {
            if argument.kind() != Kind::SpreadElement
                && let Some(id) = identity(argument, oracle, &ancestors)
            {
                literal_inputs.insert(id);
            }
        }
    }
    expected.iter().all(|&expected_node| {
        if identity(expected_node, oracle, &ancestors)
            .is_some_and(|id| literal_inputs.contains(&id))
        {
            return false;
        }
        let expected_deps = dependencies(&[expected_node], oracle);
        expected_deps.nodes.is_disjoint(&actual.nodes)
            && expected_deps.symbols.is_disjoint(&actual.symbols)
    })
}
