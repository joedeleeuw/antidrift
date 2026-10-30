use std::collections::VecDeque;
use std::path::Path;

use antidrift_kernel::imports::extract_module_import;
use antidrift_kernel::tsrs_kernel::{function_name, is_generator_function};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{Kind, ModifierFlags, Node, SourceFile};
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrs_core::tspath;

use super::{DeriveReport, DeriveRule};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    Method,
    Publication,
    Route,
    Shared,
    Server,
    Client,
}

impl Role {
    fn is_server_only(self) -> bool {
        matches!(
            self,
            Self::Method | Self::Publication | Self::Route | Self::Server
        )
    }

    fn is_client_root(self) -> bool {
        matches!(self, Self::Shared | Self::Client)
    }
}

pub(crate) struct SourceLayout {
    src_prefix: String,
}

impl SourceLayout {
    pub(crate) fn new(src_dir: &Path) -> Self {
        let mut src_prefix = tspath::normalize_slashes(&src_dir.to_string_lossy());
        src_prefix.push('/');
        Self { src_prefix }
    }

    pub(crate) fn relative<'a>(&self, file_name: &'a str) -> &'a str {
        file_name
            .strip_prefix(&self.src_prefix)
            .unwrap_or(file_name)
    }

    pub(crate) fn within(&self, file_name: &str) -> bool {
        file_name.starts_with(&self.src_prefix)
    }

    pub(crate) fn role_of(&self, file_name: &str) -> Option<Role> {
        if !self.within(file_name) {
            return None;
        }
        match self.relative(file_name).split('/').next()? {
            "methods" => Some(Role::Method),
            "pubs" => Some(Role::Publication),
            "routes" => Some(Role::Route),
            "shared" => Some(Role::Shared),
            "server" => Some(Role::Server),
            "client" => Some(Role::Client),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct ExportedFunction {
    pub(crate) node: P<Node>,
    pub(crate) name: &'static str,
    pub(crate) is_async: bool,
    pub(crate) is_generator: bool,
}

pub(crate) fn exported_functions(sf: P<SourceFile>) -> Vec<ExportedFunction> {
    sf.statements()
        .nodes()
        .iter()
        .copied()
        .filter(|stmt| {
            stmt.kind() == Kind::FunctionDeclaration
                && stmt.modifier_flags().contains(ModifierFlags::Export)
        })
        .filter_map(|stmt| {
            Some(ExportedFunction {
                node: stmt,
                name: function_name(stmt)?,
                is_async: stmt.modifier_flags().contains(ModifierFlags::Async),
                is_generator: is_generator_function(stmt),
            })
        })
        .collect()
}

pub(crate) fn has_non_function_exports(sf: P<SourceFile>) -> bool {
    sf.statements().nodes().iter().any(|stmt| {
        matches!(
            stmt.kind(),
            Kind::ExportDeclaration | Kind::ExportAssignment
        ) || (stmt.kind() != Kind::FunctionDeclaration
            && stmt.kind() != Kind::TypeAliasDeclaration
            && stmt.kind() != Kind::InterfaceDeclaration
            && stmt.modifier_flags().contains(ModifierFlags::Export))
    })
}

pub(crate) fn file_stem(relative: &str) -> &str {
    let base = relative.rsplit('/').next().unwrap_or(relative);
    base.strip_suffix(".tsx")
        .or_else(|| base.strip_suffix(".ts"))
        .unwrap_or(base)
}

pub(crate) fn check_shared_is_sync(sf: P<SourceFile>, relative: &str, report: &mut DeriveReport) {
    for function in exported_functions(sf) {
        if function.is_async || function.is_generator {
            report.flag(
                relative,
                DeriveRule::SharedMustBeSync,
                format!(
                    "`{}` is async, but shared/ code runs on both sides as the client simulation and stays synchronous; move the awaiting into methods/ or pubs/.",
                    function.name
                ),
            );
        }
    }
}

fn runtime_imports(program: &Program, sf: P<SourceFile>, layout: &SourceLayout) -> Vec<String> {
    let mut targets = Vec::new();
    for &stmt in sf.statements().nodes() {
        let Some(import) = extract_module_import(stmt) else {
            continue;
        };
        if import.type_only {
            continue;
        }
        let Some(resolved) =
            program.get_resolved_module_from_module_specifier(sf, import.specifier_node)
        else {
            continue;
        };
        if !resolved.is_resolved() || resolved.is_external_library_import {
            continue;
        }
        let target = tspath::normalize_slashes(resolved.resolved_file_name);
        if layout.within(&target) {
            targets.push(target);
        }
    }
    targets
}

fn first_server_chain(
    edges: &FxHashMap<String, Vec<String>>,
    start: &str,
    layout: &SourceLayout,
) -> Option<Vec<String>> {
    let mut parents: FxHashMap<String, String> = FxHashMap::default();
    let mut visited: FxHashSet<String> = FxHashSet::default();
    let mut queue: VecDeque<String> = VecDeque::new();
    visited.insert(start.to_owned());
    queue.push_back(start.to_owned());
    while let Some(current) = queue.pop_front() {
        if current != start && layout.role_of(&current).is_some_and(Role::is_server_only) {
            let mut chain = vec![layout.relative(&current).to_owned()];
            let mut cursor = current;
            while let Some(parent) = parents.get(&cursor) {
                chain.push(layout.relative(parent).to_owned());
                cursor.clone_from(parent);
            }
            chain.reverse();
            return Some(chain);
        }
        for next in edges.get(&current).map(Vec::as_slice).unwrap_or(&[]) {
            if visited.insert(next.clone()) {
                parents.insert(next.clone(), current.clone());
                queue.push_back(next.clone());
            }
        }
    }
    None
}

pub(crate) fn check_reachability(
    program: &Program,
    layout: &SourceLayout,
    report: &mut DeriveReport,
) {
    let mut files: Vec<(String, P<SourceFile>)> = program
        .source_files()
        .iter()
        .copied()
        .map(|sf| (tspath::normalize_slashes(sf.file_name()), sf))
        .filter(|(name, _)| layout.within(name))
        .collect();
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut edges: FxHashMap<String, Vec<String>> = FxHashMap::default();
    for (name, sf) in &files {
        edges.insert(name.clone(), runtime_imports(program, *sf, layout));
    }
    for (name, _) in &files {
        if !layout.role_of(name).is_some_and(Role::is_client_root) {
            continue;
        }
        if let Some(chain) = first_server_chain(&edges, name, layout) {
            report.flag(
                layout.relative(name),
                DeriveRule::ClientReachesServer,
                format!(
                    "client-reachable module imports server-only code at runtime: {}; only type-only imports and generated stubs may cross that line.",
                    chain.join(" -> ")
                ),
            );
        }
    }
}
