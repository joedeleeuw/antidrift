use rustc_hash::FxHashSet;
use tsrs_core::tspath;
use tsrs_core::{
    CompilerOptions, JsxEmit, ModuleKind, ModuleResolutionKind, ScriptTarget, Tristate,
};
use tsrs_vfs::FS;

pub(crate) fn inferred_compiler_options() -> CompilerOptions {
    CompilerOptions {
        allow_js: Tristate::True,
        module: ModuleKind::ESNext,
        module_resolution: ModuleResolutionKind::Bundler,
        target: ScriptTarget::ES2022,
        jsx: JsxEmit::ReactJSX,
        allow_importing_ts_extensions: Tristate::True,
        strict_null_checks: Tristate::True,
        strict_function_types: Tristate::True,
        source_map: Tristate::True,
        es_module_interop: Tristate::True,
        allow_non_ts_extensions: Tristate::True,
        resolve_json_module: Tristate::True,
        types: Some(vec!["*".to_owned()]),
        ..Default::default()
    }
}

pub(crate) fn inferred_type_roots(cwd: &str, roots: &[String], fs: &dyn FS) -> Vec<String> {
    let mut seen = FxHashSet::default();
    let mut type_roots = Vec::new();
    let mut collect = |base: &str| {
        tspath::for_each_ancestor_directory(base, |dir| -> Option<()> {
            let candidate = tspath::combine_paths(dir, &["node_modules", "@types"]);
            if seen.insert(candidate.clone()) && fs.directory_exists(&candidate) {
                type_roots.push(candidate);
            }
            None
        });
    };
    collect(cwd);
    for root in roots {
        collect(&tspath::get_directory_path(root));
    }
    type_roots
}
