use super::syn_kernel::extract_pat_ident;
use antidrift_kernel::runtime_lifecycle::spans_multiple_artifact_tiers;
use rustc_hash::FxHashMap;
use syn::visit::{self, Visit};
use syn::{
    BinOp, Expr, ExprBinary, ExprClosure, ExprField, ExprLit, ExprMatch, ExprMethodCall,
    ExprStruct, Lit, Member, Pat,
};

pub(super) fn first_closure_param_name(closure: &ExprClosure) -> Option<String> {
    extract_pat_ident(closure.inputs.first()?).map(|(name, _)| name)
}

pub(super) fn receiver_is_outer_collection(expr: &Expr, outer_params: &[String]) -> bool {
    matches!(expr, Expr::MethodCall(mc) if (mc.method == "iter" || mc.method == "values") && root_ident_of(&mc.receiver).is_some_and(|r| !outer_params.contains(&r)))
}

fn root_ident_of(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Path(ep) => ep.path.get_ident().map(ToString::to_string),
        Expr::Field(ef) => root_ident_of(&ef.base),
        Expr::Reference(er) => root_ident_of(&er.expr),
        _ => None,
    }
}

fn is_param_field_access(expr: &Expr, param: &str) -> bool {
    match expr {
        Expr::Field(ExprField { base, .. }) => {
            matches!(&**base, Expr::Path(ep) if ep.path.is_ident(param))
        }
        Expr::Reference(er) => is_param_field_access(&er.expr, param),
        Expr::MethodCall(mc) if mc.method == "as_str" && mc.args.is_empty() => {
            is_param_field_access(&mc.receiver, param)
        }
        _ => false,
    }
}

pub(super) fn closure_has_field_key_equality(
    expr: &Expr,
    outer_param: &str,
    inner_param: &str,
) -> bool {
    match expr {
        Expr::Binary(ExprBinary {
            left,
            op: BinOp::Eq(_),
            right,
            ..
        }) => {
            (is_param_field_access(left, outer_param) && is_param_field_access(right, inner_param))
                || (is_param_field_access(left, inner_param)
                    && is_param_field_access(right, outer_param))
                || closure_has_field_key_equality(left, outer_param, inner_param)
                || closure_has_field_key_equality(right, outer_param, inner_param)
        }
        Expr::Binary(bin) => {
            closure_has_field_key_equality(&bin.left, outer_param, inner_param)
                || closure_has_field_key_equality(&bin.right, outer_param, inner_param)
        }
        Expr::Block(b) => b.block.stmts.iter().any(|stmt| match stmt {
            syn::Stmt::Expr(e, _) => closure_has_field_key_equality(e, outer_param, inner_param),
            _ => false,
        }),
        _ => false,
    }
}

pub(super) fn detect_result_sum_erasure_match(node: &ExprMatch) -> Option<String> {
    if node.arms.len() != 2 {
        return None;
    }
    let (mut ok_struct, mut err_struct) = (None, None);
    for arm in &node.arms {
        let Pat::TupleStruct(ts) = &arm.pat else {
            return None;
        };
        let variant = ts.path.segments.last()?.ident.to_string();
        let struct_expr = extract_arm_struct_expr(&arm.body)?;
        if variant == "Ok" {
            ok_struct = Some(struct_expr);
        } else if variant == "Err" {
            err_struct = Some(struct_expr);
        }
    }
    let (ok_s, err_s) = (ok_struct?, err_struct?);
    let ok_name = ok_s.path.segments.last()?.ident.to_string();
    if err_s.path.segments.last()?.ident != ok_name {
        return None;
    }
    (struct_has_bool_field(ok_s, true)
        && struct_has_bool_field(err_s, false)
        && struct_has_error_option_field(ok_s, false)
        && struct_has_error_option_field(err_s, true))
    .then_some(ok_name)
}

fn extract_arm_struct_expr(expr: &Expr) -> Option<&ExprStruct> {
    match expr {
        Expr::Struct(es) => Some(es),
        Expr::Block(b) => match b.block.stmts.last()? {
            syn::Stmt::Expr(Expr::Struct(es), None) => Some(es),
            _ => None,
        },
        _ => None,
    }
}

fn struct_has_bool_field(es: &ExprStruct, expected: bool) -> bool {
    es.fields.iter().any(
        |f| matches!(&f.expr, Expr::Lit(ExprLit { lit: Lit::Bool(b), .. }) if b.value == expected),
    )
}

fn struct_has_error_option_field(es: &ExprStruct, is_some: bool) -> bool {
    es.fields.iter().any(|f| {
        matches!(&f.member, Member::Named(id) if id == "error")
            && if is_some {
                matches!(&f.expr, Expr::Call(c) if matches!(&*c.func, Expr::Path(ep) if ep.path.is_ident("Some")))
            } else {
                matches!(&f.expr, Expr::Path(ep) if ep.path.is_ident("None"))
            }
    })
}

pub(super) fn detect_fieldwise_clone_rebuild(node: &ExprStruct) -> Option<String> {
    if node.rest.is_some() || node.fields.len() < 3 {
        return None;
    }
    let (mut source_ident, mut clone_count) = (None, 0usize);
    for field in &node.fields {
        let Member::Named(field_ident) = &field.member else {
            return None;
        };
        let (base_ident, accessed_field, is_cloned) = extract_field_copy_or_clone(&field.expr)?;
        if *field_ident != accessed_field
            || source_ident.as_ref().is_some_and(|ex| ex != &base_ident)
        {
            return None;
        }
        source_ident = Some(base_ident);
        clone_count += usize::from(is_cloned);
    }
    (clone_count >= 2).then_some(source_ident?)
}

fn extract_field_copy_or_clone(expr: &Expr) -> Option<(String, String, bool)> {
    match expr {
        Expr::MethodCall(mc) if mc.method == "clone" && mc.args.is_empty() => {
            extract_field_copy_or_clone(&mc.receiver).map(|(b, f, _)| (b, f, true))
        }
        Expr::Field(ExprField {
            base,
            member: Member::Named(f),
            ..
        }) => match &**base {
            Expr::Path(ep) => Some((ep.path.get_ident()?.to_string(), f.to_string(), false)),
            _ => None,
        },
        _ => None,
    }
}

pub(super) fn is_multi_tier_exists_find(
    node: &ExprMethodCall,
    local_lists: &FxHashMap<String, Vec<String>>,
) -> bool {
    let Some(Expr::Closure(closure)) = node.args.first() else {
        return false;
    };
    if !expr_calls_path_exists(&closure.body) {
        return false;
    }
    let mut candidates = Vec::new();
    collect_receiver_candidates(&node.receiver, local_lists, &mut candidates);
    spans_multiple_artifact_tiers(candidates.iter().map(String::as_str))
}

fn expr_calls_path_exists(expr: &Expr) -> bool {
    match expr {
        Expr::MethodCall(call) => {
            call.method == "exists"
                || call.method == "is_file"
                || expr_calls_path_exists(&call.receiver)
                || call.args.iter().any(expr_calls_path_exists)
        }
        Expr::Block(b) => b.block.stmts.iter().any(|s| match s {
            syn::Stmt::Expr(e, _) => expr_calls_path_exists(e),
            _ => false,
        }),
        _ => false,
    }
}

fn collect_receiver_candidates(
    expr: &Expr,
    local_lists: &FxHashMap<String, Vec<String>>,
    out: &mut Vec<String>,
) {
    match expr {
        Expr::MethodCall(call) => collect_receiver_candidates(&call.receiver, local_lists, out),
        Expr::Path(ep) => {
            if let Some(ident) = ep.path.get_ident()
                && let Some(list) = local_lists.get(&ident.to_string())
            {
                out.extend(list.iter().cloned());
            }
        }
        other => collect_string_literals(other, out),
    }
}

pub(super) fn collect_string_literals(expr: &Expr, out: &mut Vec<String>) {
    match expr {
        Expr::Lit(ExprLit {
            lit: Lit::Str(s), ..
        }) => out.push(s.value()),
        Expr::Array(arr) => {
            for elem in &arr.elems {
                collect_string_literals(elem, out);
            }
        }
        Expr::Reference(r) => collect_string_literals(&r.expr, out),
        Expr::MethodCall(mc) => {
            collect_string_literals(&mc.receiver, out);
            for arg in &mc.args {
                collect_string_literals(arg, out);
            }
        }
        Expr::Call(call) => {
            for arg in &call.args {
                collect_string_literals(arg, out);
            }
        }
        _ => {}
    }
}

pub(super) fn block_mentions_modified(block: &syn::Block) -> bool {
    struct ModifiedFinder(bool);
    impl<'ast> Visit<'ast> for ModifiedFinder {
        fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
            if node.method == "modified" || node.method == "metadata" {
                self.0 = true;
            }
            visit::visit_expr_method_call(self, node);
        }
    }
    let mut finder = ModifiedFinder(false);
    finder.visit_block(block);
    finder.0
}
