const SNIFFER_PREFIXES: &[&str] = &["try", "sniff", "probe", "extract", "detect", "maybe"];

const LINE_CHUNK_IDENTIFIERS: &[&str] = &["line", "raw", "text", "chunk", "candidate", "trimmed"];

const PARSER_MODULE_STEMS: &[&str] = &["parser", "grammar", "tool_call", "toolcall", "tool-call"];

#[must_use]
pub fn is_sniffer_function_name(name: &str) -> bool {
    SNIFFER_PREFIXES.iter().any(|prefix| {
        name.len() > prefix.len()
            && name
                .get(..prefix.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
            && name[prefix.len()..]
                .chars()
                .next()
                .is_some_and(|next| next == '_' || next.is_ascii_uppercase())
    })
}

#[must_use]
pub fn is_line_chunk_identifier(name: &str) -> bool {
    LINE_CHUNK_IDENTIFIERS.contains(&name)
}

#[must_use]
pub fn is_parser_module_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    PARSER_MODULE_STEMS.iter().any(|stem| lower.contains(stem))
}
