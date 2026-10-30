use antidrift_kernel::shape::{has_string_or_number_index_signature, is_true_literal_type};
use antidrift_kernel::tsrs_kernel::decodable_text;
use serde::Serialize;
use tsrs_ast::SymbolFlags;
use tsrs_checker::{Checker, LiteralValue, ObjectFlags, SignatureKind, Type, TypeFlags};
use tsrs_core::P;

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum WireShape {
    String,
    Number,
    Boolean,
    Null,
    Date,
    Literal { value: WireLiteral },
    Array { items: Box<WireShape> },
    Object { fields: Vec<WireField> },
    Union { variants: Vec<WireShape> },
}

#[derive(Serialize, Clone, PartialEq)]
#[serde(untagged)]
pub(crate) enum WireLiteral {
    Text(String),
    Number(f64),
    Flag(bool),
}

#[derive(Serialize, Clone)]
pub(crate) struct WireField {
    pub(crate) name: String,
    pub(crate) optional: bool,
    pub(crate) shape: WireShape,
}

pub(crate) struct ShapeProblem {
    pub(crate) path: String,
    pub(crate) reason: String,
}

impl ShapeProblem {
    fn at(path: &str, reason: String) -> Self {
        Self {
            path: path.to_owned(),
            reason,
        }
    }
}

const MAX_DEPTH: u8 = 16;

pub(crate) fn shape_of(
    checker: &mut Checker,
    typ: P<Type>,
    path: &str,
    depth: u8,
) -> Result<WireShape, ShapeProblem> {
    if depth > MAX_DEPTH {
        return Err(ShapeProblem::at(
            path,
            "nests deeper than 16 levels; recursive types cannot cross the wire".to_owned(),
        ));
    }
    let flags = typ.flags();
    if flags.intersects(TypeFlags::Any | TypeFlags::Unknown) {
        return Err(ShapeProblem::at(
            path,
            "is any/unknown; declare the wire shape".to_owned(),
        ));
    }
    if flags.intersects(TypeFlags::Boolean) {
        return Ok(WireShape::Boolean);
    }
    if flags.intersects(TypeFlags::Union) {
        return union_shape(checker, typ, path, depth);
    }
    if flags.intersects(TypeFlags::BooleanLiteral) {
        return Ok(WireShape::Literal {
            value: WireLiteral::Flag(is_true_literal_type(typ)),
        });
    }
    if flags.intersects(TypeFlags::StringLiteral | TypeFlags::NumberLiteral) {
        return literal_shape(checker, typ, path);
    }
    if flags.intersects(TypeFlags::String) {
        return Ok(WireShape::String);
    }
    if flags.intersects(TypeFlags::Number) {
        return Ok(WireShape::Number);
    }
    if flags.intersects(TypeFlags::Null) {
        return Ok(WireShape::Null);
    }
    if flags.intersects(TypeFlags::Undefined | TypeFlags::Void) {
        return Err(ShapeProblem::at(
            path,
            "is undefined, which JSON cannot carry: it drops undefined properties, turns undefined array items and arguments into null, and cannot encode an undefined result; make the property optional or use null".to_owned(),
        ));
    }
    if flags.intersects(TypeFlags::Object) {
        return object_shape(checker, typ, path, depth);
    }
    Err(ShapeProblem::at(
        path,
        format!(
            "is `{}`, which cannot cross the wire",
            checker.type_to_string_exported(typ)
        ),
    ))
}

fn literal_shape(
    checker: &mut Checker,
    typ: P<Type>,
    path: &str,
) -> Result<WireShape, ShapeProblem> {
    match typ.as_literal_type().value() {
        Some(LiteralValue::String(text)) => decodable_text(text)
            .map(|text| WireShape::Literal {
                value: WireLiteral::Text(text.to_owned()),
            })
            .ok_or_else(|| {
                ShapeProblem::at(
                    path,
                    "is a string literal holding a lone surrogate, which cannot cross the wire"
                        .to_owned(),
                )
            }),
        Some(LiteralValue::Number(_)) => {
            let printed = checker.type_to_string_exported(typ);
            printed
                .parse::<f64>()
                .map(|number| WireShape::Literal {
                    value: WireLiteral::Number(number),
                })
                .map_err(|err| {
                    ShapeProblem::at(
                        path,
                        format!("numeric literal `{printed}` is not a JSON number: {err}"),
                    )
                })
        }
        _ => Err(ShapeProblem::at(
            path,
            "is a bigint or computed enum literal, which cannot cross the wire".to_owned(),
        )),
    }
}

fn union_shape(
    checker: &mut Checker,
    typ: P<Type>,
    path: &str,
    depth: u8,
) -> Result<WireShape, ShapeProblem> {
    members_shape(
        checker,
        typ.as_union_type().types().iter().copied(),
        path,
        depth,
    )
}

fn optional_shape(
    checker: &mut Checker,
    typ: P<Type>,
    path: &str,
    depth: u8,
) -> Result<WireShape, ShapeProblem> {
    if !typ.flags().intersects(TypeFlags::Union) {
        return shape_of(checker, typ, path, depth);
    }
    members_shape(
        checker,
        typ.as_union_type()
            .types()
            .iter()
            .copied()
            .filter(|member| !member.flags().intersects(TypeFlags::Undefined)),
        path,
        depth,
    )
}

fn members_shape(
    checker: &mut Checker,
    members: impl Iterator<Item = P<Type>>,
    path: &str,
    depth: u8,
) -> Result<WireShape, ShapeProblem> {
    let mut variants = Vec::new();
    let mut saw_true = false;
    let mut saw_false = false;
    for member in members {
        if member.flags().intersects(TypeFlags::BooleanLiteral) {
            if is_true_literal_type(member) {
                saw_true = true;
            } else {
                saw_false = true;
            }
            continue;
        }
        variants.push(shape_of(checker, member, path, depth + 1)?);
    }
    match (saw_true, saw_false) {
        (true, true) => variants.push(WireShape::Boolean),
        (true, false) => variants.push(WireShape::Literal {
            value: WireLiteral::Flag(true),
        }),
        (false, true) => variants.push(WireShape::Literal {
            value: WireLiteral::Flag(false),
        }),
        (false, false) => {}
    }
    match variants.len() {
        0 => Err(ShapeProblem::at(
            path,
            "has no value JSON can carry".to_owned(),
        )),
        1 => Ok(variants.swap_remove(0)),
        _ => overlap_reason(&variants).map_or_else(
            || Ok(WireShape::Union { variants }),
            |reason| Err(ShapeProblem::at(path, reason)),
        ),
    }
}

fn overlap_reason(variants: &[WireShape]) -> Option<String> {
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
        (WireShape::Object { fields: left_fields }, WireShape::Object { fields: right_fields }) => {
            (!has_discriminant(&[left_fields.as_slice(), right_fields.as_slice()])).then(|| {
                "has object variants that no required literal field tells apart; add a discriminant such as `kind: \"a\"`"
                    .to_owned()
            })
        }
        (WireShape::Array { items: left_items }, WireShape::Array { items: right_items }) => {
            shared_value_reason(left_items, right_items)
                .map(|inner| format!("has array variants whose items overlap: the item union {inner}"))
        }
        (WireShape::Date, text) | (text, WireShape::Date) if carries_text(text) => {
            Some("mixes string and Date, which share one wire form".to_owned())
        }
        _ => None,
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

fn array_item_type(
    checker: &mut Checker,
    typ: P<Type>,
    path: &str,
) -> Result<P<Type>, ShapeProblem> {
    if !typ.object_flags().intersects(ObjectFlags::Reference) {
        return Err(ShapeProblem::at(
            path,
            "is an array whose element type cannot be resolved".to_owned(),
        ));
    }
    checker
        .get_type_arguments(typ)
        .first()
        .copied()
        .ok_or_else(|| ShapeProblem::at(path, "is an array without an element type".to_owned()))
}

fn object_shape(
    checker: &mut Checker,
    typ: P<Type>,
    path: &str,
    depth: u8,
) -> Result<WireShape, ShapeProblem> {
    let symbol = typ.symbol();
    let symbol_name = symbol.map_or("", |sym| sym.name());
    if checker.is_array_type(typ) || symbol_name == "ReadonlyArray" {
        let items = array_item_type(checker, typ, path)?;
        let item_path = format!("{path}[]");
        return Ok(WireShape::Array {
            items: Box::new(shape_of(checker, items, &item_path, depth + 1)?),
        });
    }
    if typ.is_tuple_type() {
        return Err(ShapeProblem::at(
            path,
            "is a tuple; tuples are not wire shapes yet, use an object or an array".to_owned(),
        ));
    }
    if symbol_name == "Date" {
        return Ok(WireShape::Date);
    }
    if symbol.is_some_and(|sym| sym.flags().contains(SymbolFlags::Class)) {
        return Err(ShapeProblem::at(
            path,
            format!(
                "is an instance of class `{symbol_name}`; class instances cannot cross the wire"
            ),
        ));
    }
    if !checker
        .get_signatures_of_type(typ, SignatureKind::Call)
        .is_empty()
    {
        return Err(ShapeProblem::at(
            path,
            "is a function; functions cannot cross the wire".to_owned(),
        ));
    }
    if has_string_or_number_index_signature(checker, typ) {
        return Err(ShapeProblem::at(
            path,
            "has an index signature; declare the keys or send an array of entries".to_owned(),
        ));
    }
    let mut fields = Vec::new();
    for &property in checker.get_properties_of_type(typ) {
        let Some(name) = decodable_text(property.name()) else {
            return Err(ShapeProblem::at(
                path,
                "has a property name holding a lone surrogate, which cannot cross the wire"
                    .to_owned(),
            ));
        };
        let optional = property.flags().contains(SymbolFlags::Optional);
        let field_path = format!("{path}.{name}");
        let declared = checker.get_type_of_symbol(property);
        let shape = if optional {
            optional_shape(checker, declared, &field_path, depth + 1)?
        } else {
            shape_of(checker, declared, &field_path, depth + 1)?
        };
        fields.push(WireField {
            name: name.to_owned(),
            optional,
            shape,
        });
    }
    Ok(WireShape::Object { fields })
}
