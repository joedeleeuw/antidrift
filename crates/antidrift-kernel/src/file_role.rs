use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::thread::LocalKey;

use tsrs_compiler::Program;
use tsrs_core::tspath;

use crate::program_fact::{ProgramFact, ProgramFactSlot};
use crate::provenance::relative_to_cwd;
use crate::registries::PolicyRegistries;
use crate::span_index::{split_ecma_lines, split_first_line};

const GENERATED_DIRS: &[&str] = &["__generated__", "generated", "_generated"];
const GENERATED_STEM_SUFFIXES: &[&str] = &[".gen", ".generated", ".pb"];

struct ProgramRegistries(PolicyRegistries);

thread_local! {
    static REGISTRIES_SLOT: ProgramFactSlot<ProgramRegistries> = const { RefCell::new(None) };
}

fn resolve_program_registry_root(program: &Program) -> PathBuf {
    let cwd = program.host().get_current_directory();
    for &sf in program.get_source_files() {
        if program.is_lib_file(sf) || program.is_source_file_from_external_library(sf) {
            continue;
        }
        let name = sf.file_name();
        if name.is_empty() || name.starts_with('<') || name.contains("/node_modules/") {
            continue;
        }
        let path = Path::new(name);
        let full = if path.is_absolute() {
            path.to_path_buf()
        } else {
            Path::new(cwd).join(path)
        };
        if let Some(parent) = full.parent() {
            return parent.to_path_buf();
        }
    }
    PathBuf::from(cwd)
}

impl ProgramFact for ProgramRegistries {
    fn slot() -> &'static LocalKey<ProgramFactSlot<Self>> {
        &REGISTRIES_SLOT
    }

    fn build(program: &Program) -> Self {
        let root = resolve_program_registry_root(program);
        match PolicyRegistries::load_from_repo(&root) {
            Ok(registries) => Self(registries),
            Err(err) => {
                eprintln!("antidrift-linter: {err}");
                std::process::exit(2);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FileRole {
    TestOrSpec,
    TestSupport,
    Docs,
    Example,
    EndToEnd,
    Story,
    Boundary,
    Domain,
    ScriptEntry,
    Shared,
}

pub const TEST_ROLES: &[FileRole] = &[FileRole::TestOrSpec, FileRole::TestSupport];

struct RolePattern {
    dirs: &'static [&'static str],
    stems: &'static [&'static str],
    stem_suffixes: &'static [&'static str],
    dot_segments: &'static [&'static str],
    script_only: bool,
}

const NO_PATTERN: RolePattern = RolePattern {
    dirs: &[],
    stems: &[],
    stem_suffixes: &[],
    dot_segments: &[],
    script_only: false,
};

const GENERATED_PATHS: RolePattern = RolePattern {
    dirs: GENERATED_DIRS,
    stem_suffixes: GENERATED_STEM_SUFFIXES,
    ..NO_PATTERN
};

impl FileRole {
    const fn pattern(self) -> RolePattern {
        match self {
            Self::TestOrSpec => RolePattern {
                dirs: &["test", "tests", "__tests__"],
                stem_suffixes: &[".test", ".spec"],
                ..NO_PATTERN
            },
            Self::TestSupport => RolePattern {
                dirs: &["__mocks__", "fixtures", "__fixtures__"],
                stem_suffixes: &[".fixture", ".mock", ".stub"],
                ..NO_PATTERN
            },
            Self::Docs => RolePattern {
                dirs: &["docs"],
                ..NO_PATTERN
            },
            Self::Example => RolePattern {
                dirs: &["example", "examples"],
                ..NO_PATTERN
            },
            Self::EndToEnd => RolePattern {
                dirs: &["e2e"],
                ..NO_PATTERN
            },
            Self::Story => RolePattern {
                stem_suffixes: &[".stories"],
                ..NO_PATTERN
            },
            Self::Boundary | Self::Domain => NO_PATTERN,
            Self::ScriptEntry => RolePattern {
                dirs: &["scripts", "bin"],
                stem_suffixes: &["worker-process"],
                dot_segments: &["worker-process"],
                ..NO_PATTERN
            },
            Self::Shared => RolePattern {
                dirs: &["shared"],
                ..NO_PATTERN
            },
        }
    }
}

impl RolePattern {
    fn matches(&self, path: &ProjectPath) -> bool {
        let stem = strip_source_ext(&path.relative);
        if self.script_only && stem.is_none() {
            return false;
        }
        let dirs = path.relative.rsplit_once('/').map_or("", |(dirs, _)| dirs);
        dirs.split('/').any(|part| self.dirs.contains(&part))
            || stem.is_some_and(|stem| self.matches_stem(stem))
    }

    fn matches_stem(&self, stem: &str) -> bool {
        let name = stem.rsplit('/').next().unwrap_or(stem);
        self.stems.contains(&name)
            || self
                .stem_suffixes
                .iter()
                .any(|suffix| stem.ends_with(suffix))
            || name
                .split('.')
                .any(|part| self.dot_segments.contains(&part))
    }
}

pub struct ProjectPath {
    relative: String,
    registry_generated: bool,
    is_domain: bool,
    is_boundary: bool,
}

impl ProjectPath {
    #[must_use]
    pub fn of(program: &Program, file_name: &str) -> Self {
        let cwd = program.host().get_current_directory();
        let relative = relative_to_cwd(cwd, file_name);
        let registries = &ProgramRegistries::for_program(program).0;
        let owner_rel = registries.owner_root.as_deref().map_or_else(
            || relative.clone(),
            |owner_dir| relative_to_cwd(owner_dir, file_name),
        );
        let is_script = strip_source_ext(&owner_rel).is_some();
        Self {
            registry_generated: registries.is_generated_rel_path(&owner_rel),
            is_domain: is_script && registries.is_domain_rel_path(&owner_rel),
            is_boundary: is_script && registries.is_boundary_rel_path(&owner_rel),
            relative,
        }
    }

    #[must_use]
    pub fn from_relative(relative_path: &str) -> Self {
        Self {
            relative: tspath::normalize_slashes(relative_path),
            registry_generated: false,
            is_domain: false,
            is_boundary: false,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.relative
    }

    #[must_use]
    pub fn has_role(&self, role: FileRole) -> bool {
        match role {
            FileRole::Domain => self.is_domain,
            FileRole::Boundary => self.is_boundary,
            _ => role.pattern().matches(self),
        }
    }

    #[must_use]
    pub fn has_any_role(&self, roles: &[FileRole]) -> bool {
        roles.iter().any(|&role| self.has_role(role))
    }
}

#[must_use]
pub fn is_declaration_file(file_path: &str) -> bool {
    tspath::is_declaration_file_name(&tspath::normalize_slashes(file_path))
}

fn strip_source_ext(file_path: &str) -> Option<&str> {
    if let Some(stem) = file_path.strip_suffix(".rs") {
        return Some(stem);
    }
    (tspath::has_ts_file_extension(file_path) || tspath::has_js_file_extension(file_path))
        .then(|| tspath::remove_file_extension(file_path))
}

const PROLOGUE_DIRECTIVES: &[&str] = &["use client", "use server", "use strict"];
const HEADER_WHITESPACE: &[char] = &[' ', '\t', '\r', '\n', '\u{2028}', '\u{2029}', '\u{feff}'];

fn strip_prologue_directive(rest: &str) -> Option<&str> {
    let trimmed = rest.trim_start_matches(HEADER_WHITESPACE);
    let quote = trimmed.as_bytes().first().copied()?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let (body, after_quote) = trimmed[1..].split_once(char::from(quote))?;
    if !PROLOGUE_DIRECTIVES.contains(&body) {
        return None;
    }
    let after = after_quote.trim_start_matches([' ', '\t']);
    after
        .strip_prefix(';')
        .map(|tail| tail.trim_start_matches([' ', '\t']))
        .or_else(|| {
            (after.is_empty() || after.starts_with(['\n', '\r', '\u{2028}', '\u{2029}']))
                .then_some(after)
        })
}

fn has_blank_line(gap: &str) -> bool {
    split_first_line(gap).1.is_some_and(|after_first| {
        split_ecma_lines(after_first)
            .collect::<Vec<_>>()
            .split_last()
            .is_some_and(|(_, middle)| {
                middle
                    .iter()
                    .any(|line| line.trim_matches(HEADER_WHITESPACE).is_empty())
            })
    })
}

fn leading_comment_text(source_text: &str) -> String {
    let mut rest = source_text.trim_start_matches('\u{feff}');
    if rest.starts_with("#!") {
        rest = split_first_line(rest).1.unwrap_or("");
    }
    let mut header = String::new();
    loop {
        if let Some(after_directive) = strip_prologue_directive(rest) {
            rest = after_directive;
            continue;
        }
        let trimmed = rest.trim_start_matches(HEADER_WHITESPACE);
        let (comment, is_jsdoc, tail) = if let Some(body) = trimmed.strip_prefix("//") {
            let (line, after) = split_first_line(body);
            (line, false, after.unwrap_or(""))
        } else if let Some(body) = trimmed.strip_prefix("/*") {
            let is_jsdoc = body.starts_with('*') && !body.starts_with("*/");
            let (block, after) = body.split_once("*/").unwrap_or((body, ""));
            (block, is_jsdoc, after)
        } else {
            return header.to_ascii_lowercase();
        };
        let next = tail.trim_start_matches(HEADER_WHITESPACE);
        let followed_by_code = !next.is_empty()
            && !next.starts_with("//")
            && !next.starts_with("/*")
            && strip_prologue_directive(next).is_none();
        if is_jsdoc
            && followed_by_code
            && !has_blank_line(&tail[..tail.len() - next.len()])
            && !comment.to_ascii_lowercase().contains("@generated")
        {
            return header.to_ascii_lowercase();
        }
        header.push_str(comment);
        header.push('\n');
        rest = tail;
    }
}

fn has_generated_header_marker(header: &str) -> bool {
    header.contains("@generated")
        || split_ecma_lines(header)
            .any(|line| line.contains("code generated") && line.contains("do not edit"))
}

#[must_use]
pub fn is_generated_file(path: &ProjectPath, source_text: &str) -> bool {
    if path.registry_generated || GENERATED_PATHS.matches(path) {
        return true;
    }
    has_generated_header_marker(&leading_comment_text(source_text))
}
