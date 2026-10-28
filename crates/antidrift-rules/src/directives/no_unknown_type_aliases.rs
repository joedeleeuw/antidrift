use antidrift_kernel::rule_scope::RuleScope;
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-unknown-type-aliases";

pub struct NoUnknownTypeAliases {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoUnknownTypeAliases = NoUnknownTypeAliases {
    scope: RuleScope::DEFAULT,
};

impl NoUnknownTypeAliases {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];

impl Rule for NoUnknownTypeAliases {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let enabled = self.scope.matches(ctx.file.file_name(), cwd);
        Box::new(Visitor { enabled })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
        let mut aliases: FxHashMap<&'static str, P<Node>> = FxHashMap::default();
        let mut ordered_names = Vec::new();
        for &stmt in ctx.file.statements().nodes() {
            if stmt.kind() != Kind::TypeAliasDeclaration {
                continue;
            }
            let Some(name_node) = stmt.name() else {
                continue;
            };
            if !ast::is_identifier(name_node) {
                continue;
            }
            let name = name_node.as_identifier().text();
            if !aliases.contains_key(name) {
                ordered_names.push(name);
            }
            aliases.insert(name, stmt);
        }
        for name in ordered_names {
            let Some(&decl) = aliases.get(name) else {
                continue;
            };
            let mut visited = FxHashSet::default();
            visited.insert(name);
            let Some(type_node) = decl.as_type_alias_declaration().type_() else {
                continue;
            };
            if resolves_to_unknown(type_node, &aliases, &mut visited) {
                let target = decl.name().unwrap_or(decl);
                ctx.report_node(
                    target,
                    RuleMessage::new(
                        "unknownAlias",
                        format!(
                            "Type alias `{name}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type."
                        ),
                    ),
                );
            }
        }
    }
}

fn resolves_to_unknown(
    type_node: P<Node>,
    aliases: &FxHashMap<&'static str, P<Node>>,
    visited: &mut FxHashSet<&'static str>,
) -> bool {
    match type_node.kind() {
        Kind::UnknownKeyword => true,
        Kind::ParenthesizedType => resolves_to_unknown(
            type_node.as_parenthesized_type_node().type_(),
            aliases,
            visited,
        ),
        _ => {
            let Some(target_name) = referenced_alias_name(type_node) else {
                return false;
            };
            if !visited.insert(target_name) {
                return false;
            }
            let Some(&alias_decl) = aliases.get(target_name) else {
                return false;
            };
            if !alias_decl.type_parameters().is_empty() {
                return false;
            }
            let Some(alias_type) = alias_decl.as_type_alias_declaration().type_() else {
                return false;
            };
            resolves_to_unknown(alias_type, aliases, visited)
        }
    }
}

fn referenced_alias_name(type_node: P<Node>) -> Option<&'static str> {
    match type_node.kind() {
        Kind::ParenthesizedType => {
            referenced_alias_name(type_node.as_parenthesized_type_node().type_())
        }
        Kind::TypeReference => {
            if !type_node.type_arguments().is_empty() {
                return None;
            }
            let name = type_node.as_type_reference_node().type_name();
            ast::is_identifier(name).then(|| name.as_identifier().text())
        }
        _ => None,
    }
}
