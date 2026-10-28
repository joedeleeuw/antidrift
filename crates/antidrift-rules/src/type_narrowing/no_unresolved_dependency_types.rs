use std::path::{Path, PathBuf};

use antidrift_kernel::json_manifest::parse_package_json_manifest;
use antidrift_kernel::ts_resolver;
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

struct ManifestInfo {
    manifest_label: String,
    missing_by_name: FxHashMap<String, String>,
    installed_by_name: FxHashMap<String, String>,
}

fn extract_module_specifier(node: P<Node>) -> Option<(P<Node>, bool)> {
    match node.kind() {
        Kind::ImportDeclaration => {
            let spec = node.as_import_declaration().module_specifier();
            ast::is_string_literal(spec).then_some((spec, false))
        }
        Kind::ExportDeclaration => {
            let spec = node.as_export_declaration().module_specifier()?;
            ast::is_string_literal(spec).then_some((spec, false))
        }
        Kind::ExternalModuleReference => {
            let expr = node.as_external_module_reference().expression();
            ast::is_string_literal(expr).then_some((expr, true))
        }
        Kind::CallExpression => {
            let call = node.as_call_expression();
            let callee = call.expression();
            let is_require =
                ast::is_identifier(callee) && callee.as_identifier().text() == "require";
            let is_import = callee.kind() == Kind::ImportKeyword;
            if !is_require && !is_import {
                return None;
            }
            let first = *call.arguments().nodes().first()?;
            ast::is_string_literal_like(first).then_some((first, is_require))
        }
        Kind::ImportType => {
            let arg = node.as_import_type_node().argument();
            if arg.kind() != Kind::LiteralType {
                return None;
            }
            let lit = arg.as_literal_type_node().literal();
            ast::is_string_literal(lit).then_some((lit, false))
        }
        _ => None,
    }
}

fn find_nearest_package_json(file_path: &Path) -> Option<PathBuf> {
    let mut dir = file_path.parent()?;
    loop {
        let candidate = dir.join("package.json");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = dir.parent()?;
    }
}

fn imported_package_name(declared: &str) -> String {
    if let Some(rest) = declared.strip_prefix("@types/") {
        if let Some((scope, pkg)) = rest.split_once("__") {
            return format!("@{scope}/{pkg}");
        }
        return rest.to_owned();
    }
    declared.to_owned()
}

fn is_package_installed(start_dir: &Path, pkg_name: &str) -> bool {
    let mut current = Some(start_dir);
    while let Some(dir) = current {
        let pkg_dir = dir.join("node_modules").join(pkg_name);
        if pkg_dir.join("package.json").is_file() || pkg_dir.is_dir() {
            return true;
        }
        current = dir.parent();
    }
    false
}

fn load_manifest_info(file_path: &Path) -> Option<ManifestInfo> {
    let manifest_path = find_nearest_package_json(file_path)?;
    let package_dir = manifest_path.parent()?;
    let Ok(content) = std::fs::read_to_string(&manifest_path) else {
        return None;
    };
    let manifest = parse_package_json_manifest(&content)?;
    let mut declared = Vec::new();
    let mut seen = FxHashSet::default();
    for section in ["dependencies", "devDependencies", "peerDependencies"] {
        let Some(entries) = manifest.sections.get(section) else {
            continue;
        };
        for entry in entries {
            if seen.insert(entry.key.clone()) {
                declared.push(entry.key.clone());
            }
        }
    }
    let mut missing_by_name = FxHashMap::default();
    let mut installed_by_name = FxHashMap::default();
    for dep in declared {
        let imported = imported_package_name(&dep);
        if is_package_installed(package_dir, &dep) || is_package_installed(package_dir, &imported) {
            installed_by_name
                .entry(imported)
                .or_insert_with(|| dep.clone());
            installed_by_name.entry(dep.clone()).or_insert(dep);
        } else {
            missing_by_name
                .entry(imported)
                .or_insert_with(|| dep.clone());
            missing_by_name.entry(dep.clone()).or_insert(dep);
        }
    }
    Some(ManifestInfo {
        manifest_label: "package.json".to_owned(),
        missing_by_name,
        installed_by_name,
    })
}

fn has_script_subpath(subpath: &str) -> bool {
    if subpath.is_empty() || subpath == "/" {
        return false;
    }
    let lower = subpath.to_ascii_lowercase();
    for ext in [
        ".css", ".scss", ".sass", ".less", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif",
        ".webp", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".wasm", ".md", ".txt", ".html",
    ] {
        if lower.ends_with(ext) {
            return false;
        }
    }
    true
}

fn module_resolves(
    ctx: &mut Ctx,
    file_path: &Path,
    specifier_node: P<Node>,
    specifier_text: &str,
    is_require_call: bool,
) -> bool {
    if ctx
        .checker
        .get_symbol_at_location_exported(specifier_node)
        .is_some()
    {
        return true;
    }
    let Some(containing_dir) = file_path.parent() else {
        return false;
    };
    let tsconfig = ts_resolver::TsDeclarationResolver::discover_governing_tsconfig(file_path);
    let resolver = ts_resolver::TsDeclarationResolver::new(tsconfig);
    let mode = ts_resolver::TsDeclarationResolver::mode_for_file(file_path, is_require_call);
    resolver
        .resolve_declaration(containing_dir, specifier_text, mode)
        .is_some()
}

fn check_node(ctx: &mut Ctx, node: P<Node>) {
    let Some((specifier_node, is_require_call)) = extract_module_specifier(node) else {
        return;
    };
    let specifier_text = specifier_node.text();
    let Some(imported) = ts_resolver::bare_package_name(specifier_text) else {
        return;
    };
    let file_name = ctx.file.file_name().to_owned();
    let file_path = Path::new(&file_name);
    let Some(manifest_info) = load_manifest_info(file_path) else {
        return;
    };
    if let Some(pkg_name) = manifest_info.missing_by_name.get(&imported) {
        ctx.report_node(
            specifier_node,
            RuleMessage::new(
                "uninstalledImport",
                format!(
                    "{pkg_name} is declared in {} but not installed, so its exported types are not compared with first-party types.",
                    manifest_info.manifest_label
                ),
            ),
        );
        return;
    }
    let Some(pkg_name) = manifest_info.installed_by_name.get(&imported) else {
        return;
    };
    let subpath = &specifier_text[imported.len()..];
    if !has_script_subpath(subpath)
        || module_resolves(
            ctx,
            file_path,
            specifier_node,
            specifier_text,
            is_require_call,
        )
    {
        return;
    }
    ctx.report_node(
        specifier_node,
        RuleMessage::new(
            "unresolvedImport",
            format!(
                "{pkg_name} is installed but '{specifier_text}' does not resolve to type declarations, so its exported types are not compared with first-party types."
            ),
        ),
    );
}

pub struct NoUnresolvedDependencyTypes;

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ImportDeclaration),
    Listener::Enter(Kind::ExportDeclaration),
    Listener::Enter(Kind::ExternalModuleReference),
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::ImportType),
];

impl Rule for NoUnresolvedDependencyTypes {
    fn name(&self) -> &'static str {
        "antidrift/no-unresolved-dependency-types"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        check_node(ctx, node);
    }
}
