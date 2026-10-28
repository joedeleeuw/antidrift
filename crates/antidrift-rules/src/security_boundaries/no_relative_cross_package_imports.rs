use super::package_ownership::{PackageOwner, absolute_filename, package_owner};
use antidrift_kernel::imports::extract_module_import;
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use std::path::{Path, PathBuf};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-relative-cross-package-imports";

pub struct NoRelativeCrossPackageImports {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoRelativeCrossPackageImports = NoRelativeCrossPackageImports {
    scope: RuleScope::DEFAULT,
};

impl NoRelativeCrossPackageImports {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ImportDeclaration),
    Listener::Enter(Kind::ExportDeclaration),
    Listener::Enter(Kind::CallExpression),
];

impl Rule for NoRelativeCrossPackageImports {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        if !enabled {
            return Box::new(Visitor { state: None });
        }
        match load_owner_state(ctx.file.file_name()) {
            Ok(state) => Box::new(Visitor { state }),
            Err(message) => {
                ctx.report_range(0, 0, RuleMessage::new("invalidPackageOwnership", message));
                Box::new(Visitor { state: None })
            }
        }
    }
}

struct OwnerState {
    owner: PackageOwner,
    parent: PathBuf,
}

fn load_owner_state(file_name: &str) -> Result<Option<OwnerState>, String> {
    let filename = absolute_filename(Path::new(file_name))?;
    let Some(owner) = package_owner(&filename)? else {
        return Ok(None);
    };
    let Some(parent) = filename.parent() else {
        return Ok(None);
    };
    Ok(Some(OwnerState {
        owner,
        parent: parent.to_path_buf(),
    }))
}

struct Visitor {
    state: Option<OwnerState>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.state.is_some() { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let Some(state) = &self.state else {
            return;
        };
        let Some(import) = extract_module_import(node) else {
            return;
        };
        if !import.source.starts_with('.') {
            return;
        }
        match package_owner(&state.parent.join(import.source)) {
            Ok(Some(destination)) => {
                if destination.directory != state.owner.directory
                    && !state.owner.directory.starts_with(&destination.directory)
                {
                    let destination_name = destination
                        .manifest
                        .name
                        .unwrap_or_else(|| destination.directory.display().to_string());
                    ctx.report_node(
                        import.node,
                        RuleMessage::new(
                            "crossPackage",
                            format!(
                                "Import '{}' through the destination package's public entrypoint; {destination_name} owns these files; declare the shared contract in that package before importing it.",
                                import.source
                            ),
                        ),
                    );
                }
            }
            Ok(None) => {}
            Err(message) => {
                ctx.report_range(0, 0, RuleMessage::new("invalidPackageOwnership", message));
            }
        }
    }
}
