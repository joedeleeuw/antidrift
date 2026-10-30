use super::owned_union_source::{
    MemberSet, call_site, convex_bindings, is_shadowed_at, literal_type, validator_members,
};
use super::union_owners::union_owners;
use antidrift_kernel::local_binding::Binding;
use antidrift_kernel::registries::OwnedUnion;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, ScopeOptions, decode_rule_options};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-redeclared-owned-union";

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct OwnedUnionOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    allows: BTreeSet<String>,
    statuses: BTreeMap<String, OwnedUnion>,
}

pub(super) struct UnionOwner {
    pub(super) name: String,
    pub(super) binding_name: String,
    pub(super) symbol: Binding,
    pub(super) members: MemberSet,
}

pub struct NoRedeclaredOwnedUnion {
    scope: RuleScope,
    options: OwnedUnionOptions,
}

pub static DEFAULT_RULE: NoRedeclaredOwnedUnion = NoRedeclaredOwnedUnion {
    scope: RuleScope::DEFAULT,
    options: OwnedUnionOptions {
        scope: ScopeOptions {
            files: None,
            exclude_files: Vec::new(),
        },
        allows: BTreeSet::new(),
        statuses: BTreeMap::new(),
    },
};

impl NoRedeclaredOwnedUnion {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let options = decode_rule_options::<OwnedUnionOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &options.scope)?;
        Ok(Self { scope, options })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::LiteralType),
    Listener::Enter(Kind::TypeAliasDeclaration),
    Listener::Enter(Kind::CallExpression),
];

impl Rule for NoRedeclaredOwnedUnion {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        let owners = match union_owners(ctx.program, ctx.file) {
            Ok(owners) => owners,
            Err(error) => {
                ctx.report_range(0, 0, RuleMessage::new("ownerResolution", error));
                return Box::new(EmptyVisitor);
            }
        };
        Box::new(Visitor {
            rule: self,
            owners,
            convex: convex_bindings(ctx.file),
        })
    }
}

struct Visitor {
    rule: &'static NoRedeclaredOwnedUnion,
    owners: Vec<UnionOwner>,
    convex: FxHashSet<Binding>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::LiteralType => {
                if let Some(message) =
                    status_report(node, &self.rule.options.statuses, ctx.file.file_name())
                {
                    ctx.report_node(node, RuleMessage::new("canonicalStatus", message));
                }
            }
            Kind::TypeAliasDeclaration => {
                let alias = node.as_type_alias_declaration();
                let Some(type_node) = alias.type_() else {
                    return;
                };
                if type_node.kind() != Kind::UnionType {
                    return;
                }
                let members = type_node
                    .as_union_type_node()
                    .types()
                    .nodes()
                    .iter()
                    .copied()
                    .map(literal_type)
                    .collect();
                let name_node = alias.name();
                let alias_name =
                    ast::is_identifier(name_node).then(|| name_node.as_identifier().text());
                if let Some((target, msg)) = owner_report(
                    node,
                    type_node,
                    members,
                    alias_name,
                    &self.owners,
                    &self.rule.options.allows,
                ) {
                    ctx.report_node(target, msg);
                }
            }
            Kind::CallExpression => {
                let members = validator_members(node, &self.convex);
                let name = call_site(node);
                if let Some((target, msg)) = owner_report(
                    node,
                    node,
                    members,
                    name.as_deref(),
                    &self.owners,
                    &self.rule.options.allows,
                ) {
                    ctx.report_node(target, msg);
                }
            }
            _ => {}
        }
    }
}

fn owner_report(
    scope_node: P<Node>,
    report_target: P<Node>,
    members: Option<MemberSet>,
    name: Option<&str>,
    owners: &[UnionOwner],
    allows: &BTreeSet<String>,
) -> Option<(P<Node>, RuleMessage)> {
    let members = members?;
    if members.is_empty() || name.is_some_and(|name| allows.contains(name)) {
        return None;
    }
    let owner = owners.iter().find(|owner| {
        owner.members == members && !is_shadowed_at(scope_node, &owner.binding_name, owner.symbol)
    })?;
    Some((
        report_target,
        RuleMessage::new(
            "redeclaredOwner",
            format!(
                "This union re-declares an owned literal value space; derive it from the owning runtime array {}.",
                owner.name
            ),
        ),
    ))
}

fn status_report(
    node: P<Node>,
    statuses: &BTreeMap<String, OwnedUnion>,
    filename: &str,
) -> Option<String> {
    if node.kind() != Kind::LiteralType {
        return None;
    }
    let literal = node.as_literal_type_node().literal();
    if literal.kind() != Kind::StringLiteral {
        return None;
    }
    let text = literal.as_string_literal().text();
    let (_, entry) = statuses.iter().find(|(name, entry)| {
        entry.values.iter().any(|candidate| candidate == text) && status_context(node, name)
    })?;
    if filename
        .replace('\\', "/")
        .ends_with(&entry.owner.replace('\\', "/"))
    {
        return None;
    }
    Some(format!(
        "String literal '{text}' duplicates a canonical status from {}. Import the type instead.",
        entry.owner
    ))
}

fn normalized_name(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|letter| letter.to_ascii_lowercase())
        .collect()
}

fn status_context(node: P<Node>, name: &str) -> bool {
    let key = normalized_name(name);
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        let context = match ancestor.kind() {
            Kind::PropertySignature => return property_context(ancestor, &key),
            Kind::TypeAliasDeclaration
            | Kind::InterfaceDeclaration
            | Kind::VariableDeclaration
            | Kind::Parameter => ancestor
                .name()
                .filter(|id| ast::is_identifier(*id))
                .map(|id| id.as_identifier().text()),
            Kind::Identifier => Some(ancestor.as_identifier().text()),
            _ => None,
        };
        if let Some(context) = context {
            return !context.is_empty() && normalized_name(context) == key;
        }
        cursor = ancestor.parent();
    }
    false
}

fn property_context(property_sig: P<Node>, key: &str) -> bool {
    let property_name = property_sig
        .name()
        .map(|prop| match prop.kind() {
            Kind::Identifier => prop.as_identifier().text(),
            Kind::PrivateIdentifier => prop.as_private_identifier().text(),
            Kind::StringLiteral => prop.as_string_literal().text(),
            _ => "",
        })
        .unwrap_or("");
    if !property_name.is_empty() && normalized_name(property_name) == key {
        return true;
    }
    let mut owner = None;
    let mut cursor = property_sig.parent();
    while let Some(ancestor) = cursor {
        if matches!(
            ancestor.kind(),
            Kind::TypeAliasDeclaration | Kind::InterfaceDeclaration
        ) && let Some(name_node) = ancestor.name()
            && ast::is_identifier(name_node)
        {
            owner = Some(name_node.as_identifier().text());
            break;
        }
        cursor = ancestor.parent();
    }
    owner.is_some_and(|owner| normalized_name(&format!("{owner}{property_name}")) == key)
}
