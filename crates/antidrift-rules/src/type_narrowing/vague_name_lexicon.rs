use antidrift_kernel::directives::split_identifier_words;

const VAGUE_NOUNS: &[&str] = &[
    "data",
    "info",
    "value",
    "values",
    "val",
    "vals",
    "obj",
    "objects",
    "objs",
    "thing",
    "things",
    "stuff",
    "temp",
    "tmp",
    "foo",
    "bar",
    "baz",
    "res",
    "ret",
    "retval",
    "misc",
    "result",
    "results",
    "item",
    "items",
    "var",
    "vars",
    "variable",
    "content",
    "contents",
    "param",
    "params",
    "parameters",
    "arr",
    "spam",
    "ham",
    "toto",
    "tutu",
    "tata",
];

const EXEMPT_TEMP_TAILS: &[&str] = &[
    "dir",
    "dirs",
    "directory",
    "directorys",
    "file",
    "files",
    "path",
    "paths",
    "root",
    "roots",
    "base",
    "bases",
    "home",
    "homes",
];

const FILLER_SUFFIXES: &[&str] = &[
    "Value", "Data", "Info", "Obj", "Object", "Thing", "Stuff", "_value", "_data", "_info", "_obj",
    "_object", "_thing", "_stuff",
];

const FILLER_PREFIXES: &[&str] = &["my", "the", "some", "temp", "tmp"];

fn is_exempt_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "formdata"
            | "imagedata"
            | "defaultvalue"
            | "initialvalue"
            | "tovalue"
            | "fromvalue"
            | "currentvalue"
            | "previousvalue"
            | "prevvalue"
            | "nextvalue"
            | "returnvalue"
            | "modelvalue"
            | "rawvalue"
    ) {
        return true;
    }
    ["temp_", "temp", "tmp_", "tmp"].iter().any(|prefix| {
        lower
            .strip_prefix(prefix)
            .is_some_and(|tail| EXEMPT_TEMP_TAILS.contains(&tail))
    })
}

fn abbreviation_expansion(name: &str) -> Option<&'static str> {
    let base = name.trim_end_matches(|ch: char| ch.is_ascii_digit());
    if base.is_empty() || !base.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return None;
    }
    match base {
        "cb" => Some("callback"),
        "ctx" => Some("context"),
        "el" => Some("element"),
        "err" => Some("error"),
        "evt" => Some("event"),
        "fn" => Some("function"),
        "msg" => Some("message"),
        "opts" => Some("options"),
        "props" => Some("properties"),
        "req" => Some("request"),
        "str" => Some("string"),
        _ => None,
    }
}

fn is_single_letter_vague(name: &str) -> bool {
    if name.len() != 1 {
        return false;
    }
    let byte = name.as_bytes()[0];
    byte.is_ascii_alphabetic()
        && !matches!(
            byte.to_ascii_lowercase(),
            b'i' | b'j' | b'k' | b'n' | b'x' | b'y' | b'z'
        )
}

fn has_filler_suffix(name: &str) -> bool {
    name.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && FILLER_SUFFIXES
            .iter()
            .any(|suffix| name.len() > suffix.len() && name.ends_with(suffix))
}

fn has_filler_prefix(name: &str) -> bool {
    FILLER_PREFIXES.iter().any(|prefix| {
        name.strip_prefix(prefix)
            .and_then(|rest| rest.as_bytes().first())
            .is_some_and(|&first| first.is_ascii_uppercase() || first == b'_')
    })
}

pub(super) fn vague_reason(name: &str) -> Option<String> {
    if is_exempt_name(name) {
        return None;
    }
    let stem = name.trim_end_matches(|ch: char| ch.is_ascii_digit());
    if !stem.is_empty() && VAGUE_NOUNS.contains(&stem.to_ascii_lowercase().as_str()) {
        return Some("a vague noun".to_owned());
    }
    if let Some(full) = abbreviation_expansion(name) {
        return Some(format!("an abbreviation of '{full}'"));
    }
    if is_single_letter_vague(name) {
        return Some("a single letter".to_owned());
    }
    if has_filler_suffix(name) {
        return Some("a filler suffix".to_owned());
    }
    has_filler_prefix(name).then(|| "a filler prefix".to_owned())
}

pub(super) fn duplicate_context_word(name: &str) -> Option<String> {
    let words = split_identifier_words(name);
    words
        .windows(2)
        .find(|pair| !pair[0].is_empty() && pair[0] == pair[1])
        .map(|pair| pair[1].clone())
}
