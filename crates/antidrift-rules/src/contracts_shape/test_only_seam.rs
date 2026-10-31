use super::no_hypothetical_seam::{identifier_name, is_effectful_default};
use antidrift_kernel::callgraph::{CallSiteRecord, ProgramSymbolIndex};
use antidrift_kernel::program_fact::ProgramFact;
use antidrift_kernel::{provenance, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, Symbol};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::rule::{Ctx, RuleMessage};

enum SeamSlot {
    Positional,
    Property(&'static str),
}

struct DefaultedDependency {
    slot: SeamSlot,
    local: P<Node>,
    default_expr: P<Node>,
    is_parameter_property: bool,
}

fn defaulted_dependencies(param: P<Node>) -> Vec<DefaultedDependency> {
    let decl = param.as_parameter_declaration();
    let name = decl.name();
    if ast::is_identifier(name) {
        return decl
            .initializer()
            .map(|default_expr| DefaultedDependency {
                slot: SeamSlot::Positional,
                local: name,
                default_expr,
                is_parameter_property: ast::has_syntactic_modifier(
                    param,
                    ModifierFlags::ParameterPropertyModifier,
                ),
            })
            .into_iter()
            .collect();
    }
    if name.kind() != Kind::ObjectBindingPattern {
        return Vec::new();
    }
    let mut dependencies = Vec::new();
    for &element in name.as_binding_pattern().elements().nodes() {
        let binding = element.as_binding_element();
        let (Some(local), Some(default_expr)) = (binding.name(), binding.initializer()) else {
            continue;
        };
        let key_node = binding.property_name().unwrap_or(local);
        if let (true, Some(key)) = (
            ast::is_identifier(local),
            tsrs_kernel::property_name_text(key_node),
        ) {
            dependencies.push(DefaultedDependency {
                slot: SeamSlot::Property(key),
                local,
                default_expr,
                is_parameter_property: false,
            });
        }
    }
    dependencies
}

fn is_this_field_assignment(ident: P<Node>) -> bool {
    let Some(parent) = ident.parent() else {
        return false;
    };
    if parent.kind() != Kind::BinaryExpression {
        return false;
    }
    let binary = parent.as_binary_expression();
    binary.right() == ident
        && binary.operator_token().kind() == Kind::EqualsToken
        && binary.left().kind() == Kind::PropertyAccessExpression
        && binary
            .left()
            .as_property_access_expression()
            .expression()
            .kind()
            == Kind::ThisKeyword
}

fn is_invoked(ident: P<Node>) -> bool {
    ident.parent().is_some_and(|parent| {
        parent.kind() == Kind::CallExpression && parent.as_call_expression().expression() == ident
    })
}

fn uses_dependency(
    checker: &mut Checker,
    node: P<Node>,
    local: P<Node>,
    local_symbol: P<Symbol>,
) -> bool {
    if ast::is_identifier(node)
        && node != local
        && node.as_identifier().text() == local.as_identifier().text()
        && checker.get_symbol_at_location_exported(node) == Some(local_symbol)
        && (is_invoked(node) || is_this_field_assignment(node))
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        found = uses_dependency(checker, child, local, local_symbol);
        found
    });
    found
}

fn call_overrides_slot(site: &CallSiteRecord, param_index: usize, slot: &SeamSlot) -> bool {
    let spread_before = site
        .arg_nodes
        .iter()
        .take(param_index + 1)
        .any(|arg| arg.kind() == Kind::SpreadElement);
    if spread_before {
        return true;
    }
    let Some(&arg) = site.arg_nodes.get(param_index) else {
        return false;
    };
    if tsrs_kernel::is_undefined_or_void_expression(Some(arg)) {
        return false;
    }
    let SeamSlot::Property(key) = slot else {
        return true;
    };
    let inner = tsrs_kernel::unwrap_expression(arg);
    if inner.kind() != Kind::ObjectLiteralExpression {
        return true;
    }
    inner
        .as_object_literal_expression()
        .properties()
        .nodes()
        .iter()
        .any(|&prop| {
            prop.kind() == Kind::SpreadAssignment
                || prop
                    .name()
                    .and_then(tsrs_kernel::property_name_text)
                    .is_some_and(|name| name == *key)
        })
}

struct SeamTarget {
    symbol: P<Symbol>,
    name: &'static str,
    call_kind: Kind,
}

fn seam_target(ctx: &mut Ctx, fn_node: P<Node>) -> Option<SeamTarget> {
    let (name_node, call_kind) = if fn_node.kind() == Kind::Constructor {
        (fn_node.parent()?.name(), Kind::NewExpression)
    } else {
        (fn_node.name(), Kind::CallExpression)
    };
    let (name_node, name) = identifier_name(name_node)?;
    let symbol = provenance::symbol_at_node(ctx.checker, name_node)?;
    Some(SeamTarget {
        symbol,
        name,
        call_kind,
    })
}

fn is_callee_reference(node: P<Node>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    let callee = if parent.kind() == Kind::PropertyAccessExpression
        && parent.as_property_access_expression().name() == node
    {
        parent
    } else {
        node
    };
    callee.parent().is_some_and(|call| match call.kind() {
        Kind::CallExpression => call.as_call_expression().expression() == callee,
        Kind::NewExpression => call.as_new_expression().expression() == callee,
        _ => false,
    })
}

fn has_opaque_reference(ctx: &mut Ctx, index: &ProgramSymbolIndex, target: &SeamTarget) -> bool {
    index
        .references_to_symbol(ctx.checker, target.symbol, target.name)
        .iter()
        .any(|reference| {
            let node = reference.node;
            let in_specifier = node.parent().is_some_and(|parent| {
                ast::is_import_specifier(parent) || ast::is_export_specifier(parent)
            });
            !is_callee_reference(node) && !in_specifier && !ast::is_part_of_type_node(node)
        })
}

pub(super) fn check_test_only_seams(ctx: &mut Ctx, fn_node: P<Node>) {
    let Some(body) = fn_node.body() else {
        return;
    };
    let candidates: Vec<(usize, DefaultedDependency)> = fn_node
        .parameters()
        .iter()
        .enumerate()
        .flat_map(|(idx, &param)| {
            defaulted_dependencies(param)
                .into_iter()
                .map(move |dependency| (idx, dependency))
        })
        .collect();
    if candidates.is_empty() {
        return;
    }
    let Some(target) = seam_target(ctx, fn_node) else {
        return;
    };
    let index = ProgramSymbolIndex::for_program(ctx.program);
    if has_opaque_reference(ctx, &index, &target) {
        return;
    }
    let sites: Vec<&CallSiteRecord> = index
        .call_sites_for_symbol(ctx.checker, target.symbol, target.name)
        .into_iter()
        .filter(|site| site.call_node.kind() == target.call_kind)
        .collect();
    if sites.is_empty() {
        return;
    }
    for (param_index, dependency) in candidates {
        report_test_only_seam(ctx, body, &sites, param_index, &dependency);
    }
}

fn report_test_only_seam(
    ctx: &mut Ctx,
    body: P<Node>,
    sites: &[&CallSiteRecord],
    param_index: usize,
    dependency: &DefaultedDependency,
) {
    if !is_effectful_default(ctx, dependency.default_expr) {
        return;
    }
    let Some(local_symbol) = ctx
        .checker
        .get_symbol_at_location_exported(dependency.local)
    else {
        return;
    };
    if !dependency.is_parameter_property
        && !uses_dependency(ctx.checker, body, dependency.local, local_symbol)
    {
        return;
    }
    let overriding = sites
        .iter()
        .filter(|site| call_overrides_slot(site, param_index, &dependency.slot));
    let (prod, test) = overriding.fold((0usize, 0usize), |(prod, test), site| {
        if site.is_test_file {
            (prod, test + 1)
        } else {
            (prod + 1, test)
        }
    });
    if prod > 0 {
        return;
    }
    let local = dependency.local.as_identifier().text();
    let default_text = tsrs_kernel::node_text(ctx.file, dependency.default_expr);
    let detail = if test > 0 {
        format!("only {test} test call site(s) inject it")
    } else {
        "no call site injects it".to_owned()
    };
    ctx.report_node(
        dependency.local,
        RuleMessage::new(
            "testOnlySeam",
            format!(
                "'{local}' defaults to '{default_text}' and {detail}; no production caller supplies another implementation. Call '{default_text}' directly and delete the parameter."
            ),
        ),
    );
}
