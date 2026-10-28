use tsrs_ast::{self as ast, Kind, Node, Symbol, TypeQueryNode};
use tsrs_checker::Checker;
use tsrs_core::P;

use crate::{provenance, tsrs_kernel};

const ZOD_PARSE_METHODS: &[&str] = &["parse", "parseAsync"];
const ZOD_VALIDATION_METHODS: &[&str] = &["parse", "parseAsync", "safeParse", "safeParseAsync"];
const TYPEBOX_VALIDATION_METHODS: &[&str] = &["Decode", "Parse", "Check"];
const EFFECT_DECODE_METHODS: &[&str] = &[
    "decode",
    "decodeSync",
    "decodePromise",
    "decodeOption",
    "decodeEither",
    "decodeUnknown",
    "decodeUnknownSync",
    "decodeUnknownPromise",
    "decodeUnknownOption",
    "decodeUnknownEither",
    "decodeUnknownEffect",
    "decodeUnknownExit",
];
const SCHEMA_OUTPUT_TYPE_NAMES: &[&str] = &[
    "infer",
    "output",
    "TypeOf",
    "InferOutput",
    "Type",
    "Static",
    "StaticDecode",
];

#[derive(Clone, Debug)]
pub struct SchemaValidationCall {
    pub call_node: P<Node>,
    pub arg_node: P<Node>,
    pub schema_node: P<Node>,
    pub method: String,
    pub returns_schema_output: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct DeclaredSchemaParam {
    pub declaration: P<Node>,
    pub schema_sym: P<Symbol>,
}

pub fn symbol_package_path(checker: &mut Checker, sym: Option<P<Symbol>>) -> String {
    for decl in provenance::symbol_declarations(checker, sym) {
        let Some(sf) = ast::get_source_file_of_node(decl) else {
            continue;
        };
        let file = tsrs_kernel::normalize_path(sf.file_name());
        if let Some(idx) = file.rfind("/node_modules/") {
            let start = idx + "/node_modules/".len();
            if let Some(rest) = file.get(start..) {
                return rest.to_string();
            }
        }
    }
    String::new()
}

#[must_use]
pub fn package_name_of_path(pkg_path: &str) -> String {
    if pkg_path.is_empty() {
        return String::new();
    }
    let mut parts = pkg_path.split('/');
    let Some(first) = parts.next() else {
        return String::new();
    };
    if first.starts_with('@')
        && let Some(second) = parts.next()
    {
        return format!("{first}/{second}");
    }
    first.to_string()
}

fn is_package_symbol(checker: &mut Checker, sym: Option<P<Symbol>>, prefixes: &[&str]) -> bool {
    let rest = symbol_package_path(checker, sym);
    if rest.is_empty() {
        return false;
    }
    prefixes.iter().any(|&prefix| {
        rest == prefix
            || rest
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with('/'))
    })
}

pub fn is_zod_method(checker: &mut Checker, name_node: P<Node>) -> bool {
    let sym = provenance::symbol_at_node(checker, name_node);
    is_package_symbol(checker, sym, &["zod", "@zod"])
}

pub fn is_valibot_method(checker: &mut Checker, name_node: P<Node>) -> bool {
    let sym = provenance::symbol_at_node(checker, name_node);
    is_package_symbol(checker, sym, &["valibot", "@valibot"])
}

pub fn is_typebox_method(checker: &mut Checker, name_node: P<Node>) -> bool {
    let sym = provenance::symbol_at_node(checker, name_node);
    is_package_symbol(checker, sym, &["@sinclair/typebox", "typebox"])
}

pub fn is_effect_schema_method(checker: &mut Checker, name_node: P<Node>) -> bool {
    let sym = provenance::symbol_at_node(checker, name_node);
    is_package_symbol(checker, sym, &["effect", "@effect/schema"])
}

fn zod_parse_call_parts(
    call_node: P<Node>,
    checker: &mut Checker,
    methods: &[&str],
) -> Option<SchemaValidationCall> {
    if !ast::is_call_expression(call_node) {
        return None;
    }
    let call = call_node.as_call_expression();
    let args = call.arguments().nodes();
    if args.is_empty() || !ast::is_property_access_expression(call.expression()) {
        return None;
    }
    let prop = call.expression().as_property_access_expression();
    let name_node = prop.name();
    if !ast::is_identifier(name_node) {
        return None;
    }
    let method_name = name_node.as_identifier().text();
    if !methods.contains(&method_name) || !is_zod_method(checker, name_node) {
        return None;
    }
    Some(SchemaValidationCall {
        call_node,
        arg_node: args[0],
        schema_node: prop.expression(),
        method: method_name.to_string(),
        returns_schema_output: ZOD_PARSE_METHODS.contains(&method_name),
    })
}

fn effect_decode_call_parts(
    call_node: P<Node>,
    checker: &mut Checker,
) -> Option<SchemaValidationCall> {
    if !ast::is_call_expression(call_node) {
        return None;
    }
    let call = call_node.as_call_expression();
    let args = call.arguments().nodes();
    if args.is_empty() {
        return None;
    }
    let (schema_call_node, value_arg) = if ast::is_call_expression(call.expression()) {
        (call.expression(), args[0])
    } else if args.len() >= 2 {
        (call_node, args[1])
    } else {
        return None;
    };
    if !ast::is_call_expression(schema_call_node) {
        return None;
    }
    let schema_call = schema_call_node.as_call_expression();
    let schema_args = schema_call.arguments().nodes();
    if schema_args.is_empty() || !ast::is_property_access_expression(schema_call.expression()) {
        return None;
    }
    let decoder = schema_call.expression().as_property_access_expression();
    let name_node = decoder.name();
    if !ast::is_identifier(name_node) {
        return None;
    }
    let method_name = name_node.as_identifier().text();
    if !EFFECT_DECODE_METHODS.contains(&method_name) || !is_effect_schema_method(checker, name_node)
    {
        return None;
    }
    Some(SchemaValidationCall {
        call_node,
        arg_node: value_arg,
        schema_node: schema_args[0],
        method: method_name.to_string(),
        returns_schema_output: true,
    })
}

fn extract_callee_method_ident(callee: P<Node>) -> Option<(P<Node>, &'static str)> {
    if ast::is_identifier(callee) {
        return Some((callee, callee.as_identifier().text()));
    }
    if ast::is_property_access_expression(callee) {
        let prop_name = callee.as_property_access_expression().name();
        if ast::is_identifier(prop_name) {
            return Some((prop_name, prop_name.as_identifier().text()));
        }
    }
    None
}

fn schema_first_validation_call_parts(
    call_node: P<Node>,
    checker: &mut Checker,
) -> Option<SchemaValidationCall> {
    if !ast::is_call_expression(call_node) {
        return None;
    }
    let call = call_node.as_call_expression();
    let args = call.arguments().nodes();
    if args.len() < 2 {
        return None;
    }
    let (name_node, method_name) = extract_callee_method_ident(call.expression())?;
    if method_name.is_empty() {
        return None;
    }
    let is_zod_like = ZOD_VALIDATION_METHODS.contains(&method_name);
    let is_typebox = TYPEBOX_VALIDATION_METHODS.contains(&method_name);
    if !is_zod_like && !is_typebox {
        return None;
    }
    if (is_zod_like && !is_valibot_method(checker, name_node))
        || (is_typebox && !is_typebox_method(checker, name_node))
    {
        return None;
    }
    Some(SchemaValidationCall {
        call_node,
        arg_node: args[1],
        schema_node: args[0],
        method: method_name.to_string(),
        returns_schema_output: method_name != "Check",
    })
}

pub fn schema_validation_call_parts(
    call_node: P<Node>,
    checker: &mut Checker,
) -> Option<SchemaValidationCall> {
    if let Some(mut zod) = zod_parse_call_parts(call_node, checker, ZOD_VALIDATION_METHODS) {
        zod.returns_schema_output = true;
        return Some(zod);
    }
    if let Some(eff) = effect_decode_call_parts(call_node, checker) {
        return Some(eff);
    }
    schema_first_validation_call_parts(call_node, checker)
}

fn infer_schema_node_from_call(call_node: P<Node>) -> Option<P<Node>> {
    if !ast::is_call_expression(call_node) {
        return None;
    }
    let callee = call_node.as_call_expression().expression();
    if ast::is_property_access_expression(callee) {
        return Some(callee.as_property_access_expression().expression());
    }
    if ast::is_call_expression(callee) {
        let inner_args = callee.as_call_expression().arguments().nodes();
        return inner_args.first().copied();
    }
    None
}

pub fn parsed_schema_symbol(
    checker: &mut Checker,
    call_node: Option<P<Node>>,
    schema_node: Option<P<Node>>,
) -> Option<P<Symbol>> {
    let expr = schema_node.or_else(|| call_node.and_then(infer_schema_node_from_call))?;
    let target = if ast::is_property_access_expression(expr) {
        expr.as_property_access_expression().name()
    } else {
        expr
    };
    let sym = provenance::symbol_at_node(checker, target)?;
    if let Some(val_decl) = sym.value_declaration()
        && ast::is_property_assignment(val_decl)
    {
        let init = val_decl.as_property_assignment().initializer();
        if ast::is_identifier(init) {
            return provenance::symbol_at_node(checker, init);
        }
    }
    Some(sym)
}

fn schema_symbol_from_type_query(checker: &mut Checker, tq: &TypeQueryNode) -> Option<P<Symbol>> {
    let expr_name = tq.expr_name();
    if !ast::is_qualified_name(expr_name) {
        return None;
    }
    let qn = expr_name.as_qualified_name();
    let right = qn.right();
    if !ast::is_identifier(right) || right.as_identifier().text() != "Type" {
        return None;
    }
    let mut owner = qn.left();
    if ast::is_qualified_name(owner) {
        owner = owner.as_qualified_name().right();
    }
    provenance::symbol_at_node(checker, owner)
}

fn rightmost_identifier_name(node: P<Node>) -> &'static str {
    if ast::is_identifier(node) {
        return node.as_identifier().text();
    }
    if ast::is_qualified_name(node) {
        let right = node.as_qualified_name().right();
        if ast::is_identifier(right) {
            return right.as_identifier().text();
        }
    }
    ""
}

fn schema_symbol_of_output_alias(checker: &mut Checker, type_node: P<Node>) -> Option<P<Symbol>> {
    if type_node.kind() == Kind::TypeQuery {
        return schema_symbol_from_type_query(checker, type_node.as_type_query_node());
    }
    if type_node.kind() != Kind::TypeReference {
        return None;
    }
    let type_ref = type_node.as_type_reference_node();
    let member_name = rightmost_identifier_name(type_ref.type_name());
    if !SCHEMA_OUTPUT_TYPE_NAMES.contains(&member_name) {
        return None;
    }
    let type_args = type_ref.type_arguments()?;
    let &first_arg = type_args.nodes().first()?;
    if first_arg.kind() != Kind::TypeQuery {
        return None;
    }
    let query_type = checker.get_type_from_type_node(first_arg);
    let expr_name = first_arg.as_type_query_node().expr_name();
    let target = if ast::is_qualified_name(expr_name) {
        expr_name.as_qualified_name().right()
    } else {
        expr_name
    };
    provenance::symbol_at_node(checker, target).or_else(|| {
        query_type
            .symbol()
            .map(|sym| provenance::resolve_aliased_symbol(checker, sym))
    })
}

fn alias_declaration_of_type_node(checker: &mut Checker, type_node: P<Node>) -> Option<P<Node>> {
    if type_node.kind() != Kind::TypeReference {
        return None;
    }
    let type_ref = type_node.as_type_reference_node();
    let mut target = type_ref.type_name();
    if ast::is_qualified_name(target) {
        target = target.as_qualified_name().right();
    }
    let sym = provenance::symbol_at_node(checker, target);
    provenance::symbol_declarations(checker, sym)
        .into_iter()
        .find(|&decl| decl.kind() == Kind::TypeAliasDeclaration)
}

pub fn declared_schema_parameter(
    checker: &mut Checker,
    arg_node: P<Node>,
) -> Option<DeclaredSchemaParam> {
    let sym = checker.get_symbol_at_location_exported(arg_node)?;
    let mut param_decl_and_type = None;
    for &decl in sym.declarations() {
        if ast::is_parameter_declaration(decl)
            && let Some(param_type) = decl.as_parameter_declaration().type_()
        {
            param_decl_and_type = Some((decl, param_type));
            break;
        }
    }
    let (param_decl, param_type) = param_decl_and_type?;
    if let Some(direct) = schema_symbol_of_output_alias(checker, param_type) {
        return Some(DeclaredSchemaParam {
            declaration: param_decl,
            schema_sym: direct,
        });
    }
    let alias = alias_declaration_of_type_node(checker, param_type)?;
    let alias_type = alias.as_type_alias_declaration().type_()?;
    let schema_sym = schema_symbol_of_output_alias(checker, alias_type)?;
    Some(DeclaredSchemaParam {
        declaration: param_decl,
        schema_sym,
    })
}
