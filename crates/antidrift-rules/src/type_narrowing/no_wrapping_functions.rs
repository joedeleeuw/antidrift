use antidrift_kernel::callgraph::{IdentifierRef, ProgramSymbolIndex};
use antidrift_kernel::rule_scope::RuleScope;
use antidrift_kernel::{callgraph, provenance, tsrs_kernel};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile, Symbol};
use tsrs_checker::Checker;
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrslint::utils::find_modifier;

const RULE_NAME: &str = "antidrift/no-wrapping-functions";

fn declaration_statement(decl: P<Node>) -> P<Node> {
    if decl.kind() == Kind::VariableDeclaration
        && let Some(list) = decl.parent()
        && let Some(stmt) = list.parent()
    {
        return stmt;
    }
    decl
}

fn has_default_or_ambient_modifier(decl: P<Node>) -> bool {
    let stmt = declaration_statement(decl);
    find_modifier(stmt, Kind::DefaultKeyword).is_some()
        || find_modifier(stmt, Kind::DeclareKeyword).is_some()
}

fn is_exported_declaration(decl: P<Node>) -> bool {
    let stmt = declaration_statement(decl);
    find_modifier(stmt, Kind::ExportKeyword).is_some()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BodyForwarding {
    Direct,
    BoundLiteral,
    PrecedingEffect,
    BoundLiteralAndPrecedingEffect,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanStatus {
    Clean(BodyForwarding),
    ArgumentsHazard,
}

impl ScanStatus {
    fn record_bound_literal(&mut self) {
        if let Self::Clean(curr) = *self {
            let next = match curr {
                BodyForwarding::Direct | BodyForwarding::BoundLiteral => {
                    BodyForwarding::BoundLiteral
                }
                BodyForwarding::PrecedingEffect
                | BodyForwarding::BoundLiteralAndPrecedingEffect => {
                    BodyForwarding::BoundLiteralAndPrecedingEffect
                }
            };
            *self = Self::Clean(next);
        }
    }

    fn record_preceding_effect(&mut self) {
        if let Self::Clean(curr) = *self {
            let next = match curr {
                BodyForwarding::Direct | BodyForwarding::PrecedingEffect => {
                    BodyForwarding::PrecedingEffect
                }
                BodyForwarding::BoundLiteral | BodyForwarding::BoundLiteralAndPrecedingEffect => {
                    BodyForwarding::BoundLiteralAndPrecedingEffect
                }
            };
            *self = Self::Clean(next);
        }
    }
}

struct BodyUseScan {
    param_symbols: Vec<Option<P<Symbol>>>,
    used_indices: Vec<usize>,
    status: ScanStatus,
}

fn is_literal_kind(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::StringLiteral
            | Kind::NumericLiteral
            | Kind::BigIntLiteral
            | Kind::RegularExpressionLiteral
            | Kind::TrueKeyword
            | Kind::FalseKeyword
            | Kind::NullKeyword
            | Kind::NoSubstitutionTemplateLiteral
    )
}

fn consists_of_literals(node: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if is_literal_kind(unwrapped.kind()) {
        return true;
    }
    if unwrapped.kind() == Kind::PrefixUnaryExpression {
        return consists_of_literals(unwrapped.as_prefix_unary_expression().operand());
    }
    if unwrapped.kind() == Kind::ArrayLiteralExpression {
        return unwrapped
            .as_array_literal_expression()
            .elements()
            .nodes()
            .iter()
            .copied()
            .all(consists_of_literals);
    }
    false
}

fn is_literal_constant(checker: &mut Checker, sym: Option<P<Symbol>>) -> bool {
    let Some(symbol) = sym else {
        return false;
    };
    let resolved = provenance::resolve_aliased_symbol(checker, symbol);
    let Some(decl) = resolved
        .value_declaration()
        .or_else(|| resolved.declarations().first().copied())
    else {
        return false;
    };
    if decl.kind() == Kind::VariableDeclaration
        && ast::get_combined_node_flags(decl).intersects(ast::NodeFlags::Const)
        && let Some(init) = decl.as_variable_declaration().initializer()
    {
        return consists_of_literals(init);
    }
    false
}

fn scan_call_body(node: P<Node>, checker: &mut Checker, state: &mut BodyUseScan) {
    if is_literal_kind(node.kind()) {
        state.status.record_bound_literal();
    }
    if ast::is_identifier(node) {
        let sym = checker.get_symbol_at_location_exported(node);
        if let Some(pos) = state
            .param_symbols
            .iter()
            .position(|&param_sym| param_sym.is_some() && param_sym == sym)
        {
            state.used_indices.push(pos);
        } else if sym.is_none() && node.as_identifier().text() == "arguments" {
            state.status = ScanStatus::ArgumentsHazard;
        } else if is_literal_constant(checker, sym) {
            state.status.record_bound_literal();
        }
        return;
    }
    if ast::is_shorthand_property_assignment(node) {
        let sym = checker.get_shorthand_assignment_value_symbol(Some(node));
        if let Some(pos) = state
            .param_symbols
            .iter()
            .position(|&param_sym| param_sym.is_some() && param_sym == sym)
        {
            state.used_indices.push(pos);
        }
        return;
    }
    if ast::is_property_access_expression(node) {
        if state.used_indices.is_empty() {
            state.status.record_preceding_effect();
        }
        scan_call_body(
            node.as_property_access_expression().expression(),
            checker,
            state,
        );
        return;
    }
    if ast::is_property_assignment(node) {
        let prop = node.as_property_assignment();
        if prop.name().kind() == Kind::ComputedPropertyName {
            scan_call_body(prop.name(), checker, state);
        }
        scan_call_body(prop.initializer(), checker, state);
        return;
    }
    node.for_each_child(&mut |child| {
        scan_call_body(child, checker, state);
        false
    });
}

enum WrapperVerdict {
    AddedSemantics,
    UnusedHop,
    Hop(usize),
}

fn classify_wrapper(
    forwarding: BodyForwarding,
    audit: &RefAudit,
    exported: bool,
    reexported_or_entry: bool,
) -> WrapperVerdict {
    let has_bound_literal = matches!(
        forwarding,
        BodyForwarding::BoundLiteral | BodyForwarding::BoundLiteralAndPrecedingEffect
    );
    let has_preceding_effect = matches!(
        forwarding,
        BodyForwarding::PrecedingEffect | BodyForwarding::BoundLiteralAndPrecedingEffect
    );
    if audit.has_identity_ref
        || (has_bound_literal && audit.caller_files.len() >= 2)
        || (has_preceding_effect && audit.has_non_immutable_arg)
        || (exported && reexported_or_entry)
    {
        return WrapperVerdict::AddedSemantics;
    }
    let total_refs = audit.non_test_refs + audit.test_refs;
    let calls = audit.call_count.min(total_refs);
    if calls == 0 {
        if exported {
            WrapperVerdict::AddedSemantics
        } else {
            WrapperVerdict::UnusedHop
        }
    } else {
        WrapperVerdict::Hop(calls)
    }
}

fn parameters_match_in_order(
    fn_node: P<Node>,
    call_node: P<Node>,
    checker: &mut Checker,
) -> Option<BodyForwarding> {
    let params = fn_node.parameters();
    let param_symbols: Vec<_> = params
        .iter()
        .map(|&p| {
            p.name()
                .and_then(|n| checker.get_symbol_at_location_exported(n))
        })
        .collect();
    let mut scan = BodyUseScan {
        param_symbols,
        used_indices: Vec::new(),
        status: ScanStatus::Clean(BodyForwarding::Direct),
    };
    scan_call_body(call_node, checker, &mut scan);
    let ScanStatus::Clean(forwarding) = scan.status else {
        return None;
    };
    (scan.used_indices.len() == params.len()
        && scan
            .used_indices
            .iter()
            .enumerate()
            .all(|(expected, &actual)| expected == actual))
    .then_some(forwarding)
}

#[derive(Default)]
struct RefAudit {
    has_identity_ref: bool,
    has_export_specifier: bool,
    has_non_immutable_arg: bool,
    call_count: usize,
    caller_files: FxHashSet<P<SourceFile>>,
    non_test_refs: usize,
    test_refs: usize,
}

fn is_immutable_call_argument(arg: P<Node>, checker: &mut Checker) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(arg);
    if is_literal_kind(unwrapped.kind())
        || matches!(
            unwrapped.kind(),
            Kind::ArrowFunction | Kind::FunctionExpression
        )
    {
        return true;
    }
    if !ast::is_identifier(unwrapped) {
        return false;
    }
    let Some(sym) = provenance::symbol_at_node(checker, unwrapped) else {
        return false;
    };
    let Some(decl) = sym
        .value_declaration()
        .or_else(|| sym.declarations().first().copied())
    else {
        return unwrapped.as_identifier().text() == "undefined";
    };
    match decl.kind() {
        Kind::Parameter | Kind::FunctionDeclaration => true,
        Kind::VariableDeclaration => {
            ast::get_combined_node_flags(decl).intersects(ast::NodeFlags::Const)
        }
        _ => false,
    }
}

fn call_for_direct_reference(ident: P<Node>) -> Option<P<Node>> {
    let parent = ident.parent()?;
    let callee = if ast::is_property_access_expression(parent)
        && parent.as_property_access_expression().name() == ident
    {
        parent
    } else {
        ident
    };
    let call_node = callee.parent()?;
    if !ast::is_call_expression(call_node) {
        return None;
    }
    let call = call_node.as_call_expression();
    let valid = call.expression() == callee
        && call.question_dot_token().is_none()
        && call.type_arguments().is_none()
        && !call
            .arguments()
            .nodes()
            .iter()
            .any(|&arg| arg.kind() == Kind::SpreadElement);
    valid.then_some(call_node)
}

fn audit_reference(reference: IdentifierRef, checker: &mut Checker, audit: &mut RefAudit) {
    if reference.is_test_file {
        audit.test_refs += 1;
    } else {
        audit.non_test_refs += 1;
    }
    let node = reference.node;
    let parent = node.parent();
    if parent.is_some_and(ast::is_import_specifier) {
        return;
    }
    if let Some(exp) = parent
        && ast::is_export_specifier(exp)
    {
        if exp.as_export_specifier().name().text() == "default" {
            audit.has_identity_ref = true;
        } else {
            audit.has_export_specifier = true;
        }
        return;
    }
    let Some(call_node) = call_for_direct_reference(node) else {
        audit.has_identity_ref = true;
        return;
    };
    audit.call_count += 1;
    audit.caller_files.insert(reference.file);
    if call_node
        .as_call_expression()
        .arguments()
        .nodes()
        .iter()
        .any(|&arg| !is_immutable_call_argument(arg, checker))
    {
        audit.has_non_immutable_arg = true;
    }
}

fn audit_program_references(
    program: &Program,
    checker: &mut Checker,
    sym: P<Symbol>,
    name: &'static str,
) -> RefAudit {
    let index = ProgramSymbolIndex::for_program(program);
    let mut audit = RefAudit::default();
    for reference in index.references_to_symbol(checker, sym, name) {
        audit_reference(reference, checker, &mut audit);
    }
    audit
}

fn is_reexported_in_program(
    program: &Program,
    checker: &mut Checker,
    target_sf: P<SourceFile>,
) -> bool {
    for &sf in program.get_source_files() {
        if sf == target_sf || tsrs_kernel::is_declaration_file(sf.file_name()) {
            continue;
        }
        for &stmt in sf.statements().nodes() {
            if stmt.kind() == Kind::ExportDeclaration
                && let Some(spec) = stmt.as_export_declaration().module_specifier()
                && provenance::resolve_imported_source_file(checker, spec) == Some(target_sf)
            {
                return true;
            }
        }
    }
    false
}

fn check_candidate(ctx: &mut Ctx, fn_node: P<Node>, name_ident: P<Node>, decl: P<Node>) {
    let Some(candidate) = callgraph::find_delegated_call(fn_node, name_ident, decl) else {
        return;
    };
    if has_default_or_ambient_modifier(candidate.declaration) {
        return;
    }
    let Some(sym) = provenance::symbol_at_node(ctx.checker, candidate.name_node) else {
        return;
    };
    if sym.declarations().len() > 1 {
        return;
    }
    if let Some(ret_type_node) = tsrs_kernel::function_return_type_node(candidate.function_node) {
        let declared_ret = ctx.checker.get_type_from_type_node(ret_type_node);
        let body_type = ctx.checker.get_type_at_location(candidate.call_node);
        if !antidrift_kernel::shape::same_type(ctx.checker, declared_ret, body_type) {
            return;
        }
    }
    let Some(forwarding) =
        parameters_match_in_order(candidate.function_node, candidate.call_node, ctx.checker)
    else {
        return;
    };
    let name = candidate.name_node.as_identifier().text();
    let audit = audit_program_references(ctx.program, ctx.checker, sym, name);
    let package_entry = match provenance::is_package_entry_file(ctx.file.file_name()) {
        Ok(package_entry) => package_entry,
        Err(error) => {
            ctx.report_node(
                candidate.name_node,
                RuleMessage::new("invalidPackageJson", error.to_string()),
            );
            return;
        }
    };
    let exported = is_exported_declaration(candidate.declaration) || audit.has_export_specifier;
    let reexported_or_entry =
        exported && (is_reexported_in_program(ctx.program, ctx.checker, ctx.file) || package_entry);
    let callee = tsrs_kernel::node_text(ctx.file, candidate.callee_node);
    match classify_wrapper(forwarding, &audit, exported, reexported_or_entry) {
        WrapperVerdict::AddedSemantics => {}
        WrapperVerdict::UnusedHop => ctx.report_node(
            candidate.name_node,
            RuleMessage::new(
                "unusedHop",
                format!("'{name}' is a hop to '{callee}' with no call site; deleting it type-checks. Delete '{name}'."),
            ),
        ),
        WrapperVerdict::Hop(calls) => ctx.report_node(
            candidate.name_node,
            RuleMessage::new(
                "hop",
                format!("'{name}' is a hop to '{callee}': inlining it at its {calls} call site(s) type-checks and keeps each call's type, bindings and evaluation order. Call the owner directly and delete '{name}'."),
            ),
        ),
    }
}

pub struct NoWrappingFunctions {
    scope: RuleScope,
}

impl NoWrappingFunctions {
    pub const DEFAULT: Self = Self {
        scope: RuleScope::DEFAULT,
    };
}

pub static DEFAULT_INSTANCE: NoWrappingFunctions = NoWrappingFunctions::DEFAULT;

pub fn create(options: Option<&serde_json::Value>) -> Result<Box<dyn Rule>, String> {
    Ok(Box::new(NoWrappingFunctions {
        scope: RuleScope::from_options(RULE_NAME, options)?,
    }))
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::VariableDeclaration),
];

impl Rule for NoWrappingFunctions {
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
            Listener::Enter(Kind::FunctionDeclaration) => {
                if let Some(name_ident) = node.name() {
                    check_candidate(ctx, node, name_ident, node);
                }
            }
            Listener::Enter(Kind::VariableDeclaration) => {
                let var_decl = node.as_variable_declaration();
                let name_ident = var_decl.name();
                let Some(init) = var_decl.initializer() else {
                    return;
                };
                if ast::is_identifier(name_ident)
                    && matches!(init.kind(), Kind::ArrowFunction | Kind::FunctionExpression)
                {
                    check_candidate(ctx, init, name_ident, node);
                }
            }
            _ => {}
        }
    }
}
