use tsrs_ast::{self as ast, Kind, Node, Symbol, TypeQueryNode};
use tsrs_checker::{Checker, SignatureKind, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::utils::{is_object_type, is_type_flag_set};

use crate::provenance;

const ZOD_PARSE_METHODS: &[&str] = &["parse", "parseAsync"];
const ZOD_VALIDATION_METHODS: &[&str] = &["parse", "parseAsync", "safeParse", "safeParseAsync"];
const TYPEBOX_VALIDATION_METHODS: &[&str] = &["Decode", "Parse", "Check"];
#[rustfmt::skip]
const EFFECT_DECODE_METHODS: &[&str] = &[
    "decode", "decodeSync", "decodePromise", "decodeOption", "decodeEither", "decodeUnknown",
    "decodeUnknownSync", "decodeUnknownPromise", "decodeUnknownOption", "decodeUnknownEither",
    "decodeUnknownEffect", "decodeUnknownExit",
];
#[rustfmt::skip]
const SCHEMA_OUTPUT_TYPE_NAMES: &[&str] = &[
    "infer", "output", "TypeOf", "InferOutput", "Type", "Static", "StaticDecode",
];
#[rustfmt::skip]
const SCHEMA_CARRIER_PROPS: &[&str] = &[
    "_output", "_input", "_def", "_zod", "~standard", "parse", "safeParse", "ast", "Type", "kind",
];

#[derive(Clone, Debug)]
pub struct SchemaValidationCall {
    pub call_node: P<Node>,
    pub arg_node: P<Node>,
    pub schema_node: P<Node>,
    pub method: &'static str,
    pub returns_schema_output: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct DeclaredSchemaParam {
    pub declaration: P<Node>,
    pub schema_sym: P<Symbol>,
}

pub fn is_schema_carrier_type(checker: &mut Checker, ty: P<Type>) -> bool {
    !is_type_flag_set(ty, TypeFlags::AnyOrUnknown)
        && is_object_type(ty)
        && SCHEMA_CARRIER_PROPS
            .iter()
            .any(|&prop| checker.get_property_of_type_exported(ty, prop).is_some())
}

pub fn is_schema_carrier_node(checker: &mut Checker, node: P<Node>) -> bool {
    let ty = checker.get_type_at_location(node);
    !is_type_flag_set(ty, TypeFlags::AnyOrUnknown)
        && is_object_type(ty)
        && SCHEMA_CARRIER_PROPS
            .iter()
            .any(|&prop| checker.get_property_of_type_exported(ty, prop).is_some())
}

fn is_receiver_decoder_call(
    checker: &mut Checker,
    call_node: P<Node>,
    callee: P<Node>,
    receiver: P<Node>,
) -> bool {
    if ast::is_identifier(receiver)
        && matches!(
            receiver.as_identifier().text(),
            "JSON" | "Date" | "Number" | "URL" | "Object" | "Reflect"
        )
    {
        return false;
    }
    let receiver_type = checker.get_type_at_location(receiver);
    if is_type_flag_set(receiver_type, TypeFlags::AnyOrUnknown) {
        return false;
    }
    let has_carrier = is_schema_carrier_type(checker, receiver_type);
    let callee_type = checker.get_type_at_location(callee);
    for &sig in checker.get_signatures_of_type(callee_type, SignatureKind::Call) {
        let Some(&first_param) = sig.parameters().first() else {
            continue;
        };
        let Some(param_type) = checker.get_type_of_symbol_at_location(first_param, Some(call_node))
        else {
            continue;
        };
        if !is_type_flag_set(param_type, TypeFlags::AnyOrUnknown) {
            continue;
        }
        let ret_type = checker.get_return_type_of_signature(sig);
        if is_type_flag_set(ret_type, TypeFlags::Void | TypeFlags::Never) {
            continue;
        }
        if has_carrier || !is_type_flag_set(ret_type, TypeFlags::Any) {
            return true;
        }
    }
    false
}

fn is_schema_first_decoder_call(
    checker: &mut Checker,
    call_node: P<Node>,
    callee: P<Node>,
    schema_arg: P<Node>,
) -> bool {
    if !is_schema_carrier_node(checker, schema_arg) {
        return false;
    }
    let callee_type = checker.get_type_at_location(callee);
    if is_type_flag_set(callee_type, TypeFlags::AnyOrUnknown) {
        return false;
    }
    for &sig in checker.get_signatures_of_type(callee_type, SignatureKind::Call) {
        let params = sig.parameters();
        if params.len() < 2 {
            continue;
        }
        let Some(first_type) = checker.get_type_of_symbol_at_location(params[0], Some(call_node))
        else {
            continue;
        };
        if is_type_flag_set(
            first_type,
            TypeFlags::StringLike | TypeFlags::NumberLike | TypeFlags::BooleanLike,
        ) {
            continue;
        }
        let Some(second_type) = checker.get_type_of_symbol_at_location(params[1], Some(call_node))
        else {
            continue;
        };
        if is_type_flag_set(second_type, TypeFlags::AnyOrUnknown) {
            return true;
        }
    }
    false
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
    if !methods.contains(&method_name)
        || !is_receiver_decoder_call(checker, call_node, call.expression(), prop.expression())
    {
        return None;
    }
    Some(SchemaValidationCall {
        call_node,
        arg_node: args[0],
        schema_node: prop.expression(),
        method: method_name,
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
    if !EFFECT_DECODE_METHODS.contains(&method_name)
        || !is_schema_carrier_node(checker, schema_args[0])
    {
        return None;
    }
    Some(SchemaValidationCall {
        call_node,
        arg_node: value_arg,
        schema_node: schema_args[0],
        method: method_name,
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
    let (_, method_name) = extract_callee_method_ident(call.expression())?;
    if method_name.is_empty() {
        return None;
    }
    let is_zod_like = ZOD_VALIDATION_METHODS.contains(&method_name);
    let is_typebox = TYPEBOX_VALIDATION_METHODS.contains(&method_name);
    if (!is_zod_like && !is_typebox)
        || !is_schema_first_decoder_call(checker, call_node, call.expression(), args[0])
    {
        return None;
    }
    Some(SchemaValidationCall {
        call_node,
        arg_node: args[1],
        schema_node: args[0],
        method: method_name,
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

fn rightmost_identifier_name(node: P<Node>) -> Option<&'static str> {
    if ast::is_identifier(node) {
        return Some(node.as_identifier().text());
    }
    if ast::is_qualified_name(node) {
        let right = node.as_qualified_name().right();
        if ast::is_identifier(right) {
            return Some(right.as_identifier().text());
        }
    }
    None
}

fn schema_symbol_of_output_alias(checker: &mut Checker, type_node: P<Node>) -> Option<P<Symbol>> {
    if type_node.kind() == Kind::TypeQuery {
        return schema_symbol_from_type_query(checker, type_node.as_type_query_node());
    }
    if type_node.kind() != Kind::TypeReference {
        return None;
    }
    let type_ref = type_node.as_type_reference_node();
    let member_name = rightmost_identifier_name(type_ref.type_name())?;
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
