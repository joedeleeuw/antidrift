use antidrift_kernel::tsrs_kernel::cooked_text;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

const BEFORE_KEYWORDS: &str =
    "FROM|JOIN|UPDATE|INTO|TABLE|WHERE|AND|OR|IN|VALUES|SET|ON|LIKE|ORDER BY|GROUP BY|PARTITION BY";

const AFTER_KEYWORDS: &str =
    "AND|OR|WHERE|FROM|JOIN|ORDER BY|GROUP BY|PARTITION BY|LIMIT|OFFSET|HAVING|SET|VALUES|IN";

const IDENTIFIER_CONTEXT_KEYWORDS: &str =
    "ORDER BY|GROUP BY|PARTITION BY|FROM|JOIN|UPDATE|INTO|TABLE";

pub(super) fn is_sql_identifier_context(before: &str, after: &str) -> bool {
    let norm_before = normalized_sql_context(before);
    IDENTIFIER_CONTEXT_KEYWORDS
        .split('|')
        .any(|kw| norm_before == kw || norm_before.ends_with(&format!(" {kw}")))
        || after.trim_start().starts_with('=')
}

pub(super) fn is_sql_interpolation_context(before: &str, after: &str) -> bool {
    let trimmed_before = before
        .trim_end()
        .strip_suffix(['\'', '"', '`'])
        .map_or_else(|| before.trim_end(), str::trim_end);
    let norm_before = normalized_sql_context(trimmed_before);
    let ends_kw = BEFORE_KEYWORDS.split('|').any(|kw| {
        norm_before == kw
            || norm_before.ends_with(&format!(" {kw}"))
            || norm_before.ends_with(&format!(" {kw} ("))
    });
    let has_stmt_ctx = norm_before.split_whitespace().any(|tok| {
        matches!(
            tok,
            "SELECT" | "FROM" | "JOIN" | "WHERE" | "VALUES" | "UPDATE" | "INSERT" | "DELETE"
        )
    });
    let ends_op = has_stmt_ctx
        && ["=", "(", ","]
            .iter()
            .any(|op| trimmed_before.ends_with(op));
    let trimmed_after = after
        .trim_start()
        .strip_prefix(['\'', '"', '`'])
        .map_or_else(|| after.trim_start(), str::trim_start);
    let norm_after = normalized_sql_context(trimmed_after);
    let starts_kw = norm_after.starts_with(')')
        || norm_after.starts_with(',')
        || AFTER_KEYWORDS
            .split('|')
            .any(|kw| norm_after == kw || norm_after.starts_with(&format!("{kw} ")));
    ends_kw || ends_op || starts_kw
}

pub(super) fn normalized_sql_context(text: &str) -> String {
    text.split_whitespace()
        .map(str::to_ascii_uppercase)
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn is_static_string(node: P<Node>) -> bool {
    matches!(
        node.kind(),
        Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral
    )
}

pub(super) fn static_string_text(node: P<Node>) -> Option<String> {
    is_static_string(node)
        .then_some(node)
        .and_then(cooked_text)
        .map(str::to_owned)
}

pub(super) fn combined_template_text(template_node: P<Node>) -> Option<String> {
    let template = template_node.as_template_expression();
    let mut out = String::from(cooked_text(template.head)?);
    for &span in template.template_spans.nodes() {
        out.push(' ');
        out.push_str(cooked_text(span.as_template_span().literal)?);
    }
    Some(out)
}

pub(super) fn is_sql_statement(text: &str) -> bool {
    let tokens: Vec<String> = text
        .split(|ch: char| !ch.is_ascii_alphabetic())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    let Some(first) = tokens.first().map(String::as_str) else {
        return false;
    };
    let adj = |a: &str, b: &str| tokens.windows(2).any(|w| w[0] == a && w[1] == b);
    (matches!(first, "select" | "with")
        && tokens
            .iter()
            .position(|tok| tok == "select")
            .is_some_and(|pos| tokens[pos + 1..].iter().any(|tok| tok == "from")))
        || (first == "update" && tokens.iter().skip(2).take(2).any(|tok| tok == "set"))
        || (matches!(first, "insert" | "replace") && adj(first, "into"))
        || (first == "delete" && adj("delete", "from"))
        || ["create", "alter", "drop"]
            .iter()
            .any(|op| adj(op, "table"))
}
