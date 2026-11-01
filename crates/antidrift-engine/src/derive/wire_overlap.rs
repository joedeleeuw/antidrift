use super::wire_shape::{WireField, WireLiteral, WireShape};

pub(super) fn overlap_reason(variants: &[WireShape]) -> Option<String> {
    variants.iter().enumerate().find_map(|(index, left)| {
        variants
            .iter()
            .skip(index + 1)
            .find_map(|right| shared_value_reason(left, right))
    })
}

fn shared_value_reason(left: &WireShape, right: &WireShape) -> Option<String> {
    match (left, right) {
        (WireShape::Union { variants }, other) | (other, WireShape::Union { variants }) => variants
            .iter()
            .find_map(|variant| shared_value_reason(variant, other)),
        (
            WireShape::Object {
                fields: left_fields,
            },
            WireShape::Object {
                fields: right_fields,
            },
        ) => (!has_discriminant(&[left_fields.as_slice(), right_fields.as_slice()])).then(|| {
            "has object variants that no required literal field tells apart; add a discriminant such as `kind: \"a\"`"
                .to_owned()
        }),
        (WireShape::Array { items: left_items }, WireShape::Array { items: right_items }) => {
            shared_value_reason(left_items, right_items).map(|inner| {
                format!("has array variants whose items overlap: the item union {inner}")
            })
        }
        (WireShape::Date, text) | (text, WireShape::Date) if carries_date_text(text) => {
            Some("mixes string and Date, which share one wire form".to_owned())
        }
        (WireShape::String, other) | (other, WireShape::String) if carries_text(other) => {
            Some("has overlapping string variants".to_owned())
        }
        (WireShape::Number, other) | (other, WireShape::Number) if carries_number(other) => {
            Some("has overlapping number variants".to_owned())
        }
        (WireShape::Boolean, other) | (other, WireShape::Boolean) if carries_boolean(other) => {
            Some("has overlapping boolean variants".to_owned())
        }
        (WireShape::Null, WireShape::Null) => Some("has duplicate null variants".to_owned()),
        (WireShape::Date, WireShape::Date) => Some("has duplicate Date variants".to_owned()),
        (WireShape::Literal { value: left_val }, WireShape::Literal { value: right_val })
            if left_val == right_val =>
        {
            Some("has duplicate literal variants".to_owned())
        }
        _ => None,
    }
}

fn carries_date_text(shape: &WireShape) -> bool {
    match shape {
        WireShape::String => true,
        WireShape::Literal {
            value: WireLiteral::Text(text),
        } => is_iso_8601_timestamp(text),
        _ => false,
    }
}

const fn carries_text(shape: &WireShape) -> bool {
    matches!(
        shape,
        WireShape::String
            | WireShape::Literal {
                value: WireLiteral::Text(_)
            }
    )
}

const fn carries_number(shape: &WireShape) -> bool {
    matches!(
        shape,
        WireShape::Number
            | WireShape::Literal {
                value: WireLiteral::Number(_)
            }
    )
}

const fn carries_boolean(shape: &WireShape) -> bool {
    matches!(
        shape,
        WireShape::Boolean
            | WireShape::Literal {
                value: WireLiteral::Flag(_)
            }
    )
}

fn is_iso_8601_timestamp(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 20 {
        return false;
    }
    let fixed_digits = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
    if !fixed_digits.iter().all(|&idx| bytes[idx].is_ascii_digit())
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return false;
    }
    let mut rest = &bytes[19..];
    if let Some(after_dot) = rest.strip_prefix(b".") {
        let frac_len = after_dot
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if frac_len == 0 {
            return false;
        }
        rest = &after_dot[frac_len..];
    }
    match rest {
        b"Z" => true,
        [sign, h1, h2, b':', m1, m2] if (*sign == b'+' || *sign == b'-') => {
            [h1, h2, m1, m2].into_iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

fn has_discriminant(objects: &[&[WireField]]) -> bool {
    objects.first().is_some_and(|first| {
        first.iter().any(|candidate| {
            let literals: Vec<&WireLiteral> = objects
                .iter()
                .filter_map(|fields| required_literal(fields, &candidate.name))
                .collect();
            literals.len() == objects.len()
                && literals.iter().enumerate().all(|(index, literal)| {
                    literals
                        .iter()
                        .skip(index + 1)
                        .all(|other| other != literal)
                })
        })
    })
}

fn required_literal<'a>(fields: &'a [WireField], name: &str) -> Option<&'a WireLiteral> {
    fields
        .iter()
        .find(|field| field.name == name && !field.optional)
        .and_then(|field| match &field.shape {
            WireShape::Literal { value } => Some(value),
            _ => None,
        })
}
