use antidrift_kernel::tsrs_kernel;
use antidrift_kernel::tsrs_kernel::cooked_text;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_checker::Checker;
use tsrs_core::P;

fn identifier_has_external_provenance(ident: P<Node>, checker: &mut Checker, depth: u8) -> bool {
    let Some(sym) = checker.get_symbol_at_location_exported(ident) else {
        return false;
    };
    sym.declarations().iter().any(|&d| {
        is_external_declaration(d)
            || decl_origin_node(d)
                .is_some_and(|n| has_external_sql_tag_provenance(n, checker, depth + 1))
    })
}

pub(super) fn has_external_sql_tag_provenance(
    node: P<Node>,
    checker: &mut Checker,
    depth: u8,
) -> bool {
    if depth > 4 {
        return false;
    }
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    match unwrapped.kind() {
        Kind::Identifier => identifier_has_external_provenance(unwrapped, checker, depth),
        Kind::TypeReference => {
            let tn = unwrapped.as_type_reference_node().type_name();
            let id = if ast::is_qualified_name(tn) {
                tn.as_qualified_name().left()
            } else {
                tn
            };
            has_external_sql_tag_provenance(id, checker, depth + 1)
        }
        Kind::YieldExpression => unwrapped
            .as_yield_expression()
            .expression()
            .is_some_and(|e| has_external_sql_tag_provenance(e, checker, depth + 1)),
        Kind::CallExpression => has_external_sql_tag_provenance(
            unwrapped.as_call_expression().expression(),
            checker,
            depth + 1,
        ),
        Kind::ThisKeyword => enclosing_class_extends_external(unwrapped, checker, depth),
        Kind::PropertyAccessExpression => {
            let prop = unwrapped.as_property_access_expression();
            let name = prop.name();
            ast::is_identifier(name)
                && !matches!(name.as_identifier().text(), "raw" | "unsafe")
                && has_external_sql_tag_provenance(prop.expression(), checker, depth + 1)
        }
        _ => false,
    }
}

fn decl_origin_node(decl: P<Node>) -> Option<P<Node>> {
    match decl.kind() {
        Kind::VariableDeclaration => decl.as_variable_declaration().initializer(),
        Kind::Parameter => decl.as_parameter_declaration().type_(),
        _ => None,
    }
}

fn enclosing_class(mut current: Option<P<Node>>) -> Option<P<Node>> {
    while let Some(curr) = current {
        if curr.kind() == Kind::ClassDeclaration {
            return Some(curr);
        }
        current = curr.parent();
    }
    None
}

fn enclosing_class_extends_external(node: P<Node>, checker: &mut Checker, depth: u8) -> bool {
    let Some(cls) = enclosing_class(node.parent()) else {
        return false;
    };
    let Some(clauses) = cls.as_class_declaration().heritage_clauses() else {
        return false;
    };
    clauses
        .nodes()
        .iter()
        .flat_map(|&c| c.as_heritage_clause().types().nodes())
        .any(|&ty| {
            ast::is_expression_with_type_arguments(ty)
                && has_external_sql_tag_provenance(
                    ty.as_expression_with_type_arguments().expression(),
                    checker,
                    depth + 1,
                )
        })
}

fn is_external_declaration(decl: P<Node>) -> bool {
    (matches!(
        decl.kind(),
        Kind::ImportSpecifier | Kind::NamespaceImport | Kind::ImportClause
    ) && enclosing_import_module_name(decl)
        .is_some_and(|m| !m.starts_with('.') && !m.starts_with('/')))
        || ast::get_source_file_of_node(decl).is_some_and(|sf| {
            tsrs_kernel::normalize_path(sf.file_name()).contains("/node_modules/")
        })
}

pub(super) fn enclosing_import_module_name(node: P<Node>) -> Option<String> {
    let mut current = node.parent();
    while let Some(curr) = current {
        if curr.kind() == Kind::ImportDeclaration {
            let spec = curr.as_import_declaration().module_specifier();
            return ast::is_string_literal(spec)
                .then_some(spec)
                .and_then(cooked_text)
                .map(str::to_owned);
        }
        current = curr.parent();
    }
    None
}
