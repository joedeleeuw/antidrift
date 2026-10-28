use antidrift_kernel::jsx::{
    has_plain_attribute, jsx_children, jsx_opening_node, plain_element_name,
};
use antidrift_kernel::rule_scope::{
    RuleScope, ScopeOptions, ScopedOptions, decode_scoped, in_scope, require_non_empty,
};
use antidrift_kernel::tsrs_kernel::unwrap_parentheses;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-dir-on-rendered-name";
const DEFAULT_OWNER: &str = "Unicode FSI (\\u2068) and PDI (\\u2069), or an HTML bdi element";
const NAME_PROPS: [&str; 17] = [
    "displayName",
    "fullName",
    "firstName",
    "lastName",
    "clientName",
    "contactName",
    "organizationName",
    "partyName",
    "authorName",
    "workspaceName",
    "matterName",
    "entityName",
    "fileName",
    "folderName",
    "email",
    "caseNumber",
    "citationText",
];
const SELF_ISOLATING: [&str; 2] = ["BidiText", "UserText"];
const RAW_ISOLATING: [&str; 2] = ["bdi", "bdo"];

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct RenderedNameOptions {
    files: Option<Vec<String>>,
    exclude_files: Vec<String>,
    name_props: Option<Vec<String>>,
    isolating_components: Option<Vec<String>>,
    owner: Option<String>,
}

impl ScopedOptions for RenderedNameOptions {
    fn scope(&self) -> ScopeOptions {
        ScopeOptions {
            files: self.files.clone(),
            exclude_files: self.exclude_files.clone(),
        }
    }

    fn validate(&self, rule_name: &str) -> Result<(), String> {
        require_non_empty(rule_name, "owner", self.owner.as_ref())
    }
}

impl RenderedNameOptions {
    fn is_name_prop(&self, name: &str) -> bool {
        self.name_props
            .as_ref()
            .map_or(NAME_PROPS.contains(&name), |names| {
                names.iter().any(|candidate| candidate == name)
            })
    }

    fn is_isolating_component(&self, name: &str) -> bool {
        self.isolating_components
            .as_ref()
            .map_or(SELF_ISOLATING.contains(&name), |names| {
                names.iter().any(|candidate| candidate == name)
            })
    }
}

pub struct RequireDirOnRenderedName {
    scope: RuleScope,
    options: RenderedNameOptions,
}

pub static DEFAULT_RULE: RequireDirOnRenderedName = RequireDirOnRenderedName {
    scope: RuleScope::DEFAULT,
    options: RenderedNameOptions {
        files: None,
        exclude_files: Vec::new(),
        name_props: None,
        isolating_components: None,
        owner: None,
    },
};

impl RequireDirOnRenderedName {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let (parsed, scope) = decode_scoped::<RenderedNameOptions>(RULE_NAME, options)?;
        Ok(Self {
            scope,
            options: parsed,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::JsxElement)];

impl Rule for RequireDirOnRenderedName {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        Box::new(Visitor {
            rule: self,
            enabled,
        })
    }
}

struct Visitor {
    rule: &'static RequireDirOnRenderedName,
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let owner = self.rule.options.owner.as_deref().unwrap_or(DEFAULT_OWNER);
        for (target, msg) in element_reports(node, &self.rule.options, owner) {
            ctx.report_node(target, msg);
        }
    }
}

fn is_meaningful(child: P<Node>) -> bool {
    !(child.kind() == Kind::JsxText && child.as_jsx_text().text().trim().is_empty())
}

fn renders_name(child: P<Node>, options: &RenderedNameOptions) -> bool {
    if child.kind() != Kind::JsxExpression {
        return false;
    }
    let Some(expr) = child
        .as_jsx_expression()
        .expression()
        .map(unwrap_parentheses)
    else {
        return false;
    };
    match expr.kind() {
        Kind::PropertyAccessExpression => {
            let prop = expr.as_property_access_expression().name();
            ast::is_identifier(prop) && options.is_name_prop(prop.as_identifier().text())
        }
        Kind::ElementAccessExpression => {
            let arg = expr.as_element_access_expression().argument_expression();
            ast::is_identifier(arg) && options.is_name_prop(arg.as_identifier().text())
        }
        _ => false,
    }
}

fn element_reports(
    element: P<Node>,
    options: &RenderedNameOptions,
    owner: &str,
) -> Vec<(P<Node>, RuleMessage)> {
    let element_name = plain_element_name(element);
    if element_name.is_some_and(|name| options.is_isolating_component(name)) {
        return Vec::new();
    }
    let kids: Vec<P<Node>> = jsx_children(element)
        .iter()
        .copied()
        .filter(|&child| is_meaningful(child))
        .collect();
    let name_kids: Vec<P<Node>> = kids
        .iter()
        .copied()
        .filter(|&child| renders_name(child, options))
        .collect();
    if name_kids.is_empty() {
        return Vec::new();
    }
    if kids.len() == 1 {
        let isolated = has_plain_attribute(element, "dir")
            || element_name.is_some_and(|name| RAW_ISOLATING.contains(&name));
        if isolated {
            return Vec::new();
        }
        return vec![(
            jsx_opening_node(element),
            RuleMessage::new(
                "missingDir",
                format!(
                    "Isolate external names with {owner} so bidirectional text cannot reorder surrounding content."
                ),
            ),
        )];
    }
    name_kids
        .into_iter()
        .map(|child| {
            (
                child,
                RuleMessage::new(
                    "missingBidi",
                    format!(
                        "Isolate this external name with {owner}; setting direction on the parent would also reorder its siblings."
                    ),
                ),
            )
        })
        .collect()
}
