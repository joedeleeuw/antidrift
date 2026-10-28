use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options, in_scope};
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/confine-owner";

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct ConfineOptions {
    files: Option<Vec<String>>,
    exclude_files: Vec<String>,
    registry: Option<String>,
    entries: Vec<OwnerEntry>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnerEntry {
    id: String,
    owner: Vec<String>,
    enforcement: Enforcement,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Enforcement {
    Import {
        specifiers: Vec<String>,
        #[serde(default)]
        allowed: Vec<AllowedPath>,
    },
    GlobalMember {
        object: String,
        path: Vec<String>,
        #[serde(default)]
        allowed: Vec<AllowedPath>,
    },
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AllowedPath {
    path: String,
    reason: String,
}

impl OwnerEntry {
    fn applies(&self, filename: &str) -> bool {
        let allowed = match &self.enforcement {
            Enforcement::Import { allowed, .. } | Enforcement::GlobalMember { allowed, .. } => {
                allowed
            }
        };
        !self
            .owner
            .iter()
            .map(String::as_str)
            .chain(allowed.iter().map(|entry| entry.path.as_str()))
            .any(|path| {
                if path.ends_with('/') {
                    filename.contains(path)
                } else {
                    filename.ends_with(path)
                }
            })
    }

    fn valid(&self) -> bool {
        let allowed = match &self.enforcement {
            Enforcement::Import { allowed, .. } | Enforcement::GlobalMember { allowed, .. } => {
                allowed
            }
        };
        !self.id.is_empty()
            && !self.owner.is_empty()
            && self.owner.iter().all(|owner| !owner.is_empty())
            && allowed.iter().all(|entry| !entry.reason.is_empty())
    }
}

pub struct ConfineOwner {
    scope: RuleScope,
    registry: Option<String>,
    entries: Vec<OwnerEntry>,
}

pub static DEFAULT_RULE: ConfineOwner = ConfineOwner {
    scope: RuleScope::DEFAULT,
    registry: None,
    entries: Vec::new(),
};

impl ConfineOwner {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<ConfineOptions>(RULE_NAME, options)?;
        if parsed.registry.as_ref().is_some_and(String::is_empty)
            || !parsed.entries.iter().all(OwnerEntry::valid)
        {
            return Err(
                "confine-owner entries must have non-empty id, owner, and allowed reasons"
                    .to_string(),
            );
        }
        let scope_opts = ScopeOptions {
            files: parsed.files,
            exclude_files: parsed.exclude_files,
        };
        let scope = RuleScope::from_scope_options(RULE_NAME, &scope_opts)?;
        Ok(Self {
            scope,
            registry: parsed.registry,
            entries: parsed.entries,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ImportDeclaration),
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::PropertyAccessExpression),
];

impl Rule for ConfineOwner {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        let filename = ctx.file.file_name().replace('\\', "/");
        let entries = if enabled {
            self.entries
                .iter()
                .filter(|entry| entry.applies(&filename))
                .collect()
        } else {
            Vec::new()
        };
        let registry = self
            .registry
            .as_deref()
            .unwrap_or("this rule’s entries configuration");
        Box::new(Visitor {
            enabled: enabled && !entries.is_empty(),
            entries,
            registry,
        })
    }
}

struct Visitor {
    enabled: bool,
    entries: Vec<&'static OwnerEntry>,
    registry: &'static str,
}

impl Visitor {
    fn inspect_import(&self, ctx: &mut Ctx, source: &str, node: P<Node>) {
        for entry in &self.entries {
            if let Enforcement::Import { specifiers, .. } = &entry.enforcement
                && specifiers
                    .iter()
                    .any(|specifier| owned_specifier(specifier, source))
            {
                ctx.report_node(node, owner_message(entry, self.registry));
            }
        }
    }
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::ImportDeclaration => {
                let spec = node.as_import_declaration().module_specifier();
                if ast::is_string_literal(spec) {
                    self.inspect_import(ctx, spec.as_string_literal().text(), node);
                }
            }
            Kind::CallExpression => {
                self.inspect_dynamic_import(ctx, node);
            }
            Kind::PropertyAccessExpression => {
                self.inspect_member_access(ctx, node);
            }
            _ => {}
        }
    }
}

impl Visitor {
    fn inspect_dynamic_import(&self, ctx: &mut Ctx, node: P<Node>) {
        let call = node.as_call_expression();
        if call.expression().kind() != Kind::ImportKeyword {
            return;
        }
        let Some(&first) = call.arguments().nodes().first() else {
            return;
        };
        let inner = ast::skip_parentheses(first);
        if ast::is_string_literal(inner) {
            self.inspect_import(ctx, inner.as_string_literal().text(), node);
        }
    }

    fn inspect_member_access(&self, ctx: &mut Ctx, node: P<Node>) {
        for entry in &self.entries {
            if let Enforcement::GlobalMember { object, path, .. } = &entry.enforcement
                && owned_member(node, object, path)
            {
                ctx.report_node(node, owner_message(entry, self.registry));
            }
        }
    }
}

fn owner_message(entry: &OwnerEntry, registry: &str) -> RuleMessage {
    RuleMessage::new(
        "unownedUse",
        format!(
            "`{}` is owned by {}. Go through the owner, or add this file to that entry's `allowed` list with a reason in {registry}.",
            entry.id,
            entry.owner.join(", ")
        ),
    )
}

fn owned_specifier(specifier: &str, source: &str) -> bool {
    let mut segments = specifier.rsplitn(3, '/');
    let last = segments.next().unwrap_or("");
    let suffix = match segments.next() {
        Some(parent) => format!("/{parent}/{last}"),
        None => format!("/{last}"),
    };
    source == specifier || source.ends_with(&suffix) || source.ends_with(&format!("{suffix}.ts"))
}

fn owned_member(member_node: P<Node>, object: &str, path: &[String]) -> bool {
    let Some((last, parents)) = path.split_last() else {
        return false;
    };
    let member = member_node.as_property_access_expression();
    let prop = member.name();
    if !ast::is_identifier(prop) || prop.as_identifier().text() != last.as_str() {
        return false;
    }
    let mut current = member.expression();
    for segment in parents.iter().rev() {
        let inner = ast::skip_parentheses(current);
        if inner.kind() != Kind::PropertyAccessExpression {
            return false;
        }
        let parent = inner.as_property_access_expression();
        let parent_prop = parent.name();
        if !ast::is_identifier(parent_prop)
            || parent_prop.as_identifier().text() != segment.as_str()
        {
            return false;
        }
        current = parent.expression();
    }
    let inner = ast::skip_parentheses(current);
    match inner.kind() {
        Kind::Identifier => inner.as_identifier().text() == object,
        Kind::PropertyAccessExpression => {
            let access = inner.as_property_access_expression();
            let prop_name = access.name();
            let root = ast::skip_parentheses(access.expression());
            ast::is_identifier(prop_name)
                && prop_name.as_identifier().text() == object
                && ast::is_identifier(root)
                && ["window", "globalThis", "self"].contains(&root.as_identifier().text())
        }
        _ => false,
    }
}
