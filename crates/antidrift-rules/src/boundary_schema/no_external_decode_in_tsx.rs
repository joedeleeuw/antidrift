use antidrift_kernel::imports::FileImports;
use antidrift_kernel::local_binding::resolve_lexical_binding;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{boundary, provenance, tsrs_kernel};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, Symbol};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-external-decode-in-tsx";

pub struct NoExternalDecodeInTsx {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoExternalDecodeInTsx = NoExternalDecodeInTsx {
    scope: RuleScope::DEFAULT,
};

impl NoExternalDecodeInTsx {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoExternalDecodeInTsx {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) || !ctx.file.file_name().ends_with(".tsx") {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor {
            imports: FileImports::collect(ctx.file),
        })
    }
}

struct Visitor {
    imports: FileImports,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if boundary::is_global_json_parse(None, ctx.checker, node)
            && !is_local_form_schema_json(node, &self.imports, ctx)
        {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "no-external-decode-in-tsx",
                    "Do not decode wire or persisted JSON in a TSX view module. Decode once in a non-view owner and pass a typed projection inward.",
                ),
            );
            return;
        }
        let Some(parts) = boundary::schema_validation_call_parts(node, ctx.checker) else {
            return;
        };
        let mut seen = FxHashSet::default();
        if is_component_local_input(parts.arg_node, &self.imports, ctx.checker, &mut seen) {
            return;
        }
        ctx.report_node(
            node,
            RuleMessage::new(
                "no-external-decode-in-tsx",
                format!(
                    "Move this external `.{}(...)` decode into a non-view owner and pass the typed projection into the TSX view module.",
                    parts.method
                ),
            ),
        );
    }
}

fn is_component_local_input(
    node: P<Node>,
    imports: &FileImports,
    checker: &mut Checker,
    seen: &mut FxHashSet<P<Symbol>>,
) -> bool {
    let node = tsrs_kernel::unwrap_expression(node);
    match node.kind() {
        Kind::ObjectLiteralExpression => node
            .as_object_literal_expression()
            .properties()
            .nodes()
            .iter()
            .any(|&property| match property.kind() {
                Kind::PropertyAssignment => is_component_local_input(
                    property.as_property_assignment().initializer(),
                    imports,
                    checker,
                    seen,
                ),
                Kind::ShorthandPropertyAssignment => is_component_local_input(
                    property.as_shorthand_property_assignment().name(),
                    imports,
                    checker,
                    seen,
                ),
                _ => false,
            }),
        Kind::BinaryExpression
            if node.as_binary_expression().operator_token().kind()
                == Kind::QuestionQuestionToken =>
        {
            let binary = node.as_binary_expression();
            is_component_local_input(binary.left(), imports, checker, seen)
                || is_component_local_input(binary.right(), imports, checker, seen)
        }
        Kind::Identifier | Kind::PropertyAccessExpression | Kind::ElementAccessExpression => {
            let root = root_receiver(node);
            ast::is_identifier(root) && is_component_local_binding(root, imports, checker, seen)
        }
        _ => false,
    }
}

fn root_receiver(node: P<Node>) -> P<Node> {
    let mut current = node;
    loop {
        current = match current.kind() {
            Kind::PropertyAccessExpression => current.as_property_access_expression().expression(),
            Kind::ElementAccessExpression => current.as_element_access_expression().expression(),
            _ => return current,
        };
    }
}

fn is_component_local_binding(
    node: P<Node>,
    imports: &FileImports,
    checker: &mut Checker,
    seen: &mut FxHashSet<P<Symbol>>,
) -> bool {
    if let Some(binding) = resolve_lexical_binding(node)
        && let Some(initializer) = local_declaration_initializer(binding.decl)
        && is_use_state_call(initializer, imports, checker)
    {
        return true;
    }
    let Some(symbol) = provenance::symbol_at_node(checker, node) else {
        return false;
    };
    if !seen.insert(symbol) {
        return false;
    }
    for declaration in provenance::symbol_declarations(checker, Some(symbol)) {
        let Some(initializer) = local_declaration_initializer(declaration) else {
            continue;
        };
        if is_use_state_call(initializer, imports, checker)
            || is_component_local_input(initializer, imports, checker, seen)
        {
            return true;
        }
    }
    false
}

fn local_declaration_initializer(declaration: P<Node>) -> Option<P<Node>> {
    let mut current = Some(declaration);
    while let Some(candidate) = current {
        match candidate.kind() {
            Kind::VariableDeclaration => {
                return candidate.as_variable_declaration().initializer();
            }
            Kind::Identifier
            | Kind::BindingElement
            | Kind::ObjectBindingPattern
            | Kind::ArrayBindingPattern => {
                current = candidate.parent();
            }
            _ => return None,
        }
    }
    None
}

fn is_use_state_call(node: P<Node>, imports: &FileImports, checker: &mut Checker) -> bool {
    let node = tsrs_kernel::unwrap_expression(node);
    if node.kind() != Kind::CallExpression {
        return false;
    }
    let callee = node.as_call_expression().expression();
    if imports.is_unshadowed_call(callee, "react", &["useState"]) {
        return true;
    }
    let name_node = match callee.kind() {
        Kind::Identifier => callee,
        Kind::PropertyAccessExpression => callee.as_property_access_expression().name(),
        _ => return false,
    };
    if !ast::is_identifier(name_node) || name_node.as_identifier().text() != "useState" {
        return false;
    }
    let symbol = provenance::symbol_at_node(checker, name_node);
    boundary::symbol_package_path(checker, symbol)
        .is_some_and(|path| path.starts_with("react/") || path.starts_with("@types/react/"))
}

fn is_local_form_schema_json(node: P<Node>, imports: &FileImports, ctx: &mut Ctx) -> bool {
    let mut current = node.parent();
    let schema_symbol = loop {
        let Some(candidate) = current else {
            return false;
        };
        if candidate.kind() == Kind::VariableDeclaration {
            break provenance::symbol_at_node(
                ctx.checker,
                candidate.as_variable_declaration().name(),
            );
        }
        if candidate.kind() == Kind::SourceFile {
            return false;
        }
        current = candidate.parent();
    };
    let Some(schema_symbol) = schema_symbol else {
        return false;
    };
    let mut usage_count = 0;
    let mut all_local = true;
    collect_schema_usages(
        ctx.file.as_node(),
        schema_symbol,
        imports,
        ctx,
        &mut usage_count,
        &mut all_local,
    );
    usage_count > 0 && all_local
}

fn collect_schema_usages(
    node: P<Node>,
    schema_symbol: P<Symbol>,
    imports: &FileImports,
    ctx: &mut Ctx,
    usage_count: &mut usize,
    all_local: &mut bool,
) {
    if node.kind() == Kind::CallExpression
        && let Some(parts) = boundary::schema_validation_call_parts(node, ctx.checker)
        && boundary::parsed_schema_symbol(ctx.checker, Some(node), Some(parts.schema_node))
            == Some(schema_symbol)
    {
        *usage_count += 1;
        let mut seen = FxHashSet::default();
        if !is_component_local_input(parts.arg_node, imports, ctx.checker, &mut seen) {
            *all_local = false;
        }
    }
    node.for_each_child(&mut |child| {
        collect_schema_usages(child, schema_symbol, imports, ctx, usage_count, all_local);
        false
    });
}
