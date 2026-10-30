use super::wire_shape::{WireField, WireLiteral, WireShape};

pub(super) fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\""))
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|rest| rest.is_ascii_alphanumeric() || rest == '_' || rest == '$')
}

fn js_key(name: &str) -> String {
    if is_identifier(name) {
        name.to_owned()
    } else {
        js_string(name)
    }
}

fn literal_js(value: &WireLiteral) -> String {
    match value {
        WireLiteral::Text(text) => js_string(text),
        WireLiteral::Number(number) => format!("{number}"),
        WireLiteral::Flag(flag) => format!("{flag}"),
    }
}

#[derive(Clone, Copy)]
struct Site<'a> {
    raw: &'a str,
    path: &'a str,
    depth: usize,
}

fn decoder_expr(shape: &WireShape, site: Site<'_>) -> String {
    let Site { raw, path, .. } = site;
    match shape {
        WireShape::String => format!("expectString({raw}, {path})"),
        WireShape::Number => format!("expectNumber({raw}, {path})"),
        WireShape::Boolean => format!("expectBoolean({raw}, {path})"),
        WireShape::Null => format!("expectNull({raw}, {path})"),
        WireShape::Date => format!("expectDate({raw}, {path})"),
        WireShape::Literal { value } => {
            format!("expectLiteral({raw}, {path}, {})", literal_js(value))
        }
        WireShape::Array { items } => array_expr(items, site),
        WireShape::Object { fields } => object_expr(fields, site),
        WireShape::Union { variants } => union_expr(variants, site),
    }
}

fn array_expr(items: &WireShape, site: Site<'_>) -> String {
    let item = format!("item{}", site.depth);
    let item_path = format!("itemPath{}", site.depth);
    let inner = decoder_expr(
        items,
        Site {
            raw: &item,
            path: &item_path,
            depth: site.depth + 1,
        },
    );
    format!(
        "expectArray({}, {}, ({item}, {item_path}) => {inner})",
        site.raw, site.path
    )
}

fn template_text(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("${", "\\${")
}

fn child_path(parent: &str, field: &str) -> String {
    let field = template_text(field);
    match parent
        .strip_prefix('`')
        .and_then(|rest| rest.strip_suffix('`'))
    {
        Some(template) => format!("`{template}.{field}`"),
        None => format!("`${{{parent}}}.{field}`"),
    }
}

fn field_entry(field: &WireField, record: &str, site: Site<'_>) -> String {
    let access = format!("{record}[{}]", js_string(&field.name));
    let field_path = child_path(site.path, &field.name);
    let inner = decoder_expr(
        &field.shape,
        Site {
            raw: &access,
            path: &field_path,
            depth: site.depth + 1,
        },
    );
    let key = js_key(&field.name);
    if field.optional {
        format!("...({access} === undefined ? {{}} : {{ {key}: {inner} }})")
    } else {
        format!("{key}: {inner}")
    }
}

fn object_expr(fields: &[WireField], site: Site<'_>) -> String {
    let record = format!("record{}", site.depth);
    let entries: Vec<String> = fields
        .iter()
        .map(|field| field_entry(field, &record, site))
        .collect();
    format!(
        "expectObject({}, {}, ({record}) => ({{ {} }}))",
        site.raw,
        site.path,
        entries.join(", ")
    )
}

fn union_expr(variants: &[WireShape], site: Site<'_>) -> String {
    let raw = format!("raw{}", site.depth);
    let path = format!("path{}", site.depth);
    let arms: Vec<String> = variants
        .iter()
        .map(|variant| {
            let inner = decoder_expr(
                variant,
                Site {
                    raw: &raw,
                    path: &path,
                    depth: site.depth + 1,
                },
            );
            format!("({raw}, {path}) => {inner}")
        })
        .collect();
    format!(
        "firstOf({}, {}, [{}])",
        site.raw,
        site.path,
        arms.join(", ")
    )
}

pub(super) fn decoder_const(type_name: &str, shape: &WireShape) -> String {
    let expr = decoder_expr(
        shape,
        Site {
            raw: "raw",
            path: "path",
            depth: 0,
        },
    );
    format!("export const decode{type_name}: Decoder<{type_name}> = (raw, path) =>\n  {expr};")
}
