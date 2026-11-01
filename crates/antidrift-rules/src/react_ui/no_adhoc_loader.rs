use antidrift_kernel::jsx::{opening_tag_name_node, plain_attribute_name, plain_element_name};
use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use antidrift_kernel::rule_options::{
    NonEmptyString, deserialize_non_empty, deserialize_optional_non_empty,
};
use antidrift_kernel::tsrs_kernel::{cooked_text, unwrap_parentheses};
use serde::Deserialize;
use serde::de::{self, Deserializer, MapAccess};
use std::fmt;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

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

#[derive(Clone, Debug)]
struct DocumentedAllowedFile {
    path: NonEmptyString,
}

impl<'de> Deserialize<'de> for DocumentedAllowedFile {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Entry {
            #[serde(deserialize_with = "deserialize_allowed_path")]
            path: NonEmptyString,
            #[serde(deserialize_with = "deserialize_allowed_reason")]
            reason: NonEmptyString,
        }
        let Entry { path, reason } = Entry::deserialize(deserializer)?;
        drop(reason);
        Ok(Self { path })
    }
}

fn deserialize_allowed_path<'de, D: Deserializer<'de>>(d: D) -> Result<NonEmptyString, D::Error> {
    deserialize_non_empty(d, "allowedFiles[].path")
}

fn deserialize_allowed_reason<'de, D: Deserializer<'de>>(d: D) -> Result<NonEmptyString, D::Error> {
    deserialize_non_empty(d, "allowedFiles[].reason")
}

fn deserialize_owner<'de, D: Deserializer<'de>>(d: D) -> Result<Option<NonEmptyString>, D::Error> {
    deserialize_optional_non_empty(d, "owner")
}

fn deserialize_skeleton<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<NonEmptyString>, D::Error> {
    deserialize_optional_non_empty(d, "skeleton")
}

#[derive(Clone, Debug)]
enum AllowedFile {
    Suffix(String),
    Documented(DocumentedAllowedFile),
}

impl<'de> Deserialize<'de> for AllowedFile {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct AllowedFileVisitor;

        impl<'de> de::Visitor<'de> for AllowedFileVisitor {
            type Value = AllowedFile;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(
                    formatter,
                    "a path suffix string or a {{ path, reason }} object"
                )
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(AllowedFile::Suffix(value.to_owned()))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(AllowedFile::Suffix(value))
            }

            fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<Self::Value, M::Error> {
                DocumentedAllowedFile::deserialize(de::value::MapAccessDeserializer::new(map))
                    .map(AllowedFile::Documented)
            }
        }

        deserializer.deserialize_any(AllowedFileVisitor)
    }
}

impl AllowedFile {
    fn suffix(&self) -> &str {
        match self {
            Self::Suffix(path) => path,
            Self::Documented(documented) => documented.path.as_str(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct AdhocLoaderOptions {
    loader_icons: Option<Vec<String>>,
    #[serde(deserialize_with = "deserialize_owner")]
    owner: Option<NonEmptyString>,
    #[serde(deserialize_with = "deserialize_skeleton")]
    skeleton: Option<NonEmptyString>,
    allowed_files: Vec<AllowedFile>,
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
    options: AdhocLoaderOptions,
}

pub static DEFAULT_RULE: NoAdhocLoader = NoAdhocLoader {
    options: AdhocLoaderOptions {
        loader_icons: None,
        owner: None,
        skeleton: None,
        allowed_files: Vec::new(),
    },
};

impl crate::ConfigurableRule for NoAdhocLoader {
    type Options = AdhocLoaderOptions;

    fn from_options(parsed: Self::Options) -> Result<Self, String> {
        Ok(Self { options: parsed })
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
        let enabled = !allowed;
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
        Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral => out.extend(cooked_text(inner)),
        Kind::TemplateExpression => {
            let tpl = inner.as_template_expression();
            out.extend(cooked_text(tpl.head()));
            for &span in tpl.template_spans().nodes() {
                out.extend(cooked_text(span.as_template_span().literal()));
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
        Kind::StringLiteral => out.extend(cooked_text(init)),
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
