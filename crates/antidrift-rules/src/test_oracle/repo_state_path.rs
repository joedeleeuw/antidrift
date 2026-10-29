use super::no_repo_state_mirror_assertion::unwrap_expr;
use antidrift_kernel::local_binding::{Binding, resolve_lexical_binding};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

const FILE_READ_FUNCTIONS: &[&str] = &["readFileSync", "readFile"];
const PATH_JOIN_HELPERS: &[&str] = &["join", "resolve", "fromFileUrl"];

pub(super) fn source_file_read_call_name(call_node: P<Node>) -> Option<String> {
    let call = call_node.as_call_expression();
    let &first_arg = call.arguments().nodes().first()?;
    if first_arg.kind() == Kind::SpreadElement {
        return None;
    }
    let callee = unwrap_expr(call.expression());
    let reader_name = match callee.kind() {
        Kind::Identifier if FILE_READ_FUNCTIONS.contains(&callee.as_identifier().text()) => {
            callee.as_identifier().text().to_owned()
        }
        Kind::PropertyAccessExpression => {
            let access = callee.as_property_access_expression();
            let prop_node = access.name();
            if !ast::is_identifier(prop_node) {
                return None;
            }
            let prop = prop_node.as_identifier().text();
            if FILE_READ_FUNCTIONS.contains(&prop) {
                prop.to_owned()
            } else if prop == "file" {
                let obj = unwrap_expr(access.expression());
                if ast::is_identifier(obj) && obj.as_identifier().text() == "Bun" {
                    "Bun.file".to_owned()
                } else {
                    return None;
                }
            } else {
                return None;
            }
        }
        _ => return None,
    };
    let mut visited = FxHashSet::default();
    let segments = collect_static_path_segments(first_arg, &mut visited);
    if segments.is_empty() {
        return None;
    }
    let combined = segments.join("/");
    if is_fixture_or_build_path(&combined) {
        return None;
    }
    let last = segments.last()?;
    has_source_file_extension(last).then_some(reader_name)
}

fn collect_static_path_segments(expr: P<Node>, visited: &mut FxHashSet<Binding>) -> Vec<String> {
    let inner = unwrap_expr(expr);
    match inner.kind() {
        Kind::StringLiteral => vec![inner.as_string_literal().text().to_owned()],
        Kind::NoSubstitutionTemplateLiteral => {
            let text = inner.text();
            if text.is_empty() {
                Vec::new()
            } else {
                vec![text.to_owned()]
            }
        }
        Kind::TemplateExpression => {
            let tpl = inner.as_template_expression();
            let mut out = Vec::new();
            let head = tpl.head().text();
            if !head.is_empty() {
                out.push(head.to_owned());
            }
            for &span_node in tpl.template_spans().nodes() {
                let span = span_node.as_template_span();
                out.extend(collect_static_path_segments(span.expression(), visited));
                let tail = span.literal().text();
                if !tail.is_empty() {
                    out.push(tail.to_owned());
                }
            }
            out
        }
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            if bin.operator_token().kind() != Kind::PlusToken {
                return Vec::new();
            }
            let mut out = collect_static_path_segments(bin.left(), visited);
            out.extend(collect_static_path_segments(bin.right(), visited));
            out
        }
        Kind::Identifier => {
            let Some(binding) = resolve_lexical_binding(inner) else {
                return Vec::new();
            };
            if !visited.insert(binding) || binding.decl.kind() != Kind::VariableDeclaration {
                return Vec::new();
            }
            let Some(init) = binding.decl.as_variable_declaration().initializer() else {
                return Vec::new();
            };
            collect_static_path_segments(init, visited)
        }
        Kind::CallExpression => collect_call_path_segments(inner, visited),
        Kind::NewExpression => {
            let new_expr = inner.as_new_expression();
            let callee = unwrap_expr(new_expr.expression());
            if ast::is_identifier(callee)
                && callee.as_identifier().text() == "URL"
                && let Some(&first) = new_expr.arguments().and_then(|args| args.nodes().first())
                && first.kind() != Kind::SpreadElement
            {
                return collect_static_path_segments(first, visited);
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn collect_call_path_segments(call_node: P<Node>, visited: &mut FxHashSet<Binding>) -> Vec<String> {
    let call = call_node.as_call_expression();
    let callee = unwrap_expr(call.expression());
    let callee_name = match callee.kind() {
        Kind::Identifier => Some(callee.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            let name = callee.as_property_access_expression().name();
            ast::is_identifier(name).then(|| name.as_identifier().text())
        }
        _ => None,
    };
    if !callee_name.is_some_and(|name| PATH_JOIN_HELPERS.contains(&name)) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for &arg in call.arguments().nodes() {
        if arg.kind() != Kind::SpreadElement {
            out.extend(collect_static_path_segments(arg, visited));
        }
    }
    out
}

fn is_fixture_or_build_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    if lower.ends_with(".snap") {
        return true;
    }
    lower.split('/').any(|seg| {
        matches!(
            seg,
            "fixture"
                | "fixtures"
                | "__fixtures__"
                | "__snapshots__"
                | "testdata"
                | "snapshot"
                | "snapshots"
                | "dist"
                | "build"
                | "coverage"
                | ".next"
        )
    })
}

fn has_source_file_extension(segment: &str) -> bool {
    for ext in [
        ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".css",
        ".scss", ".vue", ".svelte",
    ] {
        if segment.ends_with(ext) {
            return true;
        }
    }
    false
}
