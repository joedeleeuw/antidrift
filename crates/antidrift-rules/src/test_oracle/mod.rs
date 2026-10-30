mod assertions;
mod bindings;
mod block;
mod classification;
mod dependencies;
mod lengths;
mod literals;
pub mod no_placeholder_tests;
pub mod no_redacted_log_attribute_key;
pub mod no_repo_state_mirror_assertion;
pub mod no_static_devtools_import;
mod paths;
mod repo_state_imports;
mod repo_state_path;
mod repo_state_taint;
mod response_shapes;
mod static_properties;
mod syntax;
mod validator_assertions;
mod validators;

use antidrift_kernel::file_role::{FileRole, ProjectPath};
use antidrift_kernel::rule_scope::RuleScope;
use rustc_hash::FxHashMap;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-nonindependent-test-oracle";

pub struct NoNonindependentTestOracle {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoNonindependentTestOracle = NoNonindependentTestOracle {
    scope: RuleScope::DEFAULT,
};

impl NoNonindependentTestOracle {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::ForOfStatement),
];

impl Rule for NoNonindependentTestOracle {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let file_name = ctx.file.file_name();
        let enabled = self.scope.matches(file_name, cwd);
        let path = ProjectPath::of(ctx.program, file_name);
        let test_file = enabled && syntax::is_test_file(&path);
        let spec_file = path.has_role(FileRole::TestOrSpec);
        let blocks = if test_file {
            block::collect_blocks(&bindings::Oracle { sf: ctx.file })
        } else {
            FxHashMap::default()
        };
        Box::new(Visitor {
            enabled,
            test_file,
            spec_file,
            blocks,
        })
    }
}

struct Visitor {
    enabled: bool,
    test_file: bool,
    spec_file: bool,
    blocks: FxHashMap<P<Node>, block::BlockFacts>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let oracle = bindings::Oracle { sf: ctx.file };
        match node.kind() {
            Kind::CallExpression if self.test_file => {
                let mut findings = Vec::new();
                analyze_call(node, &oracle, &self.blocks, &mut findings);
                for (target, finding) in findings {
                    let (id, message) = finding.details();
                    ctx.report_node(target, RuleMessage::new(id, message));
                }
            }
            Kind::ForOfStatement if self.spec_file && static_properties::is_echo(node, &oracle) => {
                let (id, message) = Finding::StaticPropertyEcho.details();
                ctx.report_node(node, RuleMessage::new(id, message));
            }
            _ => {}
        }
    }
}

#[must_use]
pub fn rules() -> Vec<&'static dyn Rule> {
    vec![
        &DEFAULT_RULE,
        &no_placeholder_tests::DEFAULT_RULE,
        &no_redacted_log_attribute_key::DEFAULT_RULE,
        &no_repo_state_mirror_assertion::DEFAULT_RULE,
        &no_static_devtools_import::DEFAULT_RULE,
    ]
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    match name {
        RULE_NAME | "no-nonindependent-test-oracle" => Ok(Some(Box::new(
            NoNonindependentTestOracle::from_options(options)?,
        ))),
        no_placeholder_tests::RULE_NAME | "no-placeholder-tests" => Ok(Some(Box::new(
            no_placeholder_tests::NoPlaceholderTests::from_options(options)?,
        ))),
        no_redacted_log_attribute_key::RULE_NAME | "no-redacted-log-attribute-key" => {
            Ok(Some(Box::new(
                no_redacted_log_attribute_key::NoRedactedLogAttributeKey::from_options(options)?,
            )))
        }
        no_repo_state_mirror_assertion::RULE_NAME | "no-repo-state-mirror-assertion" => {
            Ok(Some(Box::new(
                no_repo_state_mirror_assertion::NoRepoStateMirrorAssertion::from_options(options)?,
            )))
        }
        no_static_devtools_import::RULE_NAME | "no-static-devtools-import" => Ok(Some(Box::new(
            no_static_devtools_import::NoStaticDevtoolsImport::from_options(options)?,
        ))),
        _ => Ok(None),
    }
}

fn analyze_call(
    call_node: P<Node>,
    oracle: &bindings::Oracle,
    blocks: &FxHashMap<P<Node>, block::BlockFacts>,
    findings: &mut Vec<(P<Node>, Finding)>,
) {
    if let Some(finding) = validator_assertions::finding(call_node, oracle) {
        findings.push((call_node, finding));
    }
    if assertions::is_membership(call_node) {
        if !block::is_error_membership(call_node, oracle, blocks) {
            findings.push((call_node, Finding::NoBareMembership));
        }
        return;
    }
    if let Some(callback) = assertions::test_callback(call_node)
        && let Some(facts) = blocks.get(&callback.id())
    {
        findings.extend(block::analyze(facts, oracle));
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Finding {
    NoBareMembership,
    InputEcho,
    LengthEcho,
    OutcomeEcho,
    ErrorShapeEcho,
    ExistenceEcho,
    MockCallEcho,
    MockedResponseBodyOracle,
    StaticPropertyEcho,
    ValidatorOutputOracle,
    ValidatorThrowOracle,
}

impl Finding {
    const fn details(self) -> (&'static str, &'static str) {
        match self {
            Self::NoBareMembership => (
                "noBareMembership",
                "Do not make bare membership or key existence the test. Assert behavior, full output, or a real artifact instead.",
            ),
            Self::InputEcho => (
                "inputEcho",
                "This assertion restates the arranged input, so it only proves the dependency echoed data back. Assert transformed output, a captured artifact, or boundary behavior instead.",
            ),
            Self::LengthEcho => (
                "lengthEcho",
                "This length assertion restates the arranged collection size and proves no project transform or filter. Assert transformed contents or an independently derived count instead.",
            ),
            Self::OutcomeEcho => ("outcomeEcho", OUTCOME_MESSAGE),
            Self::ErrorShapeEcho => ("errorShapeEcho", OUTCOME_MESSAGE),
            Self::ExistenceEcho => (
                "existenceEcho",
                "This existence check is satisfied by the arranged value's construction and cannot fail. Assert real output instead.",
            ),
            Self::MockCallEcho => (
                "mockCallEcho",
                "This test only proves the mock received the argument the test itself passed. Assert output, state, or an effect beyond the mocked call.",
            ),
            Self::MockedResponseBodyOracle => (
                "mockedResponseBodyOracle",
                "This test asserts a response-body object shape supplied by a mock. Object-shape checks are candidates for deleting the entire test block, not for swapping schema.parse with direct equality. Keep the test only if it proves an independently owned effect. Tip: checking response-body or payload shapes is often a sign of a low-value test; assert behavior not supplied by the mock or remove the test.",
            ),
            Self::StaticPropertyEcho => (
                "staticPropertyEcho",
                "This loop restates hardcoded properties of one precomputed object. Exercise behavior for each case or assert a generated/public artifact instead.",
            ),
            Self::ValidatorOutputOracle => (
                "validatorOutputOracle",
                "This assertion checks validator output without an independent expected value. Assert application behavior against a value that does not come from the input or output.",
            ),
            Self::ValidatorThrowOracle => (
                "validatorThrowOracle",
                "This assertion only checks whether a validator accepts input. Assert application behavior or remove the test.",
            ),
        }
    }
}

const OUTCOME_MESSAGE: &str = "This assertion only inspects the outcome or error of an act on input the test arranged to fail. Assert the parsed value on the success path, or a downstream consumer's behavior — inspecting the validator's own error/flag proves nothing the arrangement didn't.";
