use antidrift_kernel::jsx::{opening_tag_name_node, plain_attribute_name, plain_element_name};
use antidrift_kernel::rule_scope::{
    RuleScope, ScopeOptions, ScopedOptions, decode_scoped, in_scope, require_non_empty,
};
use antidrift_kernel::tsrs_kernel::unwrap_parentheses;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-adhoc-loader";
const LOADER_ICON_NAMES: [&str; 4] = [
    "LoaderIcon",
    "Loader2Icon",
    "LoaderCircleIcon",
    "LoaderPinwheelIcon",
];
const BANNED_UTILITIES: [&str; 2] = ["spin", "pulse"];
const DEFAULT_OWNER: &str = "the HTML progress element";
const DEFAULT_SKELETON: &str = "accessible placeholder text";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentedAllowedFile {
    path: String,
    #[serde(rename = "reason")]
    _reason: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum AllowedFile {
    Suffix(String),
    Documented(DocumentedAllowedFile),
}

impl AllowedFile {
    fn suffix(&self) -> &str {
        match self {
            Self::Suffix(path) => path,
            Self::Documented(documented) => &documented.path,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct AdhocLoaderOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    loader_icons: Option<Vec<String>>,
    owner: Option<String>,
    skeleton: Option<String>,
    allowed_files: Vec<AllowedFile>,
}

impl ScopedOptions for AdhocLoaderOptions {
    fn scope(&self) -> ScopeOptions {
        self.scope.clone()
    }

    fn validate(&self, rule_name: &str) -> Result<(), String> {
        require_non_empty(rule_name, "owner", self.owner.as_ref())?;
        require_non_empty(rule_name, "skeleton", self.skeleton.as_ref())
    }
}

impl AdhocLoaderOptions {
    fn is_loader_icon(&self, name: &str) -> bool {
        self.loader_icons
            .as_ref()
            .map_or(LOADER_ICON_NAMES.contains(&name), |icons| {
                icons.iter().any(|icon| icon == name)
            })
    }
}

pub struct NoAdhocLoader {
    scope: RuleScope,
    options: AdhocLoaderOptions,
}

pub static DEFAULT_RULE: NoAdhocLoader = NoAdhocLoader {
    scope: RuleScope::DEFAULT,
    options: AdhocLoaderOptions {
        scope: ScopeOptions {
            files: None,
            exclude_files: Vec::new(),
        },
        loader_icons: None,
        owner: None,
        skeleton: None,
        allowed_files: Vec::new(),
    },
};

impl NoAdhocLoader {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let (parsed, scope) = decode_scoped::<AdhocLoaderOptions>(RULE_NAME, options)?;
        Ok(Self {
            scope,
            options: parsed,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::JsxOpeningElement),
    Listener::Enter(Kind::JsxSelfClosingElement),
    Listener::Enter(Kind::JsxAttribute),
];

impl Rule for NoAdhocLoader {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let filename = ctx.file.file_name().replace('\\', "/");
        let allowed = self
            .options
            .allowed_files
            .iter()
            .any(|entry| filename.ends_with(entry.suffix()));
        let enabled = !allowed && in_scope(&self.scope, ctx, None);
        Box::new(Visitor {
            rule: self,
            enabled,
        })
    }
}

struct Visitor {
    rule: &'static NoAdhocLoader,
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let owner = self.rule.options.owner.as_deref().unwrap_or(DEFAULT_OWNER);
        let skeleton = self
            .rule
            .options
            .skeleton
            .as_deref()
            .unwrap_or(DEFAULT_SKELETON);
        match node.kind() {
            Kind::JsxOpeningElement | Kind::JsxSelfClosingElement => {
                if let Some(msg) = loader_icon_report(node, &self.rule.options, owner) {
                    ctx.report_node(node, msg);
                }
            }
            Kind::JsxAttribute => {
                if let Some(msg) = attribute_report(node, owner, skeleton) {
                    ctx.report_node(node, msg);
                }
            }
            _ => {}
        }
    }
}

fn element_name(node: P<Node>) -> Option<&'static str> {
    let tag = opening_tag_name_node(node)?;
    if tag.kind() == Kind::PropertyAccessExpression {
        let prop = tag.as_property_access_expression().name();
        return ast::is_identifier(prop).then(|| prop.as_identifier().text());
    }
    plain_element_name(node)
}

fn expression_strings(expression: P<Node>, out: &mut Vec<&'static str>) {
    let inner = unwrap_parentheses(expression);
    match inner.kind() {
        Kind::StringLiteral => out.push(inner.as_string_literal().text()),
        Kind::NoSubstitutionTemplateLiteral => out.push(inner.text()),
        Kind::TemplateExpression => {
            let tpl = inner.as_template_expression();
            out.push(tpl.head().text());
            for &span in tpl.template_spans().nodes() {
                out.push(span.as_template_span().literal().text());
            }
        }
        Kind::CallExpression => {
            for &argument in inner.as_call_expression().arguments().nodes() {
                if argument.kind() != Kind::SpreadElement {
                    expression_strings(argument, out);
                }
            }
        }
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            if matches!(
                bin.operator_token().kind(),
                Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
            ) {
                expression_strings(bin.left(), out);
                expression_strings(bin.right(), out);
            }
        }
        Kind::ConditionalExpression => {
            let cond = inner.as_conditional_expression();
            expression_strings(cond.when_true(), out);
            expression_strings(cond.when_false(), out);
        }
        _ => {}
    }
}

fn attribute_strings(attribute: P<Node>) -> Vec<&'static str> {
    let mut out = Vec::new();
    let Some(init) = attribute.as_jsx_attribute().initializer() else {
        return out;
    };
    match init.kind() {
        Kind::StringLiteral => out.push(init.as_string_literal().text()),
        Kind::JsxExpression => {
            if let Some(expr) = init.as_jsx_expression().expression() {
                expression_strings(expr, &mut out);
            }
        }
        _ => {}
    }
    out
}

fn banned_utility(part: &str) -> Option<&'static str> {
    part.match_indices("animate-").find_map(|(index, _)| {
        let preceded = part[..index]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace);
        let rest = &part[index + "animate-".len()..];
        BANNED_UTILITIES.iter().copied().find(|utility| {
            preceded
                && rest
                    .strip_prefix(utility)
                    .is_some_and(|after| after.chars().next().is_none_or(char::is_whitespace))
        })
    })
}

fn attribute_report(attribute: P<Node>, owner: &str, skeleton: &str) -> Option<RuleMessage> {
    match plain_attribute_name(attribute)? {
        "role" => attribute_strings(attribute).contains(&"progressbar").then(|| {
            RuleMessage::new(
                "progressbar",
                format!("Do not hand-roll a progress bar. Use {owner} with accessible progress text."),
            )
        }),
        "className" => attribute_strings(attribute)
            .into_iter()
            .find_map(banned_utility)
            .map(|utility| {
                RuleMessage::new(
                    "animateUtility",
                    format!(
                        "Do not build a loading indicator from 'animate-{utility}'. Use {owner} or {skeleton} for content with a known shape."
                    ),
                )
            }),
        _ => None,
    }
}

fn loader_icon_report(
    opening: P<Node>,
    options: &AdhocLoaderOptions,
    owner: &str,
) -> Option<RuleMessage> {
    let name = element_name(opening).filter(|name| options.is_loader_icon(name))?;
    Some(RuleMessage::new(
        "loaderIcon",
        format!("Do not render '{name}' as a loading indicator. Use {owner}."),
    ))
}
