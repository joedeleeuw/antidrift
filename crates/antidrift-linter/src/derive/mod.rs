mod contracts;
mod decoders;
mod emit;
mod layout;
mod route_contracts;
mod wire_shape;

use std::sync::Arc;

use serde::Serialize;
use tsrs_compiler::Context;
use tsrs_core::tspath;
use tsrs_vfs::{FS, bundled, cachedvfs, osvfs};

use crate::headless_host::{BoundProgram, ProgramBuilderEnv};
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
    let layout = SourceLayout::new(&src_dir);
    let files = collect_lintable_files(std::slice::from_ref(&src_dir), &cwd)?;
    let normalized: Vec<String> = files
        .iter()
        .map(|path| tspath::normalize_slashes(&path.to_string_lossy()))
        .collect();
    let cwd_norm = tspath::normalize_slashes(&cwd.to_string_lossy());
    let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(cachedvfs::from(Arc::new(osvfs::fs()))));
    let env = ProgramBuilderEnv::new(fs, &cwd_norm);
    let (programs, unmatched) = env.group_files_by_tsconfig(&normalized);
    if !unmatched.is_empty() {
        return Err(format!(
            "no tsconfig.json includes these files, so they have no types to derive from: {}",
            unmatched.join(", ")
        ));
    }
    let mut report = DeriveReport::default();
    for (config_file_name, config_files) in &programs {
        let bound = env
            .run_configured_program(config_file_name, config_files, true)
            .map_err(|diags| {
                let messages: Vec<String> = diags
                    .into_iter()
                    .map(|diag| diag.message.description)
                    .collect();
                format!("failed to load {config_file_name}: {}", messages.join("; "))
            })?;
        inspect_program(&bound, &layout, &mut report);
    }
    emit::write_generated(&src_dir.join("generated"), &report)?;
    print_report(&report);
    Ok(i32::from(!report.diagnostics.is_empty()))
}

fn inspect_program(bound: &BoundProgram, layout: &SourceLayout, report: &mut DeriveReport) {
    let checker_context = Context::default();
    for &sf in &bound.source_files {
        let file_name = tspath::normalize_slashes(sf.file_name());
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
