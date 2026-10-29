pub(super) use antidrift_kernel::local_binding::{
    Binding, const_binding_initializer, is_binding_mutated, resolve_lexical_binding as symbol_for,
};
pub(super) use antidrift_kernel::tsrs_kernel::unwrap_expression;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImportedOwner {
    pub module: String,
    pub export: String,
    pub member: Option<String>,
}

#[derive(Clone, Copy)]
pub(super) enum AliasStability {
    Const,
    Unwritten,
}

pub(super) fn property_name(key: P<Node>) -> Option<&'static str> {
    match key.kind() {
        Kind::Identifier => Some(key.as_identifier().text()),
        Kind::StringLiteral => Some(key.as_string_literal().text()),
        _ => None,
    }
}

pub(super) fn const_initializer(
    sf: P<SourceFile>,
    symbol: Binding,
    stability: AliasStability,
) -> Option<P<Node>> {
    if matches!(stability, AliasStability::Unwritten) && is_binding_mutated(sf.as_node(), symbol) {
        return None;
    }
    const_binding_initializer(symbol)
}

pub(super) fn member_expression(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    matches!(
        inner.kind(),
        Kind::PropertyAccessExpression | Kind::ElementAccessExpression
    )
    .then_some(inner)
}

pub(super) fn member_object(member: P<Node>) -> P<Node> {
    match member.kind() {
        Kind::PropertyAccessExpression => member.as_property_access_expression().expression(),
        Kind::ElementAccessExpression => member.as_element_access_expression().expression(),
        _ => member,
    }
}

pub(super) fn static_property_name(member: P<Node>) -> Option<&'static str> {
    if member.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let name = member.as_property_access_expression().name();
    ast::is_identifier(name).then(|| name.as_identifier().text())
}

pub(super) fn static_string(
    sf: P<SourceFile>,
    expression: P<Node>,
    visited: &mut Vec<Binding>,
) -> Option<String> {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::StringLiteral => Some(inner.as_string_literal().text().to_owned()),
        Kind::NoSubstitutionTemplateLiteral => Some(inner.text().to_owned()),
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            if bin.operator_token().kind() != Kind::PlusToken {
                return None;
            }
            let left = static_string(sf, bin.left(), &mut visited.clone())?;
            let right = static_string(sf, bin.right(), &mut visited.clone())?;
            Some(left + &right)
        }
        Kind::Identifier => {
            let symbol = symbol_for(inner)?;
            if visited.contains(&symbol) {
                return None;
            }
            visited.push(symbol);
            static_string(
                sf,
                const_initializer(sf, symbol, AliasStability::Const)?,
                visited,
            )
        }
        _ => None,
    }
}

pub(super) fn imported_owner(
    sf: P<SourceFile>,
    expression: P<Node>,
    owners: &[ImportedOwner],
) -> bool {
    owners.iter().any(|owner| {
        matches_import(
            sf,
            expression,
            owner,
            owner.member.as_deref(),
            &mut Vec::new(),
        )
    })
}

fn matches_import(
    sf: P<SourceFile>,
    expression: P<Node>,
    owner: &ImportedOwner,
    member: Option<&str>,
    visited: &mut Vec<Binding>,
) -> bool {
    let expression = unwrap_expression(expression);
    if expression.kind() == Kind::PropertyAccessExpression {
        let access = expression.as_property_access_expression();
        let prop = access.name();
        if !ast::is_identifier(prop) {
            return false;
        }
        return member == Some(prop.as_identifier().text())
            && matches_import(sf, access.expression(), owner, None, visited);
    }
    if expression.kind() != Kind::Identifier {
        return false;
    }
    let Some(symbol) = symbol_for(expression) else {
        return false;
    };
    if visited.contains(&symbol) {
        return false;
    }
    visited.push(symbol);
    if let Some(initializer) = const_initializer(sf, symbol, AliasStability::Unwritten) {
        return matches_import(sf, initializer, owner, member, visited);
    }
    if member.is_some() {
        return false;
    }
    let imported = match symbol.decl.kind() {
        Kind::ImportSpecifier => {
            let spec = symbol.decl.as_import_specifier();
            let node = spec.property_name().unwrap_or_else(|| spec.name());
            match node.kind() {
                Kind::Identifier => node.as_identifier().text(),
                Kind::StringLiteral => node.as_string_literal().text(),
                _ => return false,
            }
        }
        Kind::ImportClause => "default",
        Kind::NamespaceImport => "*",
        _ => return false,
    };
    let mut cursor = symbol.decl.parent();
    while let Some(ancestor) = cursor {
        if ancestor.kind() == Kind::ImportDeclaration {
            let spec = ancestor.as_import_declaration().module_specifier();
            return ast::is_string_literal(spec)
                && owner.module == spec.as_string_literal().text()
                && owner.export == imported;
        }
        cursor = ancestor.parent();
    }
    false
}
