use super::omitted_prop_keys::{omitted_keys_of, reintroduced_keys_of};
use antidrift_kernel::jsx::{
    jsx_attributes_list, jsx_children, jsx_opening_node, plain_attribute_name,
};
use antidrift_kernel::local_binding::{Binding, resolve_lexical_binding};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::{is_function_like, unwrap_expression};
use antidrift_kernel::type_syntax::{LocalTypeAliases, property_key_name};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-omitted-prop-respread";

pub struct NoOmittedPropRespread {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoOmittedPropRespread = NoOmittedPropRespread {
    scope: RuleScope::DEFAULT,
};

impl NoOmittedPropRespread {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::JsxElement),
    Listener::Enter(Kind::JsxSelfClosingElement),
];

impl Rule for NoOmittedPropRespread {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !in_scope(&self.scope, ctx, None) {
            return Box::new(Visitor {
                omitted: FxHashMap::default(),
            });
        }
        let aliases = LocalTypeAliases::collect(ctx.file);
        let mut omitted = FxHashMap::default();
        collect_function_omitted(ctx.file.as_node(), &aliases, &mut omitted);
        Box::new(Visitor { omitted })
    }
}

struct Visitor {
    omitted: FxHashMap<Binding, Vec<String>>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.omitted.is_empty() {
            &[]
        } else {
            LISTENERS
        }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        for key in spread_omitted_keys(node, &self.omitted) {
            if let Some((target, msg)) = key_report(node, &key) {
                ctx.report_node(target, msg);
            }
        }
    }
}

fn props_binding(param: P<Node>) -> Option<Binding> {
    let name_node = param.name()?;
    match name_node.kind() {
        Kind::Identifier => Some(Binding {
            decl: param,
            ident: name_node,
        }),
        Kind::ObjectBindingPattern => name_node
            .as_binding_pattern()
            .elements()
            .nodes()
            .iter()
            .copied()
            .find_map(|elem| {
                let rest = (elem.kind() == Kind::BindingElement
                    && elem.as_binding_element().dot_dot_dot_token().is_some())
                .then(|| elem.name())
                .flatten()?;
                ast::is_identifier(rest).then_some(Binding {
                    decl: elem,
                    ident: rest,
                })
            }),
        _ => None,
    }
}

fn destructured_keys(pattern: P<Node>) -> Vec<String> {
    if pattern.kind() != Kind::ObjectBindingPattern {
        return Vec::new();
    }
    pattern
        .as_binding_pattern()
        .elements()
        .nodes()
        .iter()
        .filter_map(|&elem| {
            if elem.kind() != Kind::BindingElement {
                return None;
            }
            let binding_elem = elem.as_binding_element();
            if binding_elem.dot_dot_dot_token().is_some() {
                return None;
            }
            let key_node = binding_elem.property_name().or_else(|| elem.name())?;
            (key_node.kind() != Kind::ComputedPropertyName)
                .then(|| property_key_name(key_node))
                .flatten()
        })
        .collect()
}

fn collect_function_omitted(
    node: P<Node>,
    aliases: &LocalTypeAliases,
    omitted: &mut FxHashMap<Binding, Vec<String>>,
) {
    if is_function_like(node)
        && let Some(&param) = node.parameters().first()
        && let Some(binding) = props_binding(param)
    {
        let props_type = param.as_parameter_declaration().type_();
        let mut open = FxHashSet::default();
        let mut carried: FxHashSet<String> = param
            .name()
            .map(destructured_keys)
            .unwrap_or_default()
            .into_iter()
            .collect();
        carried.extend(reintroduced_keys_of(aliases, props_type, &mut open));
        let keys: Vec<String> = omitted_keys_of(aliases, props_type, &mut open)
            .into_iter()
            .filter(|key| !carried.contains(key))
            .collect();
        if !keys.is_empty() {
            omitted.insert(binding, keys);
        }
    }
    node.for_each_child(&mut |child| {
        collect_function_omitted(child, aliases, omitted);
        false
    });
}

fn unwrap_spread(mut expression: P<Node>) -> P<Node> {
    loop {
        expression = unwrap_expression(expression);
        if expression.kind() == Kind::ExpressionWithTypeArguments {
            expression = expression.as_expression_with_type_arguments().expression();
        } else {
            return expression;
        }
    }
}

fn spread_can_deliver(spread: P<Node>, key: &str) -> bool {
    let inner = unwrap_spread(spread.as_jsx_spread_attribute().expression());
    if inner.kind() != Kind::ObjectLiteralExpression {
        return true;
    }
    inner
        .as_object_literal_expression()
        .properties()
        .nodes()
        .iter()
        .any(|&prop| match prop.kind() {
            Kind::SpreadAssignment => true,
            Kind::PropertyAssignment => {
                let name = prop.as_property_assignment().name();
                name.kind() == Kind::ComputedPropertyName
                    || property_key_name(name).as_deref() == Some(key)
            }
            Kind::ShorthandPropertyAssignment => {
                let name = prop.as_shorthand_property_assignment().name();
                property_key_name(name).as_deref() == Some(key)
            }
            _ => false,
        })
}

fn is_rendered_child(child: P<Node>) -> bool {
    match child.kind() {
        Kind::JsxText => {
            let text = child.as_jsx_text().text();
            !text.trim().is_empty() || !text.contains('\n')
        }
        Kind::JsxExpression => child.as_jsx_expression().expression().is_some(),
        _ => true,
    }
}

fn spread_omitted_keys(element: P<Node>, omitted: &FxHashMap<Binding, Vec<String>>) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for &item in jsx_attributes_list(element) {
        if item.kind() != Kind::JsxSpreadAttribute {
            continue;
        }
        let expr = unwrap_spread(item.as_jsx_spread_attribute().expression());
        let Some(omitted_keys) = ast::is_identifier(expr)
            .then(|| resolve_lexical_binding(expr))
            .flatten()
            .and_then(|binding| omitted.get(&binding))
        else {
            continue;
        };
        for key in omitted_keys {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
    }
    keys
}

fn key_report(element: P<Node>, key: &str) -> Option<(P<Node>, RuleMessage)> {
    if key == "children" && jsx_children(element).iter().copied().any(is_rendered_child) {
        return None;
    }
    let attributes = jsx_attributes_list(element);
    let last_override = attributes.iter().rposition(|&item| {
        item.kind() == Kind::JsxSpreadAttribute && spread_can_deliver(item, key)
    })?;
    let pin = attributes.iter().enumerate().find_map(|(index, &item)| {
        (plain_attribute_name(item) == Some(key)).then_some((index, item))
    });
    match pin {
        Some((index, _)) if index > last_override => None,
        Some((_, attribute)) => Some((
            attribute,
            RuleMessage::new(
                "pinnedBeforeSpread",
                format!(
                    "`{key}` is omitted from this component's props but written before the props spread, so the spread overwrites it. A value typed wider than the omitting parameter still carries `{key}` at runtime — `Omit` narrows what callers may write, not what a spread can deliver. Move the attribute after the last spread."
                ),
            ),
        )),
        None => Some((
            jsx_opening_node(element),
            RuleMessage::new(
                "suppliedBySpread",
                format!(
                    "`{key}` is omitted from this component's props but the props spread can still deliver it: `Omit` narrows what callers may write literally, while a value typed wider stays assignable and keeps the key at runtime. Pin `{key}` after the last spread, or suppress with a reason if it is meant to pass through."
                ),
            ),
        )),
    }
}
