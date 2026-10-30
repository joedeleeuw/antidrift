use crate::jsx::plain_attribute_name;
use crate::local_binding::{
    Binding, binding_for_declarator, collect_binding_references, is_write_reference,
};
use crate::tsrs_kernel::{cooked_text, node_range};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

const CLASS_HELPERS: [&str; 4] = ["clsx", "cn", "cva", "twMerge"];

#[derive(Clone, Copy)]
pub struct StringFragment {
    pub node: P<Node>,
    pub text: &'static str,
}

#[must_use]
pub fn string_fragments(sf: P<SourceFile>) -> Vec<StringFragment> {
    let mut out = Vec::new();
    collect_fragments(sf, sf.as_node(), &mut out);
    out
}

fn collect_fragments(sf: P<SourceFile>, node: P<Node>, out: &mut Vec<StringFragment>) {
    let src = sf.text();
    match node.kind() {
        Kind::StringLiteral => {
            if let Some(text) = cooked_text(node) {
                out.push(StringFragment { node, text });
            }
        }
        Kind::NoSubstitutionTemplateLiteral | Kind::TemplateTail => {
            let (start, end) = node_range(sf, node);
            if end >= start + 2 {
                out.push(StringFragment {
                    node,
                    text: &src[start + 1..end - 1],
                });
            }
        }
        Kind::TemplateHead | Kind::TemplateMiddle => {
            let (start, end) = node_range(sf, node);
            if end >= start + 3 {
                out.push(StringFragment {
                    node,
                    text: &src[start + 1..end - 2],
                });
            }
        }
        _ => {}
    }
    node.for_each_child(&mut |child| {
        collect_fragments(sf, child, out);
        false
    });
}

#[must_use]
pub fn class_fragments(sf: P<SourceFile>) -> Vec<StringFragment> {
    string_fragments(sf)
        .into_iter()
        .filter(|fragment| is_class_value(sf, fragment.node, &FxHashSet::default()))
        .collect()
}

fn is_class_property_key(key: P<Node>) -> bool {
    match key.kind() {
        Kind::Identifier => key.as_identifier().text() == "className",
        Kind::StringLiteral => cooked_text(key) == Some("className"),
        _ => false,
    }
}

fn is_class_helper_call(callee: P<Node>) -> bool {
    ast::is_identifier(callee) && CLASS_HELPERS.contains(&callee.as_identifier().text())
}

fn binding_feeds_class_value(
    sf: P<SourceFile>,
    binding: Binding,
    seen: &FxHashSet<Binding>,
) -> bool {
    if seen.contains(&binding) {
        return false;
    }
    let mut branch_seen = seen.clone();
    branch_seen.insert(binding);
    collect_binding_references(sf.as_node(), binding)
        .into_iter()
        .any(|reference| {
            !is_write_reference(reference) && is_class_value(sf, reference, &branch_seen)
        })
}

#[must_use]
pub fn is_class_value(sf: P<SourceFile>, node: P<Node>, seen: &FxHashSet<Binding>) -> bool {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        match ancestor.kind() {
            Kind::VariableDeclaration => {
                return binding_for_declarator(ancestor)
                    .is_some_and(|binding| binding_feeds_class_value(sf, binding, seen));
            }
            Kind::JsxAttribute => {
                return plain_attribute_name(ancestor) == Some("className");
            }
            Kind::PropertyAssignment => {
                return is_class_property_key(ancestor.as_property_assignment().name());
            }
            Kind::ShorthandPropertyAssignment => {
                return is_class_property_key(ancestor.as_shorthand_property_assignment().name());
            }
            Kind::CallExpression => {
                return is_class_helper_call(ancestor.as_call_expression().expression());
            }
            Kind::TemplateExpression
            | Kind::TemplateSpan
            | Kind::NoSubstitutionTemplateLiteral
            | Kind::JsxExpression
            | Kind::ConditionalExpression
            | Kind::BinaryExpression
            | Kind::ArrayLiteralExpression
            | Kind::ParenthesizedExpression => {}
            _ => return false,
        }
        cursor = ancestor.parent();
    }
    false
}
