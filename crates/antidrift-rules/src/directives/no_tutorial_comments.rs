use super::no_default_export_in_domain::{is_fixture_or_docs_file, is_test_filename};
use antidrift_kernel::directives::scan_source_comments;
use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-tutorial-comments";

const LEAD_WORDS: &[&str] = &["this", "here", "we"];
const VERB_WORDS: &[&str] = &[
    "check",
    "checks",
    "ensure",
    "ensures",
    "handle",
    "handles",
    "return",
    "returns",
    "get",
    "gets",
    "set",
    "sets",
    "does",
    "validate",
    "validates",
];

pub struct NoTutorialComments {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoTutorialComments = NoTutorialComments {
    scope: RuleScope::DEFAULT,
};

impl NoTutorialComments {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];

impl Rule for NoTutorialComments {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let filename = ctx.file.file_name().replace('\\', "/");
        let enabled = self.scope.matches(&filename, cwd)
            && !is_test_filename(&filename)
            && !is_fixture_or_docs_file(&filename);
        Box::new(Visitor { enabled })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
        for comment in scan_source_comments(ctx.file.text()) {
            if is_tutorial_comment(comment.raw_content) {
                ctx.report_range(
                    comment.pos,
                    comment.end,
                    RuleMessage::new(
                        "tutorial",
                        "Tutorial-style explanatory comment detected. Remove the narration and keep the code direct.",
                    ),
                );
            }
        }
    }
}

fn is_tutorial_comment(text: &str) -> bool {
    let trimmed = text.trim_start();
    let Some(first_line) = trimmed.lines().next() else {
        return false;
    };
    let words: Vec<String> = split_identifier_words(first_line);
    let Some(first_word) = words.first() else {
        return false;
    };
    if !LEAD_WORDS.contains(&first_word.as_str()) {
        return false;
    }
    words
        .iter()
        .skip(1)
        .any(|word| VERB_WORDS.contains(&word.as_str()))
}

pub(super) fn split_identifier_words(text: &str) -> Vec<String> {
    let mut normalized = String::with_capacity(text.len() + 8);
    let mut prev: Option<char> = None;
    for ch in text.chars() {
        if !ch.is_ascii_alphanumeric() {
            normalized.push(' ');
            prev = Some(ch);
            continue;
        }
        if let Some(prev_ch) = prev
            && (prev_ch.is_ascii_lowercase() || prev_ch.is_ascii_digit())
            && ch.is_ascii_uppercase()
        {
            normalized.push(' ');
        }
        normalized.push(ch.to_ascii_lowercase());
        prev = Some(ch);
    }
    normalized.split_whitespace().map(str::to_owned).collect()
}
