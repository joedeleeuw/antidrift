use antidrift_kernel::directives::split_identifier_words;
use antidrift_kernel::rule_scope::RuleScope;
use antidrift_kernel::tsrs_kernel;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_checker::Type;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrslint::utils::{is_intersection_type, is_union_type};

const RULE_NAME: &str = "antidrift/no-vague-names";

const VAGUE_NOUNS: &[&str] = &[
    "data",
    "info",
    "value",
    "values",
    "val",
    "vals",
    "obj",
    "objects",
    "objs",
    "thing",
    "things",
    "stuff",
    "temp",
    "tmp",
    "foo",
    "bar",
    "baz",
    "res",
    "ret",
    "retval",
    "misc",
    "result",
    "results",
    "item",
    "items",
    "var",
    "vars",
    "variable",
    "content",
    "contents",
    "param",
    "params",
    "parameters",
    "arr",
    "spam",
    "ham",
    "toto",
    "tutu",
    "tata",
];

const EXEMPT_TEMP_TAILS: &[&str] = &[
    "dir",
    "dirs",
    "directory",
    "directorys",
    "file",
    "files",
    "path",
    "paths",
    "root",
    "roots",
    "base",
    "bases",
    "home",
    "homes",
];

const FILLER_SUFFIXES: &[&str] = &[
    "Value", "Data", "Info", "Obj", "Object", "Thing", "Stuff", "_value", "_data", "_info", "_obj",
    "_object", "_thing", "_stuff",
];

const FILLER_PREFIXES: &[&str] = &["my", "the", "some", "temp", "tmp"];

fn is_exempt_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == "formdata" || lower == "imagedata" {
        return true;
    }
    ["temp_", "temp", "tmp_", "tmp"].iter().any(|prefix| {
        lower
            .strip_prefix(prefix)
            .is_some_and(|tail| EXEMPT_TEMP_TAILS.contains(&tail))
    })
}

fn abbreviation_expansion(name: &str) -> Option<&'static str> {
    let base = name.trim_end_matches(|ch: char| ch.is_ascii_digit());
    if base.is_empty() || !base.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return None;
    }
    match base {
        "cb" => Some("callback"),
        "ctx" => Some("context"),
        "el" => Some("element"),
        "err" => Some("error"),
        "evt" => Some("event"),
        "fn" => Some("function"),
        "msg" => Some("message"),
        "opts" => Some("options"),
        "props" => Some("properties"),
        "req" => Some("request"),
        "str" => Some("string"),
        _ => None,
    }
}

fn is_single_letter_vague(name: &str) -> bool {
    if name.len() != 1 {
        return false;
    }
    let byte = name.as_bytes()[0];
    byte.is_ascii_alphabetic()
        && !matches!(
            byte.to_ascii_lowercase(),
            b'i' | b'j' | b'k' | b'n' | b'x' | b'y' | b'z'
        )
}

fn has_filler_suffix(name: &str) -> bool {
    name.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && FILLER_SUFFIXES
            .iter()
            .any(|suffix| name.len() > suffix.len() && name.ends_with(suffix))
}

fn has_filler_prefix(name: &str) -> bool {
    FILLER_PREFIXES.iter().any(|prefix| {
        name.strip_prefix(prefix)
            .and_then(|rest| rest.as_bytes().first())
            .is_some_and(|&first| first.is_ascii_uppercase() || first == b'_')
    })
}

fn vague_reason(name: &str) -> Option<String> {
    if is_exempt_name(name) {
        return None;
    }
    let stem = name.trim_end_matches(|ch: char| ch.is_ascii_digit());
    if !stem.is_empty() && VAGUE_NOUNS.contains(&stem.to_ascii_lowercase().as_str()) {
        return Some("a vague noun".to_string());
    }
    if let Some(full) = abbreviation_expansion(name) {
        return Some(format!("an abbreviation of '{full}'"));
    }
    if is_single_letter_vague(name) {
        return Some("a single letter".to_string());
    }
    if has_filler_suffix(name) {
        return Some("a filler suffix".to_string());
    }
    has_filler_prefix(name).then(|| "a filler prefix".to_string())
}

fn duplicate_context_word(name: &str) -> Option<String> {
    let words = split_identifier_words(name);
    words
        .windows(2)
        .find(|pair| !pair[0].is_empty() && pair[0] == pair[1])
        .map(|pair| pair[1].clone())
}

fn is_context_type_name(name: &str) -> bool {
    name.ends_with("Ctx") || name.ends_with("Context")
}

fn type_node_has_context_name(type_node: P<Node>) -> bool {
    match type_node.kind() {
        Kind::ParenthesizedType => {
            type_node_has_context_name(type_node.as_parenthesized_type_node().type_())
        }
        Kind::TypeReference => {
            let type_name = type_node.as_type_reference_node().type_name();
            let ident = if ast::is_qualified_name(type_name) {
                type_name.as_qualified_name().right()
            } else {
                type_name
            };
            ast::is_identifier(ident) && is_context_type_name(ident.as_identifier().text())
        }
        Kind::UnionType | Kind::IntersectionType => {
            tsrs_kernel::union_or_intersection_type_nodes(type_node)
                .iter()
                .any(|&member| type_node_has_context_name(member))
        }
        _ => false,
    }
}

fn type_has_context_symbol(typ: P<Type>) -> bool {
    if (is_union_type(typ) || is_intersection_type(typ))
        && typ
            .types()
            .iter()
            .any(|&member| type_has_context_symbol(member))
    {
        return true;
    }
    if let Some(alias) = typ.alias()
        && let Some(sym) = alias.symbol()
        && is_context_type_name(sym.name())
    {
        return true;
    }
    typ.symbol()
        .is_some_and(|sym| is_context_type_name(sym.name()))
}

fn declaration_type_node(node: P<Node>) -> Option<P<Node>> {
    match node.kind() {
        Kind::Parameter => node.as_parameter_declaration().type_(),
        Kind::VariableDeclaration => node.as_variable_declaration().type_(),
        Kind::PropertyDeclaration => node.as_property_declaration().type_(),
        Kind::PropertySignature => node.as_property_signature_declaration().type_(),
        _ => tsrs_kernel::function_return_type_node(node),
    }
}

fn is_framework_context(ctx: &mut Ctx, ident: P<Node>) -> bool {
    if ident.as_identifier().text() != "ctx" {
        return false;
    }
    if let Some(parent) = ident.parent()
        && parent.name() == Some(ident)
        && let Some(type_node) = declaration_type_node(parent)
    {
        return type_node_has_context_name(type_node);
    }
    let typ = ctx.checker.get_type_at_location(ident);
    type_has_context_symbol(typ)
}

fn is_jsx_expression(node: P<Node>) -> bool {
    let expr = tsrs_kernel::unwrap_parentheses(node);
    match expr.kind() {
        Kind::JsxElement | Kind::JsxSelfClosingElement | Kind::JsxFragment => true,
        Kind::ConditionalExpression => {
            let cond = expr.as_conditional_expression();
            is_jsx_expression(cond.when_true()) || is_jsx_expression(cond.when_false())
        }
        Kind::BinaryExpression => {
            let bin = expr.as_binary_expression();
            matches!(
                bin.operator_token().kind(),
                Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
            ) && is_jsx_expression(bin.right())
        }
        _ => false,
    }
}

fn is_component_function(fn_node: P<Node>) -> bool {
    tsrs_kernel::function_name(fn_node)
        .and_then(|name| name.as_bytes().first())
        .is_some_and(u8::is_ascii_uppercase)
        || tsrs_kernel::collect_return_expressions(fn_node.body())
            .into_iter()
            .any(is_jsx_expression)
}

fn check_ident(ctx: &mut Ctx, node: Option<P<Node>>) {
    let Some(ident) = node else {
        return;
    };
    if !ast::is_identifier(ident) || is_framework_context(ctx, ident) {
        return;
    }
    let name = ident.as_identifier().text();
    if let Some(reason) = vague_reason(name) {
        ctx.report_node(
            ident,
            RuleMessage::new(
                "vague",
                format!("'{name}' is {reason}. Name the binding for what it holds in this domain."),
            ),
        );
    }
}

fn check_binding_node(ctx: &mut Ctx, node: Option<P<Node>>) {
    let Some(curr) = node else {
        return;
    };
    match curr.kind() {
        Kind::Identifier => check_ident(ctx, Some(curr)),
        Kind::Parameter | Kind::BindingElement => check_binding_node(ctx, curr.name()),
        Kind::ObjectBindingPattern | Kind::ArrayBindingPattern => {
            for &elem in curr.as_binding_pattern().elements().nodes() {
                check_binding_node(ctx, Some(elem));
            }
        }
        _ => {}
    }
}

fn check_duplicate_context(ctx: &mut Ctx, name_node: Option<P<Node>>, report_node: P<Node>) {
    let Some(target) = name_node else {
        return;
    };
    let name = if ast::is_identifier(target) {
        target.as_identifier().text()
    } else if ast::is_string_literal(target) {
        target.as_string_literal().text()
    } else {
        return;
    };
    if let Some(word) = duplicate_context_word(name) {
        ctx.report_node(
            report_node,
            RuleMessage::new(
                "duplicate",
                format!(
                    "Function '{name}' repeats '{word}'. Remove duplicate context from the identifier."
                ),
            ),
        );
    }
}

fn is_exempt_props_parameter(fn_node: P<Node>, index: usize, param: P<Node>) -> bool {
    if index != 0 {
        return false;
    }
    let param_decl = param.as_parameter_declaration();
    if param_decl.dot_dot_dot_token().is_some() || param_decl.initializer().is_some() {
        return false;
    }
    param.name().is_some_and(|name_node| {
        ast::is_identifier(name_node)
            && name_node.as_identifier().text() == "props"
            && is_component_function(fn_node)
    })
}

fn check_function(ctx: &mut Ctx, node: P<Node>) {
    if node.kind() != Kind::ArrowFunction && node.kind() != Kind::MethodDeclaration {
        check_ident(ctx, node.name());
    }
    if node.kind() == Kind::FunctionDeclaration {
        check_duplicate_context(ctx, node.name(), node);
    }
    for (idx, &param) in node.parameters().iter().enumerate() {
        if !is_exempt_props_parameter(node, idx, param) {
            check_binding_node(ctx, Some(param));
        }
    }
}

pub struct NoVagueNames {
    scope: RuleScope,
}

impl NoVagueNames {
    pub const DEFAULT: Self = Self {
        scope: RuleScope::DEFAULT,
    };
}

pub static DEFAULT_INSTANCE: NoVagueNames = NoVagueNames::DEFAULT;

pub fn create(options: Option<&serde_json::Value>) -> Result<Box<dyn Rule>, String> {
    Ok(Box::new(NoVagueNames {
        scope: RuleScope::from_options(RULE_NAME, options)?,
    }))
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::Constructor),
    Listener::Enter(Kind::GetAccessor),
    Listener::Enter(Kind::SetAccessor),
    Listener::Enter(Kind::CatchClause),
    Listener::Enter(Kind::ClassDeclaration),
];

impl Rule for NoVagueNames {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let enabled = self.scope.matches(ctx.file.file_name(), cwd);
        Box::new(Visitor { enabled })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>) {
        match listener {
            Listener::Enter(Kind::VariableDeclaration) => {
                let var_decl = node.as_variable_declaration();
                let name_node = var_decl.name();
                check_binding_node(ctx, Some(name_node));
                if let Some(init) = var_decl.initializer()
                    && matches!(init.kind(), Kind::ArrowFunction | Kind::FunctionExpression)
                {
                    check_duplicate_context(ctx, Some(name_node), node);
                }
            }
            Listener::Enter(
                Kind::FunctionDeclaration
                | Kind::FunctionExpression
                | Kind::ArrowFunction
                | Kind::Constructor
                | Kind::GetAccessor
                | Kind::SetAccessor,
            ) => {
                check_function(ctx, node);
            }
            Listener::Enter(Kind::MethodDeclaration) => {
                check_duplicate_context(ctx, node.name(), node);
                check_function(ctx, node);
            }
            Listener::Enter(Kind::CatchClause) => {
                if let Some(var_decl) = node.as_catch_clause().variable_declaration() {
                    check_binding_node(ctx, var_decl.name());
                }
            }
            Listener::Enter(Kind::ClassDeclaration) => {
                check_ident(ctx, node.name());
            }
            _ => {}
        }
    }
}
