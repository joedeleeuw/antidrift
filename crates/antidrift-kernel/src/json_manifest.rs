use oxc::allocator::Allocator;
use oxc::ast::ast::{Expression, ObjectPropertyKind, PropertyKey};
use oxc::parser::Parser;
use oxc::span::{GetSpan, SourceType, Span};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonPropertySpan {
    pub key: String,
    pub key_span: Span,
    pub value_span: Span,
    pub string_value: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackageJsonManifest {
    pub top_level_properties: BTreeMap<String, Span>,
    pub sections: BTreeMap<String, Vec<JsonPropertySpan>>,
}

#[must_use]
pub fn parse_package_json_manifest(source_text: &str) -> Option<PackageJsonManifest> {
    let wrapped = format!("({source_text}\n)");
    let allocator = Allocator::default();
    let Ok(parsed) = Parser::new(&allocator, &wrapped, SourceType::mjs()).parse_expression() else {
        return None;
    };
    let expr = parsed.without_parentheses();
    let Expression::ObjectExpression(root_obj) = expr else {
        return None;
    };

    let mut top_level_properties = BTreeMap::new();
    let mut sections: BTreeMap<String, Vec<JsonPropertySpan>> = BTreeMap::new();

    for prop_kind in &root_obj.properties {
        let ObjectPropertyKind::ObjectProperty(prop) = prop_kind else {
            continue;
        };
        let Some((key_name, key_span)) = extract_key_and_span(&prop.key) else {
            continue;
        };
        top_level_properties.insert(key_name.clone(), key_span);
        if let Expression::ObjectExpression(nested_obj) = prop.value.without_parentheses() {
            sections.insert(key_name, collect_nested_properties(&nested_obj.properties));
        }
    }

    Some(PackageJsonManifest {
        top_level_properties,
        sections,
    })
}

fn collect_nested_properties(
    properties: &oxc::allocator::Vec<'_, ObjectPropertyKind<'_>>,
) -> Vec<JsonPropertySpan> {
    let mut entries = Vec::new();
    for nested_kind in properties {
        let ObjectPropertyKind::ObjectProperty(nested_prop) = nested_kind else {
            continue;
        };
        let Some((dep_name, dep_key_span)) = extract_key_and_span(&nested_prop.key) else {
            continue;
        };
        let val_span = unshift_span(nested_prop.value.span());
        let string_value = match nested_prop.value.without_parentheses() {
            Expression::StringLiteral(str_lit) => Some(str_lit.value.to_string()),
            _ => None,
        };
        entries.push(JsonPropertySpan {
            key: dep_name,
            key_span: dep_key_span,
            value_span: val_span,
            string_value,
        });
    }
    entries
}

fn extract_key_and_span(key: &PropertyKey<'_>) -> Option<(String, Span)> {
    match key {
        PropertyKey::StringLiteral(lit) => Some((lit.value.to_string(), unshift_span(lit.span))),
        PropertyKey::StaticIdentifier(id) => Some((id.name.to_string(), unshift_span(id.span))),
        _ => None,
    }
}

const fn unshift_span(span: Span) -> Span {
    Span::new(span.start.saturating_sub(1), span.end.saturating_sub(1))
}
