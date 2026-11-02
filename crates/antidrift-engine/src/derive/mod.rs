mod contracts;
mod decoders;
mod emit;
mod layout;
mod route_contracts;
mod wire_overlap;
mod wire_shape;

use std::sync::Arc;

use rustc_hash::FxHashMap;
use serde::Serialize;
use tsrs_compiler::Context;
use tsrs_core::tspath;
use tsrs_vfs::{FS, bundled, cachedvfs, osvfs};

use crate::headless_host::{BoundProgram, ProgramBuilderEnv, suppress_program_diagnostics_enabled};
use crate::runner::collect_lintable_files;
use contracts::{MethodContract, PublicationContract};
use layout::{Role, SourceLayout};
use route_contracts::RouteContract;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DeriveRule {
    MethodMustBeAsync,
    MethodExportName,
    MethodSingleExport,
    MethodParamNotWire,
    MethodResultNotWire,
    DuplicateWireName,
    ReservedGeneratedIdentifier,
    InjectedParamPlacement,
    UnnamedParameter,
    PublicationMustBeGenerator,
    PublicationYieldNotWire,
    RouteFileName,
    RouteUnknownVerb,
    RouteMustBeAsync,
    RouteReturnType,
    SharedMustBeSync,
    ClientReachesServer,
    TypeScriptDiagnostic,
}

#[derive(Serialize)]
pub(crate) struct DeriveDiagnostic {
    pub(crate) file: String,
    pub(crate) rule: DeriveRule,
    pub(crate) message: String,
}

#[derive(Default, Serialize)]
pub(crate) struct DeriveReport {
    pub(crate) methods: Vec<MethodContract>,
    pub(crate) publications: Vec<PublicationContract>,
    pub(crate) routes: Vec<RouteContract>,
    pub(crate) diagnostics: Vec<DeriveDiagnostic>,
}

impl DeriveReport {
    pub(crate) fn flag(&mut self, file: &str, rule: DeriveRule, message: String) {
        self.diagnostics.push(DeriveDiagnostic {
            file: file.to_owned(),
            rule,
            message,
        });
    }
}

fn verify_required_runtime(
    root: &std::path::Path,
    src_dir: &std::path::Path,
) -> Result<(), String> {
    let missing_runtime: Vec<String> = [
        "runtime/decode.ts",
        "runtime/client.ts",
        "runtime/server.ts",
        "shared/session.ts",
    ]
    .into_iter()
    .filter(|rel| !src_dir.join(rel).is_file())
    .map(|rel| format!("src/{rel}"))
    .collect();
    if missing_runtime.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{} is missing required derive runtime module(s): {}",
        root.display(),
        missing_runtime.join(", ")
    ))
}

pub(crate) fn run_derive(args: &[String]) -> Result<i32, String> {
    let package_root = args
        .first()
        .ok_or("usage: antidrift-linter derive <package-root>")?;
    tsrs_checker::links::set_sparse_id_pages(true);
    let cwd = std::env::current_dir()
        .map_err(|err| format!("failed to read current directory: {err}"))?;
    let root = cwd
        .join(package_root)
        .canonicalize()
        .map_err(|err| format!("package root {package_root} is not readable: {err}"))?;
    let src_dir = root.join("src");
    if !src_dir.is_dir() {
        return Err(format!(
            "{} has no src directory; derive reads <package-root>/src/{{methods,pubs,routes,shared,server,client}}",
            root.display()
        ));
    }
    verify_required_runtime(&root, &src_dir)?;
    let layout = SourceLayout::new(&src_dir);
    let files = collect_lintable_files(std::slice::from_ref(&src_dir), &cwd)?;
    let normalized: Vec<String> = files
        .iter()
        .map(|path| tspath::normalize_slashes(&path.to_string_lossy()))
        .collect();
    let cwd_norm = tspath::normalize_slashes(&cwd.to_string_lossy());
    let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(cachedvfs::from(Arc::new(osvfs::fs()))));
    let mut env = ProgramBuilderEnv::new(fs, &cwd_norm);
    let (programs, unmatched) = env.group_files_by_tsconfig(&normalized);
    if !unmatched.is_empty() {
        return Err(format!(
            "no tsconfig.json includes these files, so they have no types to derive from: {}",
            unmatched.join(", ")
        ));
    }
    let mut report = DeriveReport::default();
    for (config_file_name, config_files) in &programs {
        let bound = match env.configured_program(
            config_file_name,
            config_files,
            suppress_program_diagnostics_enabled(),
        ) {
            Ok(bound) => bound,
            Err(diags) => {
                for diag in diags {
                    let file_path = diag.file_path.as_deref().unwrap_or(config_file_name);
                    let detail = diag
                        .message
                        .help
                        .as_deref()
                        .unwrap_or(&diag.message.description);
                    report.flag(
                        layout.relative(&tspath::normalize_slashes(file_path)),
                        DeriveRule::TypeScriptDiagnostic,
                        detail.to_owned(),
                    );
                }
                continue;
            }
        };
        inspect_program(&bound, &layout, &mut report);
    }
    check_duplicate_wire_names(&mut report);
    emit::write_generated(&src_dir.join("generated"), &report)?;
    print_report(&report);
    Ok(i32::from(!report.diagnostics.is_empty()))
}

fn check_duplicate_wire_names(report: &mut DeriveReport) {
    let mut seen: FxHashMap<String, String> = FxHashMap::default();
    let entries: Vec<(String, String)> = report
        .methods
        .iter()
        .map(|method| (method.name.clone(), method.file.clone()))
        .chain(
            report
                .publications
                .iter()
                .map(|pub_contract| (pub_contract.name.clone(), pub_contract.file.clone())),
        )
        .collect();
    for (name, file) in entries {
        if let Some(first_file) = seen.get(&name) {
            report.flag(
                &file,
                DeriveRule::DuplicateWireName,
                format!(
                    "wire name `{name}` is already declared by `{first_file}`; every method and publication needs a distinct wire name across `methods/` and `pubs/`."
                ),
            );
        } else {
            seen.insert(name, file);
        }
    }
}

fn collect_contract_diagnostics(
    bound: &BoundProgram,
    checker_context: &Context,
    layout: &SourceLayout,
    report: &mut DeriveReport,
) -> rustc_hash::FxHashSet<String> {
    let mut blocked_files = rustc_hash::FxHashSet::default();
    for &sf in &bound.source_files {
        let file_name = tspath::normalize_slashes(sf.file_name());
        let Some(role) = layout.role_of(&file_name) else {
            continue;
        };
        if !matches!(
            role,
            Role::Method | Role::Publication | Role::Route | Role::Shared
        ) {
            continue;
        }
        let mut file_diags = bound
            .program
            .get_syntactic_diagnostics(checker_context, Some(sf));
        file_diags.extend(
            bound
                .program
                .get_bind_diagnostics(checker_context, Some(sf)),
        );
        file_diags.extend(
            bound
                .program
                .get_semantic_diagnostics(checker_context, Some(sf)),
        );
        if file_diags.is_empty() {
            continue;
        }
        blocked_files.insert(file_name.clone());
        let relative = layout.relative(&file_name);
        for diag in file_diags {
            let message = tsrs_compiler::diagnosticwriter::flatten_diagnostic_message(diag, "\n");
            report.flag(relative, DeriveRule::TypeScriptDiagnostic, message);
        }
    }
    for diag in bound.program.get_global_diagnostics(checker_context) {
        let file_name = diag
            .file()
            .map(|sf| tspath::normalize_slashes(sf.file_name()))
            .unwrap_or_default();
        let message = tsrs_compiler::diagnosticwriter::flatten_diagnostic_message(diag, "\n");
        report.flag(
            layout.relative(&file_name),
            DeriveRule::TypeScriptDiagnostic,
            message,
        );
    }
    blocked_files
}

fn inspect_program(bound: &BoundProgram, layout: &SourceLayout, report: &mut DeriveReport) {
    let checker_context = Context::default();
    let blocked_files = collect_contract_diagnostics(bound, &checker_context, layout, report);
    for &sf in &bound.source_files {
        let file_name = tspath::normalize_slashes(sf.file_name());
        if blocked_files.contains(&file_name) {
            continue;
        }
        let Some(role) = layout.role_of(&file_name) else {
            continue;
        };
        let relative = layout.relative(&file_name);
        let mut checker = bound
            .program
            .get_type_checker_for_file(&checker_context, sf);
        match role {
            Role::Method => contracts::inspect_method(&mut checker, sf, relative, report),
            Role::Publication => {
                contracts::inspect_publication(&mut checker, sf, relative, report);
            }
            Role::Route => route_contracts::inspect_route(&mut checker, sf, relative, report),
            Role::Shared => layout::check_shared_is_sync(sf, relative, report),
            Role::Server | Role::Client => {}
        }
    }
    layout::check_reachability(bound.program, layout, report);
}

fn print_report(report: &DeriveReport) {
    println!(
        "derived {} methods, {} publications, {} routes",
        report.methods.len(),
        report.publications.len(),
        report.routes.len()
    );
    for diagnostic in &report.diagnostics {
        println!(
            "{}: {}: {}",
            diagnostic.file,
            serde_json::to_string(&diagnostic.rule)
                .unwrap_or_else(|_| format!("{:?}", diagnostic.rule)),
            diagnostic.message
        );
    }
    println!("{} diagnostics", report.diagnostics.len());
}
