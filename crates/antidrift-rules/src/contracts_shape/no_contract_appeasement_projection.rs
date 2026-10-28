use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{projection, tsrs_kernel};
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

fn check_function_candidate(ctx: &mut Ctx, function: P<Node>, candidate: P<Node>) {
    let file_name = ctx.file.file_name();
    if !tsrs_kernel::is_test_file(file_name)
        && !tsrs_kernel::is_generated_file(file_name, ctx.file.text())
        && let Some(classification) =
            projection::classify_bag_reshaper(function, candidate, ctx.checker, ctx.file)
    {
        match classification {
            projection::BagReshaperClassification::BagToContract {
                parameter_name,
                target_contract,
            } => {
                ctx.report_node(
                    candidate,
                    build_bag_to_contract_message(&parameter_name, &target_contract),
                );
            }
            projection::BagReshaperClassification::BagToBag { parameter_name } => {
                ctx.report_node(candidate, build_bag_to_bag_message(&parameter_name));
            }
        }
        return;
    }
    if is_exported_boundary(candidate, ctx.file) {
        return;
    }
    if projection::is_contract_appeasement_projection(function, ctx.file, ctx.checker) {
        ctx.report_node(candidate, build_contract_appeasement_projection_message());
    }
}

impl Rule for NoContractAppeasementProjection {
    fn name(&self) -> &'static str {
        "antidrift/no-contract-appeasement-projection"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

struct Visitor;

const LISTENERS: [Listener; 5] = [
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::PropertyDeclaration),
    Listener::Enter(Kind::PropertyAssignment),
];

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        &LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if let Some(fn_node) = tsrs_kernel::function_node_from_declaration(node) {
            check_function_candidate(ctx, fn_node, node);
        }
    }
}
