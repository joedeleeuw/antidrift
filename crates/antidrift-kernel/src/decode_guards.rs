const SNIFFER_PREFIXES: &[&str] = &["try", "sniff", "probe", "extract", "detect", "maybe"];

const LINE_CHUNK_IDENTIFIERS: &[&str] = &["line", "chunk", "candidate", "trimmed"];

const SNIFFED_TEXT_IDENTIFIERS: &[&str] = &["raw", "text"];

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
pub fn is_sniffed_text_identifier(name: &str) -> bool {
    SNIFFED_TEXT_IDENTIFIERS.contains(&name)
}

#[must_use]
pub fn is_parser_module_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    PARSER_MODULE_STEMS.iter().any(|stem| lower.contains(stem))
}

const VALUE_SPACE_SCHEMA_CONSTRUCTORS: &[&str] = &[
    "string",
    "number",
    "boolean",
    "bigint",
    "symbol",
    "null",
    "undefined",
    "literal",
    "enum",
    "nativeEnum",
    "picklist",
];

const KIND_TAGGED_SCHEMA_CONSTRUCTORS: &[&str] = &["discriminatedUnion", "variant"];

const OPTIONALITY_SCHEMA_METHODS: &[&str] =
    &["optional", "nullable", "nullish", "default", "catch"];

#[must_use]
pub fn is_value_space_schema_constructor(name: &str) -> bool {
    VALUE_SPACE_SCHEMA_CONSTRUCTORS.contains(&name)
}

#[must_use]
pub fn is_kind_tagged_schema_constructor(name: &str) -> bool {
    KIND_TAGGED_SCHEMA_CONSTRUCTORS.contains(&name)
}

#[must_use]
pub fn is_optionality_schema_method(name: &str) -> bool {
    OPTIONALITY_SCHEMA_METHODS.contains(&name)
}
