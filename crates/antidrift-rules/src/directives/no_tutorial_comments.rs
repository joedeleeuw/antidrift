use super::no_default_export_in_domain::is_fixture_or_docs_file;
use antidrift_kernel::directives::{scan_source_comments, split_identifier_words};
use antidrift_kernel::rule_scope::RuleScope;
use antidrift_kernel::tsrs_kernel::is_test_or_spec_file;
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
            && !is_test_or_spec_file(&filename)
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
            let message = if is_tutorial_comment(comment.raw_content) {
                RuleMessage::new(
                    "tutorial",
                    "Tutorial-style explanatory comment detected. Remove the narration and keep the code direct.",
                )
            } else if !comment.is_block && is_section_divider(comment.text) {
                RuleMessage::new(
                    "sectionDivider",
                    "ASCII section-divider banner detected. Delete the banner; split the file along the seam it marks instead.",
                )
            } else {
                continue;
            };
            ctx.report_range(comment.pos, comment.end, message);
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

const DIVIDER_CHARS: &[char] = &['=', '-', '*', '~'];
const HEADER_WORDS: &[&str] = &["copyright", "license", "spdx"];

fn divider_run(mut chars: impl Iterator<Item = char>) -> usize {
    let Some(first) = chars.next().filter(|ch| DIVIDER_CHARS.contains(ch)) else {
        return 0;
    };
    1 + chars.take_while(|&ch| ch == first).count()
}

fn is_section_divider(text: &str) -> bool {
    if text.is_empty() || text.starts_with('/') || text.contains("://") || text.contains('|') {
        return false;
    }
    let lowered = text.to_ascii_lowercase();
    if HEADER_WORDS.iter().any(|word| lowered.contains(word)) {
        return false;
    }
    let divider_count = text.chars().filter(|ch| DIVIDER_CHARS.contains(ch)).count();
    if text
        .chars()
        .all(|ch| DIVIDER_CHARS.contains(&ch) || ch.is_whitespace())
    {
        return divider_count >= 8;
    }
    let (lead, trail) = (divider_run(text.chars()), divider_run(text.chars().rev()));
    if lead < 3 || trail < 3 {
        return false;
    }
    let label = text.get(lead..text.len() - trail).map_or("", str::trim);
    !label.is_empty() && label.len() <= 48 && !label.starts_with(DIVIDER_CHARS)
}
