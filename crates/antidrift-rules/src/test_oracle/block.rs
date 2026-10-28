use super::Finding;
use super::assertions::{Assertion, test_callback};
use super::bindings::{Callback, Oracle};
use super::classification;
use super::lengths;
use super::response_shapes::{self, Shape};
use super::syntax::{Span, identifier, literal_container, unwrap};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

pub(super) struct BlockFacts {
    pub callback: Callback,
    pub assertions: Vec<Assertion>,
    pub bindings: FxHashMap<&'static str, P<Node>>,
    pub argument_names: FxHashSet<&'static str>,
    pub argument_literals: Vec<P<Node>>,
    pub mocked_shapes: Vec<Shape>,
}

impl BlockFacts {
    pub(super) fn collect(callback: Callback, oracle: &Oracle) -> Self {
        let mut facts = Self {
            callback,
            assertions: Vec::new(),
            bindings: FxHashMap::default(),
            argument_names: FxHashSet::default(),
            argument_literals: Vec::new(),
            mocked_shapes: Vec::new(),
        };
        let mut collector = BlockCollector::default();
        if let Some(expression) = callback.expression_body() {
            collector.visit_node(expression);
        } else if let Some(body) = callback.body() {
            collector.visit_node(body);
        }
        facts.bindings = collector.bindings;
        facts.collect_calls(&collector.calls, oracle);
        facts
    }

    fn collect_calls(&mut self, calls: &[P<Node>], oracle: &Oracle) {
        let mut assertion_calls = FxHashSet::default();
        for &call in calls {
            if let Some(record) = Assertion::parse(call) {
                assertion_calls.insert(Span::of(oracle.sf, call).start);
                assertion_calls.extend(record.expect_call.map(|ec| Span::of(oracle.sf, ec).start));
                self.assertions.push(record);
            }
            if oracle.owner(call) == Some(self.callback.id())
                && let Some(shape) = response_shapes::mock_shape(call, self.callback, oracle)
            {
                self.mocked_shapes.push(shape);
            }
        }
        for &call in calls {
            if assertion_calls.contains(&Span::of(oracle.sf, call).start) {
                continue;
            }
            self.collect_call_arguments(call);
        }
    }

    fn collect_call_arguments(&mut self, call: P<Node>) {
        for &argument in call.as_call_expression().arguments().nodes() {
            if argument.kind() != Kind::SpreadElement {
                self.collect_argument(argument);
            }
        }
    }

    fn collect_argument(&mut self, argument: P<Node>) {
        let expression = unwrap(argument);
        if let Some(ident) = identifier(expression) {
            self.argument_names.insert(ident.as_identifier().text());
        } else if literal_container(expression) {
            self.argument_literals.push(expression);
        }
    }
}

#[derive(Default)]
struct BlockCollector {
    calls: Vec<P<Node>>,
    bindings: FxHashMap<&'static str, P<Node>>,
}

impl BlockCollector {
    fn visit_node(&mut self, node: P<Node>) {
        match node.kind() {
            Kind::CallExpression => {
                if test_callback(node).is_some() {
                    return;
                }
                self.calls.push(node);
            }
            Kind::VariableDeclaration => {
                if let Some(name) = node.name()
                    && ast::is_identifier(name)
                    && let Some(init) = node.as_variable_declaration().initializer()
                {
                    self.bindings.insert(name.as_identifier().text(), init);
                }
            }
            _ => {}
        }
        node.for_each_child(&mut |child| {
            self.visit_node(child);
            false
        });
    }
}

pub(super) fn collect_blocks(oracle: &Oracle) -> FxHashMap<P<Node>, BlockFacts> {
    let mut blocks = FxHashMap::default();
    collect_blocks_walk(oracle.sf.as_node(), oracle, &mut blocks);
    blocks
}

fn collect_blocks_walk(node: P<Node>, oracle: &Oracle, out: &mut FxHashMap<P<Node>, BlockFacts>) {
    if node.kind() == Kind::CallExpression
        && let Some(callback) = test_callback(node)
    {
        out.insert(callback.id(), BlockFacts::collect(callback, oracle));
    }
    node.for_each_child(&mut |child| {
        collect_blocks_walk(child, oracle, out);
        false
    });
}

pub(super) fn analyze(facts: &BlockFacts, oracle: &Oracle) -> Vec<(P<Node>, Finding)> {
    let classifications: Vec<_> = facts
        .assertions
        .iter()
        .map(|record| classification::classify(record, facts, oracle))
        .collect();
    facts
        .assertions
        .iter()
        .zip(&classifications)
        .filter_map(|(record, classification)| {
            let finding = classification.finding?;
            if finding == Finding::LengthEcho
                && lengths::has_contents_oracle(record, facts, &classifications, oracle)
            {
                return None;
            }
            Some((record.call, finding))
        })
        .collect()
}

pub(super) fn is_error_membership(
    call: P<Node>,
    oracle: &Oracle,
    blocks: &FxHashMap<P<Node>, BlockFacts>,
) -> bool {
    let mut callback = None;
    let mut cursor = call.parent();
    while let Some(ancestor) = cursor {
        if ancestor.kind() == Kind::CallExpression
            && let Some(found) = test_callback(ancestor)
        {
            callback = Some(found);
            break;
        }
        cursor = ancestor.parent();
    }
    let Some(callback) = callback else {
        return false;
    };
    let Some(record) = Assertion::parse(call) else {
        return false;
    };
    blocks
        .get(&callback.id())
        .is_some_and(|facts| classification::error_shape(&record, facts, oracle))
}
