use antidrift_kernel::file_role;
use antidrift_kernel::outcome_shape::find_sum_to_product_pair;
use antidrift_kernel::provenance::{DeclarationOrigin, classify_symbol_origin, symbol_at_node};
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{projection, tsrs_kernel};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

const RULE_NAME: &str = "antidrift/no-contract-appeasement-projection";

pub struct NoContractAppeasementProjection {
    scope: RuleScope,
}

pub static RULE: NoContractAppeasementProjection = NoContractAppeasementProjection {
    scope: RuleScope::DEFAULT,
};

impl NoContractAppeasementProjection {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

fn build_contract_appeasement_projection_message() -> RuleMessage {
    RuleMessage::new(
        "contractAppeasementProjection",
        "Do not project one owned value contract into another return contract just to satisfy a type. Use the source value directly, or construct/validate the target contract at its owning boundary.",
    )
}

fn build_bag_to_contract_message(parameter_name: &str, target_contract: &str) -> RuleMessage {
    RuleMessage::new(
        "bagToContract",
        format!(
            "Do not reshape parameter bag '{parameter_name}' into target contract '{target_contract}' without boundary validation or domain construction; pass '{target_contract}' from its owner or decode at the boundary."
        ),
    )
}

fn build_bag_to_bag_message(parameter_name: &str) -> RuleMessage {
    RuleMessage::new(
        "bagToBag",
        format!(
            "Do not repack parameter bag '{parameter_name}' into another ad-hoc object bag; read the owner's fields directly at the call site instead of threading a reshaped bag."
        ),
    )
}

fn build_constant_return_field_message(
    contract_name: &str,
    field_name: &str,
    constant_literal: &str,
) -> RuleMessage {
    RuleMessage::new(
        "constantReturnField",
        format!(
            "Return contract '{contract_name}' declares '{field_name}' as boolean, but every return branch in this module hardcodes '{field_name}: {constant_literal}'; compute the real value per branch or remove the dead contract field."
        ),
    )
}

fn build_outcome_flag_erasure_message(ok_line: usize, err_line: usize) -> RuleMessage {
    RuleMessage::new(
        "outcomeFlagErasure",
        format!(
            "Success and failure returns (lines {ok_line} and {err_line}) build the same object with complementary flag and error fields; return a discriminated union so consumers never read a nullable error behind a boolean flag."
        ),
    )
}

fn build_sum_to_product_erasure_message(discriminant_field: &str) -> RuleMessage {
    RuleMessage::new(
        "sumToProductErasure",
        format!(
            "Do not flatten discriminated state ('{discriminant_field}') into a boolean-flag + nullable-error product bag; preserve the discriminated union across the boundary."
        ),
    )
}

fn has_modifier(node: P<Node>, flags: ModifierFlags) -> bool {
    ast::can_have_modifiers(node) && ast::get_combined_modifier_flags(node).intersects(flags)
}

fn declaration_name_text(node: P<Node>) -> Option<&'static str> {
    let name_node = match node.kind() {
        Kind::VariableDeclaration => Some(node.as_variable_declaration().name()),
        Kind::FunctionDeclaration | Kind::ClassDeclaration => node.name(),
        _ => None,
    }?;
    ast::is_identifier(name_node).then(|| name_node.as_identifier().text())
}

fn named_exports_contain(clause: P<Node>, target_name: &str) -> bool {
    clause
        .as_named_exports()
        .elements()
        .nodes()
        .iter()
        .any(|&elem| {
            let spec = elem.as_export_specifier();
            let local = spec.property_name().unwrap_or_else(|| spec.name());
            ast::is_identifier(local) && local.as_identifier().text() == target_name
        })
}

fn is_named_in_file_exports(sf: P<SourceFile>, target_name: &str) -> bool {
    for &stmt in sf.statements().nodes() {
        if stmt.kind() == Kind::ExportDeclaration
            && let Some(clause) = stmt.as_export_declaration().export_clause()
            && clause.kind() == Kind::NamedExports
            && named_exports_contain(clause, target_name)
        {
            return true;
        } else if stmt.kind() == Kind::ExportAssignment {
            let expr = stmt.as_export_assignment().expression();
            if ast::is_identifier(expr) && expr.as_identifier().text() == target_name {
                return true;
            }
        }
    }
    false
}

fn is_directly_exported(node: P<Node>, sf: P<SourceFile>) -> bool {
    if has_modifier(node, ModifierFlags::Export) {
        return true;
    }
    if node.kind() == Kind::VariableDeclaration
        && let Some(list) = node.parent()
        && let Some(stmt) = list.parent()
        && has_modifier(stmt, ModifierFlags::Export)
    {
        return true;
    }
    declaration_name_text(node).is_some_and(|name| is_named_in_file_exports(sf, name))
}

fn object_exposes_identifier(obj_node: P<Node>, target_name: &str) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(obj_node);
    if !ast::is_object_literal_expression(unwrapped) {
        return false;
    }
    for &prop in unwrapped
        .as_object_literal_expression()
        .properties()
        .nodes()
    {
        if prop.kind() == Kind::ShorthandPropertyAssignment {
            let name = prop.as_shorthand_property_assignment().name();
            if ast::is_identifier(name) && name.as_identifier().text() == target_name {
                return true;
            }
        } else if prop.kind() == Kind::PropertyAssignment {
            let init = tsrs_kernel::unwrap_expression(prop.as_property_assignment().initializer());
            if ast::is_identifier(init) && init.as_identifier().text() == target_name {
                return true;
            }
        }
    }
    false
}

fn is_exported_boundary(candidate: P<Node>, sf: P<SourceFile>) -> bool {
    if is_directly_exported(candidate, sf) {
        return true;
    }
    match candidate.kind() {
        Kind::MethodDeclaration | Kind::PropertyDeclaration => {
            if has_modifier(candidate, ModifierFlags::Private | ModifierFlags::Protected)
                || candidate
                    .name()
                    .is_some_and(|n| n.kind() == Kind::PrivateIdentifier)
            {
                return false;
            }
            candidate
                .parent()
                .is_some_and(|cls| is_directly_exported(cls, sf))
        }
        Kind::PropertyAssignment => candidate
            .parent()
            .and_then(tsrs_kernel::enclosing_function)
            .is_some_and(|enclosing| is_exported_function_boundary(enclosing, sf)),
        Kind::FunctionDeclaration | Kind::VariableDeclaration => {
            let Some(name) = declaration_name_text(candidate) else {
                return false;
            };
            let Some(enclosing) = tsrs_kernel::enclosing_function(candidate) else {
                return false;
            };
            if !is_exported_function_boundary(enclosing, sf) {
                return false;
            }
            tsrs_kernel::collect_return_expressions(tsrs_kernel::function_body_node(enclosing))
                .into_iter()
                .any(|ret| object_exposes_identifier(ret, name))
        }
        _ => false,
    }
}

fn is_exported_function_boundary(fn_node: P<Node>, sf: P<SourceFile>) -> bool {
    if fn_node.kind() == Kind::FunctionDeclaration {
        return is_directly_exported(fn_node, sf);
    }
    fn_node
        .parent()
        .is_some_and(|parent| is_directly_exported(parent, sf))
}

fn type_reference_origin(ctx: &mut Ctx, type_node: Option<P<Node>>) -> DeclarationOrigin {
    let Some(node) = type_node else {
        return DeclarationOrigin::Unknown;
    };
    if node.kind() != Kind::TypeReference {
        return DeclarationOrigin::Unknown;
    }
    let sym = symbol_at_node(ctx.checker, node.as_type_reference_node().type_name());
    classify_symbol_origin(ctx.program, ctx.checker, sym, Some(ctx.file))
}

fn is_cross_boundary_domain_mapper(ctx: &mut Ctx, function: P<Node>, candidate: P<Node>) -> bool {
    if !is_exported_boundary(candidate, ctx.file) {
        return false;
    }
    let mut non_this = function.parameters().iter().copied().filter(|&param| {
        let name = param.as_parameter_declaration().name();
        !(ast::is_identifier(name) && name.as_identifier().text() == "this")
    });
    let Some(param_node) = non_this.next().filter(|_| non_this.next().is_none()) else {
        return false;
    };
    let param_origin = type_reference_origin(ctx, param_node.as_parameter_declaration().type_());
    let return_origin =
        type_reference_origin(ctx, tsrs_kernel::function_return_type_node(function));
    matches!(
        param_origin,
        DeclarationOrigin::NodeModules
            | DeclarationOrigin::Generated
            | DeclarationOrigin::LocalBoundary
    ) && return_origin == DeclarationOrigin::LocalDomain
}

fn check_function_candidate(ctx: &mut Ctx, function: P<Node>, candidate: P<Node>) -> bool {
    let file_name = ctx.file.file_name();
    if !file_role::is_test_file(file_name)
        && !file_role::is_generated_file(file_name, ctx.file.text())
        && let Some(classification) =
            projection::classify_bag_reshaper(function, candidate, ctx.checker, ctx.file)
    {
        match classification {
            projection::BagReshaperClassification::BagToContract {
                parameter_name,
                target_contract,
            } => {
                if !is_cross_boundary_domain_mapper(ctx, function, candidate) {
                    ctx.report_node(
                        candidate,
                        build_bag_to_contract_message(&parameter_name, &target_contract),
                    );
                    return true;
                }
            }
            projection::BagReshaperClassification::BagToBag { parameter_name } => {
                ctx.report_node(candidate, build_bag_to_bag_message(&parameter_name));
                return true;
            }
        }
        return false;
    }
    if is_exported_boundary(candidate, ctx.file) {
        return false;
    }
    if projection::is_contract_appeasement_projection(function, ctx.file, ctx.checker) {
        ctx.report_node(candidate, build_contract_appeasement_projection_message());
        return true;
    }
    false
}

impl Rule for NoContractAppeasementProjection {
    fn name(&self) -> &'static str {
        "antidrift/no-contract-appeasement-projection"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor {
            candidates: Vec::new(),
            object_literals: Vec::new(),
            reported_functions: FxHashSet::default(),
        })
    }
}

struct Visitor {
    candidates: Vec<(P<Node>, P<Node>)>,
    object_literals: Vec<P<Node>>,
    reported_functions: FxHashSet<P<Node>>,
}

const LISTENERS: [Listener; 7] = [
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::PropertyDeclaration),
    Listener::Enter(Kind::PropertyAssignment),
    Listener::Enter(Kind::ObjectLiteralExpression),
    Listener::Exit(Kind::EndOfFile),
];

fn report_end_of_file(
    ctx: &mut Ctx,
    candidates: &[(P<Node>, P<Node>)],
    object_literals: &[P<Node>],
    reported_functions: &FxHashSet<P<Node>>,
) {
    let file_name = ctx.file.file_name();
    if file_role::is_test_file(file_name)
        || file_role::is_generated_file(file_name, ctx.file.text())
    {
        return;
    }
    for violation in
        projection::find_constant_return_field_violations(candidates, ctx.file, ctx.checker)
    {
        ctx.report_node(
            violation.report_node,
            build_constant_return_field_message(
                &violation.contract_name,
                &violation.field_name,
                violation.constant_literal,
            ),
        );
    }
    for &obj_node in object_literals {
        if tsrs_kernel::enclosing_function(obj_node)
            .is_some_and(|fn_node| reported_functions.contains(&fn_node))
        {
            continue;
        }
        if let Some(disc) = projection::find_sum_to_product_erasure(obj_node) {
            ctx.report_node(obj_node, build_sum_to_product_erasure_message(&disc));
        }
    }
    let mut seen = FxHashSet::default();
    for &(fn_node, _) in candidates {
        if seen.insert(fn_node) {
            report_outcome_flag_erasure(ctx, fn_node);
        }
    }
}

fn return_branches(expr: P<Node>, out: &mut Vec<P<Node>>) {
    let unwrapped = tsrs_kernel::unwrap_expression(expr);
    if unwrapped.kind() == Kind::ConditionalExpression {
        let cond = unwrapped.as_conditional_expression();
        return_branches(cond.when_true(), out);
        return_branches(cond.when_false(), out);
        return;
    }
    out.push(unwrapped);
}

fn report_outcome_flag_erasure(ctx: &mut Ctx, fn_node: P<Node>) {
    let mut returns = Vec::new();
    for expr in tsrs_kernel::collect_return_expressions(tsrs_kernel::function_body_node(fn_node)) {
        return_branches(expr, &mut returns);
    }
    let arms: Vec<(_, P<Node>)> = returns
        .into_iter()
        .filter_map(|node| projection::outcome_arm(node).map(|arm| (arm, node)))
        .collect();
    let shapes: Vec<_> = arms.iter().map(|(arm, _)| arm.clone()).collect();
    let Some((ok_index, err_index)) = find_sum_to_product_pair(&shapes) else {
        return;
    };
    let ok_line = line_of(ctx, arms[ok_index].1);
    let err_line = line_of(ctx, arms[err_index].1);
    ctx.report_node(
        arms[err_index].1,
        build_outcome_flag_erasure_message(ok_line, err_line),
    );
}

fn line_of(ctx: &Ctx, node: P<Node>) -> usize {
    let (start, _) = tsrs_kernel::node_range(ctx.file, node);
    ctx.file.text()[..start].matches('\n').count() + 1
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        &LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>) {
        if matches!(listener, Listener::Exit(Kind::EndOfFile)) {
            report_end_of_file(
                ctx,
                &self.candidates,
                &self.object_literals,
                &self.reported_functions,
            );
            return;
        }
        if node.kind() == Kind::ObjectLiteralExpression {
            self.object_literals.push(node);
            return;
        }
        if let Some(fn_node) = tsrs_kernel::function_node_from_declaration(node) {
            self.candidates.push((fn_node, node));
            if check_function_candidate(ctx, fn_node, node) {
                self.reported_functions.insert(fn_node);
            }
        }
    }
}
