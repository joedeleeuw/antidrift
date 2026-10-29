use std::path::Path;

use antidrift_kernel::jsx::is_hook_name;
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::{
    is_undefined_or_void_expression, normalize_path, property_name_text, unwrap_expression,
};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-hookless-use-function";
const PLATFORM_INFIXES: [&str; 4] = ["web", "native", "ios", "android"];
const CODE_EXTENSIONS: [&str; 6] = ["ts", "tsx", "js", "jsx", "mts", "mjs"];

pub struct NoHooklessUseFunction {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoHooklessUseFunction = NoHooklessUseFunction {
    scope: RuleScope::DEFAULT,
};

impl NoHooklessUseFunction {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::PropertyAssignment),
];

impl Rule for NoHooklessUseFunction {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            active: in_scope(&self.scope, ctx, None),
        })
    }
}

struct Visitor {
    active: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.active { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let Some((report_node, function_node, name)) = extract_hook_candidate(node) else {
            return;
        };
        if !is_hook_name(name) || is_ambient_or_overload(node, function_node) {
            return;
        }
        let Some(body) = function_node.body() else {
            return;
        };
        if subtree_calls_hook(body) {
            return;
        }
        if is_stub_body(body) && has_sibling_calling_hook(ctx, name) {
            return;
        }
        let suffix = name
            .strip_prefix("use")
            .filter(|rest| !rest.is_empty())
            .unwrap_or("Value");
        ctx.report_node(
            report_node,
            RuleMessage::new(
                "noHooklessUseFunction",
                format!(
                    "Function '{name}' uses the 'use*' prefix but calls no React hooks. React Compiler treats all 'use*' functions as reactive hooks, splitting memo cache scopes and hoisting caller dependencies. If this is a procedural helper, rename it to a non-hook prefix (e.g. 'get{suffix}', 'read{suffix}', 'sync{suffix}'). If this is an intentional platform stub, implement it in a platform-suffixed file (.native.ts, .web.ts) whose sibling calls a hook."
                ),
            ),
        );
    }
}

fn extract_hook_candidate(node: P<Node>) -> Option<(P<Node>, P<Node>, &'static str)> {
    match node.kind() {
        Kind::FunctionDeclaration | Kind::MethodDeclaration => {
            let name_node = node.name()?;
            let name = property_name_text(name_node)?;
            Some((name_node, node, name))
        }
        Kind::VariableDeclaration => {
            let var_decl = node.as_variable_declaration();
            let name_node = var_decl.name();
            if !ast::is_identifier(name_node) {
                return None;
            }
            let init = unwrap_expression(var_decl.initializer()?);
            if !matches!(init.kind(), Kind::ArrowFunction | Kind::FunctionExpression) {
                return None;
            }
            Some((name_node, init, name_node.as_identifier().text()))
        }
        Kind::PropertyAssignment => {
            let prop = node.as_property_assignment();
            let name_node = prop.name();
            let name = property_name_text(name_node)?;
            let init = unwrap_expression(prop.initializer());
            if !matches!(init.kind(), Kind::ArrowFunction | Kind::FunctionExpression) {
                return None;
            }
            Some((name_node, init, name))
        }
        _ => None,
    }
}

fn is_ambient_or_overload(decl_node: P<Node>, function_node: P<Node>) -> bool {
    if function_node.body().is_none() {
        return true;
    }
    if ast::has_syntactic_modifier(decl_node, ModifierFlags::Ambient)
        || ast::has_syntactic_modifier(function_node, ModifierFlags::Ambient)
    {
        return true;
    }
    let mut current = decl_node.parent();
    while let Some(ancestor) = current {
        if ast::has_syntactic_modifier(ancestor, ModifierFlags::Ambient)
            || matches!(
                ancestor.kind(),
                Kind::InterfaceDeclaration | Kind::TypeLiteral
            )
        {
            return true;
        }
        current = ancestor.parent();
    }
    false
}

fn is_hook_callee(callee: P<Node>) -> bool {
    let inner = unwrap_expression(callee);
    match inner.kind() {
        Kind::Identifier => is_hook_name(inner.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            property_name_text(inner.as_property_access_expression().name())
                .is_some_and(is_hook_name)
        }
        _ => false,
    }
}

fn subtree_calls_hook(node: P<Node>) -> bool {
    if node.kind() == Kind::CallExpression && is_hook_callee(node.as_call_expression().expression())
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if found {
            return true;
        }
        if subtree_calls_hook(child) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn is_stub_statement(statement: P<Node>) -> bool {
    match statement.kind() {
        Kind::ThrowStatement => true,
        Kind::ReturnStatement => {
            is_undefined_or_void_expression(statement.as_return_statement().expression())
        }
        _ => false,
    }
}

fn is_stub_body(body: P<Node>) -> bool {
    if body.kind() == Kind::Block {
        let statements = body.as_block().statements().nodes();
        return statements.is_empty() || statements.iter().copied().all(is_stub_statement);
    }
    is_undefined_or_void_expression(Some(body))
}

fn candidate_sibling_paths(file_path: &str) -> Vec<String> {
    let normalized = normalize_path(file_path);
    let path = Path::new(&normalized);
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
        return Vec::new();
    };
    let Some((without_ext, _ext)) = file_name.rsplit_once('.') else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    if let Some((stem, infix)) = without_ext.rsplit_once('.')
        && PLATFORM_INFIXES.contains(&infix)
    {
        for ext in CODE_EXTENSIONS {
            candidates.push(normalize_path(
                &dir.join(format!("{stem}.{ext}")).to_string_lossy(),
            ));
        }
        for platform in PLATFORM_INFIXES {
            if platform == infix {
                continue;
            }
            for ext in CODE_EXTENSIONS {
                candidates.push(normalize_path(
                    &dir.join(format!("{stem}.{platform}.{ext}"))
                        .to_string_lossy(),
                ));
            }
        }
    } else {
        for platform in PLATFORM_INFIXES {
            for ext in CODE_EXTENSIONS {
                candidates.push(normalize_path(
                    &dir.join(format!("{without_ext}.{platform}.{ext}"))
                        .to_string_lossy(),
                ));
            }
        }
    }
    candidates
}

fn source_file_defines_hook_with_call(sf: P<SourceFile>, target_name: &str) -> bool {
    let mut found = false;
    sf.as_node().for_each_child(&mut |child| {
        if found {
            return true;
        }
        if source_node_defines_hook_with_call(child, target_name) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn source_node_defines_hook_with_call(node: P<Node>, target_name: &str) -> bool {
    if let Some((_, fn_node, name)) = extract_hook_candidate(node)
        && name == target_name
        && fn_node.body().is_some_and(subtree_calls_hook)
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if found {
            return true;
        }
        if source_node_defines_hook_with_call(child, target_name) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn has_sibling_calling_hook(ctx: &Ctx, target_name: &str) -> bool {
    let candidates = candidate_sibling_paths(ctx.file.file_name());
    if candidates.is_empty() {
        return false;
    }
    ctx.program.get_source_files().iter().any(|&sf| {
        let sf_path = normalize_path(sf.file_name());
        candidates.iter().any(|cand| cand == &sf_path)
            && source_file_defines_hook_with_call(sf, target_name)
    })
}
