use std::collections::hash_map::Entry;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{SourceFile, SourceFileParseOptions};
use tsrs_compiler::{CompilerHost, Program, ProgramOptions, new_compiler_host, new_program};
use tsrs_core::tspath::{self, Path};
use tsrs_core::{P, Tristate};
use tsrs_vfs::{FS, bundled, cachedvfs, osvfs};
use tsrslint::overlayfs::OverlayFS;
use tsrslint::protocol::{Diagnostic, Message, Range};
use tsrslint::tsconfig::{ExtendedConfigCache, ParseHost, TsConfigResolver};

use crate::inferred_program::{inferred_compiler_options, inferred_type_roots};

pub(crate) type DeclarationCache = Mutex<FxHashMap<SourceFileParseOptions, P<SourceFile>>>;

static PROGRAMS_BUILT: AtomicU32 = AtomicU32::new(0);
static PROGRAMS_REUSED: AtomicU32 = AtomicU32::new(0);

pub(crate) fn program_counts() -> (u32, u32) {
    (
        PROGRAMS_BUILT.load(Ordering::Relaxed),
        PROGRAMS_REUSED.load(Ordering::Relaxed),
    )
}

struct ProgramExtCache(&'static ExtendedConfigCache);

impl tsrs_tsoptions::ExtendedConfigCache for ProgramExtCache {
    fn get_extended_config(
        &self,
        file_name: &str,
        path: &Path,
        resolution_stack: &[Path],
        host: &'static dyn tsrs_tsoptions::ParseConfigHost,
    ) -> P<tsrs_tsoptions::ExtendedConfigCacheEntry> {
        self.0
            .get_extended_config(file_name, path, resolution_stack, host)
    }
}

struct SharedDeclarationsHost {
    inner: Arc<dyn CompilerHost>,
    cache: Arc<DeclarationCache>,
}

impl CompilerHost for SharedDeclarationsHost {
    fn fs(&self) -> &dyn FS {
        self.inner.fs()
    }

    fn default_library_path(&self) -> &str {
        self.inner.default_library_path()
    }

    fn get_current_directory(&self) -> &str {
        self.inner.get_current_directory()
    }

    fn trace(&self, msg: &'static tsrs_diagnostics::Message, args: &[&dyn std::fmt::Display]) {
        self.inner.trace(msg, args);
    }

    fn get_source_file(&self, opts: SourceFileParseOptions) -> Option<P<SourceFile>> {
        if !tspath::is_declaration_file_name(&opts.file_name)
            && !tspath::file_extension_is(&opts.file_name, tspath::EXTENSION_JSON)
        {
            return self.inner.get_source_file(opts);
        }
        if let Ok(guard) = self.cache.lock()
            && let Some(&file) = guard.get(&opts)
        {
            return Some(file);
        }
        let file = self.inner.get_source_file(opts.clone())?;
        if let Ok(mut guard) = self.cache.lock() {
            return Some(*guard.entry(opts).or_insert(file));
        }
        Some(file)
    }

    fn get_content_mapped_source_files(
        &self,
        opts: SourceFileParseOptions,
        mapper: &tsrs_contentmapper::Mapper,
    ) -> Result<tsrs_contentmapper::SourceFiles, tsrs_contentmapper::Error> {
        self.inner.get_content_mapped_source_files(opts, mapper)
    }

    fn content_mapper_project(&self) -> Option<Arc<dyn tsrs_contentmapper::Project>> {
        self.inner.content_mapper_project()
    }

    fn get_resolved_project_reference(
        &self,
        file_name: &str,
        path: Path,
    ) -> Option<P<tsrs_tsoptions::ParsedCommandLine>> {
        self.inner.get_resolved_project_reference(file_name, path)
    }
}

pub(crate) fn base_fs(overrides: Option<&FxHashMap<String, String>>) -> Arc<dyn FS> {
    let os_fs: Arc<dyn FS> = Arc::new(osvfs::fs());
    let base: Arc<dyn FS> = match overrides {
        Some(overrides) if !overrides.is_empty() => {
            Arc::new(OverlayFS::new(os_fs, overrides.clone()))
        }
        _ => os_fs,
    };
    Arc::new(bundled::wrap_fs(cachedvfs::from(base)))
}

pub(crate) fn build_shared_host(
    dir: &str,
    fs: &Arc<dyn FS>,
    ext_cache: &'static ExtendedConfigCache,
    declarations: &Arc<DeclarationCache>,
) -> Arc<dyn CompilerHost> {
    let inner = new_compiler_host(
        dir,
        Arc::clone(fs),
        &bundled::lib_path(),
        Some(Arc::new(ProgramExtCache(ext_cache))),
        None,
        None,
    );
    Arc::new(SharedDeclarationsHost {
        inner,
        cache: Arc::clone(declarations),
    })
}

pub(crate) fn suppress_program_diagnostics_enabled() -> bool {
    std::env::var("OXLINT_TSGOLINT_DANGEROUSLY_SUPPRESS_PROGRAM_DIAGNOSTICS")
        .is_ok_and(|value| value == "true")
}

fn build_tsconfig_diagnostic(
    file_path: String,
    range: Option<Range>,
    help: Option<String>,
) -> Diagnostic {
    let description = match help.as_deref().filter(|text| !text.is_empty()) {
        Some(text) => format!("Invalid tsconfig ({file_path}): {text}"),
        None => format!("Invalid tsconfig ({file_path})"),
    };
    Diagnostic {
        kind: 1,
        range,
        message: Message {
            id: "tsconfig-error".to_owned(),
            description,
            help,
        },
        file_path: Some(file_path),
        labeled_ranges: Vec::new(),
        rule: None,
        fixes: Vec::new(),
        suggestions: Vec::new(),
    }
}

pub(crate) fn tsconfig_error_diagnostic(
    diag: P<tsrs_ast::Diagnostic>,
    config_file_name: &str,
) -> Diagnostic {
    let file_path = diag
        .file()
        .map(|file| file.file_name().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| config_file_name.to_owned());
    let help = tsrs_compiler::diagnosticwriter::flatten_diagnostic_message(diag, "\n");
    build_tsconfig_diagnostic(file_path, diag.loc().map(Range::from), Some(help))
}

fn parsed_config_errors(
    errors: &[P<tsrs_ast::Diagnostic>],
    config_file_name: &str,
) -> Vec<Diagnostic> {
    if errors.is_empty() {
        return vec![build_tsconfig_diagnostic(
            config_file_name.to_owned(),
            None,
            None,
        )];
    }
    errors
        .iter()
        .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
        .collect()
}

pub(crate) struct BoundProgram {
    pub(crate) program: &'static Program,
    pub(crate) source_files: Vec<P<SourceFile>>,
}

struct CachedProgram {
    program: &'static Program,
    diagnostics: Vec<Diagnostic>,
}

struct ProgramFactory {
    cwd: String,
    fs: Arc<dyn FS>,
    ext_cache: &'static ExtendedConfigCache,
    declarations: Arc<DeclarationCache>,
    resolver: TsConfigResolver,
}

impl ProgramFactory {
    fn configured(&self, config_file_name: &str) -> Result<CachedProgram, Vec<Diagnostic>> {
        let parsed = self.resolver.load(config_file_name);
        let config = match parsed.config {
            Some(config) if parsed.errors.is_empty() => config,
            _ => return Err(parsed_config_errors(&parsed.errors, config_file_name)),
        };
        let config_errors: Vec<Diagnostic> = config
            .errors
            .iter()
            .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
            .collect();
        let compiler_host =
            build_shared_host(&self.cwd, &self.fs, self.ext_cache, &self.declarations);
        let mut popts = ProgramOptions::new(config, compiler_host);
        popts.use_source_of_project_reference = true;
        popts.single_threaded = Tristate::False;
        let program = new_program(popts);
        PROGRAMS_BUILT.fetch_add(1, Ordering::Relaxed);
        let diagnostics = if config_errors.is_empty() {
            program
                .get_program_diagnostics()
                .iter()
                .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
                .collect()
        } else {
            config_errors
        };
        program.bind_source_files();
        Ok(CachedProgram {
            program,
            diagnostics,
        })
    }

    fn is_broken_tsconfig(&self, candidate: &str) -> bool {
        if !self.fs.file_exists(candidate) {
            return false;
        }
        let parsed = self.resolver.load(candidate);
        parsed.config.as_ref().is_none_or(|cfg| {
            !parsed.errors.is_empty() || (!cfg.errors.is_empty() && cfg.file_names().is_empty())
        })
    }

    fn broken_ancestor_tsconfig(&self, file: &str) -> Option<String> {
        let mut dir = tspath::get_directory_path(file);
        loop {
            let candidate = tspath::combine_paths(&dir, &["tsconfig.json"]);
            if self.is_broken_tsconfig(&candidate) {
                return Some(candidate);
            }
            let parent = tspath::get_directory_path(&dir);
            if parent == dir {
                return None;
            }
            dir = parent;
        }
    }

    fn inferred(&self, unmatched: &[String]) -> &'static Program {
        let compiler_host =
            build_shared_host(&self.cwd, &self.fs, self.ext_cache, &self.declarations);
        let mut options = inferred_compiler_options();
        options.type_roots = Some(inferred_type_roots(&self.cwd, unmatched, self.fs.as_ref()));
        let config = P::new(tsrs_tsoptions::new_parsed_command_line(
            P::new(options),
            unmatched.to_vec(),
            Vec::new(),
            tspath::ComparePathsOptions {
                use_case_sensitive_file_names: self.fs.use_case_sensitive_file_names(),
                current_directory: self.cwd.clone(),
            },
        ));
        let mut popts = ProgramOptions::new(config, compiler_host);
        popts.single_threaded = Tristate::False;
        let program = new_program(popts);
        PROGRAMS_BUILT.fetch_add(1, Ordering::Relaxed);
        program.bind_source_files();
        program
    }

    fn report(
        &self,
        cached: &CachedProgram,
        config_file_name: &str,
        config_files: &[String],
        suppress_program_diagnostics: bool,
    ) -> Result<BoundProgram, Vec<Diagnostic>> {
        if !suppress_program_diagnostics && !cached.diagnostics.is_empty() {
            return Err(cached.diagnostics.clone());
        }
        Ok(self.bind(
            cached.program,
            &tspath::get_directory_path(config_file_name),
            config_files,
        ))
    }

    fn bind(&self, program: &'static Program, base_dir: &str, files: &[String]) -> BoundProgram {
        let use_case = self.fs.use_case_sensitive_file_names();
        let wanted: FxHashSet<Path> = files
            .iter()
            .map(|file| tspath::to_path(file, base_dir, use_case))
            .collect();
        let source_files: Vec<P<SourceFile>> = program
            .source_files()
            .iter()
            .copied()
            .filter(|sf| wanted.contains(sf.path()))
            .collect();
        BoundProgram {
            program,
            source_files,
        }
    }
}

static HOST_SLOTS: [OnceLock<(ParseHost, ExtendedConfigCache)>; 256] =
    [const { OnceLock::new() }; 256];
static NEXT_HOST_SLOT: AtomicUsize = AtomicUsize::new(0);

pub(crate) struct ProgramBuilderEnv {
    factory: ProgramFactory,
    configured: FxHashMap<String, CachedProgram>,
}

impl ProgramBuilderEnv {
    pub(crate) fn new(fs: Arc<dyn FS>, cwd: &str) -> Self {
        let idx = NEXT_HOST_SLOT.fetch_add(1, Ordering::Relaxed) % HOST_SLOTS.len();
        let (host, ext_cache) = HOST_SLOTS[idx].get_or_init(|| {
            let host = ParseHost {
                fs: Arc::clone(&fs),
                cwd: cwd.to_owned(),
            };
            (host, ExtendedConfigCache::default())
        });
        Self {
            factory: ProgramFactory {
                cwd: cwd.to_owned(),
                fs,
                ext_cache,
                declarations: Arc::default(),
                resolver: TsConfigResolver::new(host, ext_cache),
            },
            configured: FxHashMap::default(),
        }
    }

    pub(crate) fn group_files_by_tsconfig(
        &self,
        files: &[String],
    ) -> (Vec<(String, Vec<String>)>, Vec<String>) {
        let assignment = self.factory.resolver.resolve_all(files);
        let mut programs: Vec<(String, Vec<String>)> = Vec::new();
        let mut program_index: FxHashMap<String, usize> = FxHashMap::default();
        let mut unmatched: Vec<String> = Vec::new();
        for (file, config) in files.iter().zip(assignment) {
            let resolved = if config.is_empty() {
                self.factory
                    .broken_ancestor_tsconfig(file)
                    .unwrap_or_default()
            } else {
                config
            };
            if resolved.is_empty() {
                unmatched.push(file.clone());
                continue;
            }
            let idx = *program_index.entry(resolved.clone()).or_insert_with(|| {
                programs.push((resolved.clone(), Vec::new()));
                programs.len() - 1
            });
            programs[idx].1.push(file.clone());
        }
        (programs, unmatched)
    }

    pub(crate) fn configured_program(
        &mut self,
        config_file_name: &str,
        config_files: &[String],
        suppress_program_diagnostics: bool,
    ) -> Result<BoundProgram, Vec<Diagnostic>> {
        let cached = match self.configured.entry(config_file_name.to_owned()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => entry.insert(self.factory.configured(config_file_name)?),
        };
        self.factory.report(
            cached,
            config_file_name,
            config_files,
            suppress_program_diagnostics,
        )
    }

    pub(crate) fn current_program(
        &self,
        config_file_name: &str,
        config_files: &[String],
        suppress_program_diagnostics: bool,
    ) -> Option<Result<BoundProgram, Vec<Diagnostic>>> {
        let cached = self
            .configured
            .get(config_file_name)
            .filter(|cached| matches_disk(cached.program))?;
        PROGRAMS_REUSED.fetch_add(1, Ordering::Relaxed);
        Some(self.factory.report(
            cached,
            config_file_name,
            config_files,
            suppress_program_diagnostics,
        ))
    }

    pub(crate) fn inferred_program(&self, unmatched: &[String]) -> BoundProgram {
        let program = self.factory.inferred(unmatched);
        self.factory.bind(program, &self.factory.cwd, unmatched)
    }
}

fn matches_disk(program: &Program) -> bool {
    let disk = osvfs::fs();
    program
        .source_files()
        .iter()
        .filter(|sf| {
            !program.is_lib_file(**sf) && !program.is_source_file_from_external_library(**sf)
        })
        .all(|sf| {
            disk.read_file(sf.file_name())
                .is_some_and(|text| text == sf.text())
        })
}

pub(crate) fn collect_missing_bound_files(
    source_files: &[P<SourceFile>],
    config_files: &[String],
    unmatched: &mut Vec<String>,
) {
    let bound_names: FxHashSet<String> = source_files
        .iter()
        .map(|sf| tspath::normalize_slashes(sf.file_name()))
        .collect();
    for requested in config_files {
        if !bound_names.contains(&tspath::normalize_slashes(requested)) {
            unmatched.push(requested.clone());
        }
    }
}
