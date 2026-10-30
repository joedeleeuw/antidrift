use super::no_repo_state_mirror_assertion::{is_literal_like, unwrap_expr};
use super::repo_state_path::source_file_read_call_name;
use antidrift_kernel::local_binding::{Binding, resolve_lexical_binding};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

pub(super) fn taint_root_name(
    expr: P<Node>,
    tainted_imports: &FxHashMap<String, String>,
    visited_syms: &mut FxHashSet<Binding>,
) -> Option<String> {
    let target = unwrap_expr(expr);
    match target.kind() {
        Kind::Identifier => {
            let name = target.as_identifier().text();
            if tainted_imports.contains_key(name) {
                return Some(name.to_owned());
            }
            let binding = resolve_lexical_binding(target)?;
            if !visited_syms.insert(binding) {
                return None;
            }
            binding_is_tainted(binding, tainted_imports, visited_syms).then(|| name.to_owned())
        }
        Kind::CallExpression => source_file_read_call_name(target).or_else(|| {
            taint_root_name(
                target.as_call_expression().expression(),
                tainted_imports,
                visited_syms,
            )
        }),
        Kind::PropertyAccessExpression => taint_root_name(
            target.as_property_access_expression().expression(),
            tainted_imports,
            visited_syms,
        ),
        Kind::ElementAccessExpression => taint_root_name(
            target.as_element_access_expression().expression(),
            tainted_imports,
            visited_syms,
        ),
        Kind::ConditionalExpression => {
            let cond = target.as_conditional_expression();
            taint_root_name(cond.when_true(), tainted_imports, visited_syms)
                .or_else(|| taint_root_name(cond.when_false(), tainted_imports, visited_syms))
        }
        Kind::BinaryExpression => {
            let bin = target.as_binary_expression();
            if matches!(
                bin.operator_token().kind(),
                Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
            ) {
                taint_root_name(bin.left(), tainted_imports, visited_syms)
                    .or_else(|| taint_root_name(bin.right(), tainted_imports, visited_syms))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn binding_is_tainted(
    binding: Binding,
    tainted_imports: &FxHashMap<String, String>,
    visited_syms: &mut FxHashSet<Binding>,
) -> bool {
    match binding.decl.kind() {
        Kind::VariableDeclaration => {
            if let Some(init) = binding.decl.as_variable_declaration().initializer()
                && taint_root_name(init, tainted_imports, visited_syms).is_some()
            {
                return true;
            }
            if let Some(list) = binding.decl.parent()
                && list.kind() == Kind::VariableDeclarationList
                && let Some(for_of) = list.parent()
                && for_of.kind() == Kind::ForOfStatement
            {
                return taint_root_name(
                    for_of.as_for_in_or_of_statement().expression(),
                    tainted_imports,
                    visited_syms,
                )
                .is_some();
            }
            false
        }
        Kind::Parameter => {
            let Some(func) = binding.decl.parent() else {
                return false;
            };
            let Some(call) = func.parent() else {
                return false;
            };
            if call.kind() == Kind::CallExpression {
                let callee = call.as_call_expression().expression();
                if callee.kind() == Kind::PropertyAccessExpression {
                    return taint_root_name(
                        callee.as_property_access_expression().expression(),
                        tainted_imports,
                        visited_syms,
                    )
                    .is_some();
                }
            }
            false
        }
        _ => false,
    }
}

pub(super) fn literal_keyed_source_call(
    expr: P<Node>,
    tainted_imports: &FxHashMap<String, String>,
) -> Option<String> {
    let inner = unwrap_expr(expr);
    match inner.kind() {
        Kind::CallExpression => {
            let call = inner.as_call_expression();
            let callee = unwrap_expr(call.expression());
            let args = call.arguments().nodes();
            if ast::is_identifier(callee)
                && tainted_imports.contains_key(callee.as_identifier().text())
                && !args.is_empty()
                && args
                    .iter()
                    .all(|&arg| arg.kind() != Kind::SpreadElement && is_literal_like(arg))
            {
                return Some(callee.as_identifier().text().to_owned());
            }
            literal_keyed_source_call(call.expression(), tainted_imports)
        }
        Kind::PropertyAccessExpression => literal_keyed_source_call(
            inner.as_property_access_expression().expression(),
            tainted_imports,
        ),
        Kind::ElementAccessExpression => literal_keyed_source_call(
            inner.as_element_access_expression().expression(),
            tainted_imports,
        ),
        _ => None,
    }
}
