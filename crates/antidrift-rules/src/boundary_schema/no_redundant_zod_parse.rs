use antidrift_kernel::{boundary, projection, provenance, tsrs_kernel};
use rustc_hash::FxHashMap;
use tsrs_ast::{self as ast, Kind, Node, NodeFlags, SourceFile, Symbol};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-redundant-zod-parse";

pub struct NoRedundantZodParse;

pub static DEFAULT_RULE: NoRedundantZodParse = NoRedundantZodParse;

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoRedundantZodParse {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            provenance_map: FxHashMap::default(),
        })
    }
}

struct Visitor {
    provenance_map: FxHashMap<P<Symbol>, P<Symbol>>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        NoRedundantZodParse::check_call(node, ctx, &mut self.provenance_map);
    }
}

impl NoRedundantZodParse {
    fn check_call(
        node: P<Node>,
        ctx: &mut Ctx,
        provenance_map: &mut FxHashMap<P<Symbol>, P<Symbol>>,
    ) {
        let Some(parts) = boundary::schema_validation_call_parts(node, ctx.checker) else {
            return;
        };
        if boundary::is_throw_assertion_callback_parse(node) {
            return;
        }
        if let Some(reshape) =
            projection::classify_inline_parse_reshape(parts.arg_node, ctx.checker)
        {
            let message = match reshape.kind {
                projection::InlineParseReshapeKind::Conditional => format!(
                    "Do not branch on or default fields inside `.{}(...)` over `{}`; move coercion, defaults, and shape normalization into the schema definition or boundary decoder.",
                    parts.method, reshape.source
                ),
                projection::InlineParseReshapeKind::Object => format!(
                    "Do not rebuild `{}` field-by-field inside `.{}(...)`; parse the boundary payload directly with the schema or move normalization into the schema definition.",
                    reshape.source, parts.method
                ),
            };
            ctx.report_node(
                parts.arg_node,
                RuleMessage::new("no-redundant-zod-parse", message),
            );
            return;
        }
        let Some(schema_sym) =
            boundary::parsed_schema_symbol(ctx.checker, Some(node), Some(parts.schema_node))
        else {
            return;
        };
        let argument = tsrs_kernel::unwrap_expression(parts.arg_node);
        if ast::is_identifier(argument)
            && Self::report_if_redundant(node, argument, schema_sym, ctx, provenance_map)
        {
            return;
        }
        Self::record_const_parse_provenance(node, &parts, schema_sym, ctx.checker, provenance_map);
    }

    fn report_if_redundant(
        call_node: P<Node>,
        argument: P<Node>,
        schema_sym: P<Symbol>,
        ctx: &mut Ctx,
        provenance_map: &FxHashMap<P<Symbol>, P<Symbol>>,
    ) -> bool {
        let arg_name = argument.as_identifier().text();
        if let Some(arg_sym) = provenance::symbol_at_node(ctx.checker, argument)
            && provenance_map.get(&arg_sym) == Some(&schema_sym)
            && !Self::has_mutation_in_scope(ctx.file.as_node(), ctx.checker, arg_sym)
        {
            ctx.report_node(
                call_node,
                RuleMessage::new(
                    "no-redundant-zod-parse",
                    format!(
                        "Redundant Zod parse: `{arg_name}` was already validated by the same schema in this scope. Reuse the parsed value instead of re-parsing."
                    ),
                ),
            );
            return true;
        }
        if let Some(declared) = boundary::declared_schema_parameter(ctx.checker, argument)
            && declared.schema_sym == schema_sym
            && !boundary::is_server_action_parameter(ctx.checker, declared.declaration)
            && !Self::is_mutated_parameter(ctx.file, ctx.checker, declared.declaration)
        {
            ctx.report_node(
                call_node,
                RuleMessage::new(
                    "no-redundant-zod-parse",
                    format!(
                        "Redundant Zod parse: `{arg_name}` is already typed as the output of this schema on the function signature. Parse at the boundary before calling, or accept `unknown` if this function is the boundary."
                    ),
                ),
            );
            return true;
        }
        false
    }

    fn record_const_parse_provenance(
        node: P<Node>,
        parts: &boundary::SchemaValidationCall,
        schema_sym: P<Symbol>,
        checker: &mut Checker,
        provenance_map: &mut FxHashMap<P<Symbol>, P<Symbol>>,
    ) {
        if !parts.returns_schema_output {
            return;
        }
        let Some(parent) = node.parent() else {
            return;
        };
        if !ast::is_variable_declaration(parent)
            || !parent
                .parent()
                .is_some_and(|list| list.flags().intersects(NodeFlags::Const))
        {
            return;
        }
        let decl = parent.as_variable_declaration();
        if decl.initializer() == Some(node)
            && ast::is_identifier(decl.name())
            && let Some(var_sym) = provenance::symbol_at_node(checker, decl.name())
        {
            provenance_map.insert(var_sym, schema_sym);
        }
    }

    fn is_mutated_parameter(
        source_file: P<SourceFile>,
        checker: &mut Checker,
        declaration: P<Node>,
    ) -> bool {
        let name_node = declaration.as_parameter_declaration().name();
        let Some(param_sym) = provenance::symbol_at_node(checker, name_node) else {
            return false;
        };
        let scope =
            tsrs_kernel::enclosing_function(declaration).unwrap_or_else(|| source_file.as_node());
        Self::has_mutation_in_scope(scope, checker, param_sym)
    }

    fn has_mutation_in_scope(scope: P<Node>, checker: &mut Checker, target_sym: P<Symbol>) -> bool {
        let mut mutated = false;
        Self::scan_mutations(scope, checker, target_sym, &mut mutated);
        mutated
    }

    fn scan_mutations(
        node: P<Node>,
        checker: &mut Checker,
        target_sym: P<Symbol>,
        mutated: &mut bool,
    ) {
        if *mutated {
            return;
        }
        if Self::is_direct_mutation_node(node, checker, target_sym) {
            *mutated = true;
            return;
        }
        node.for_each_child(&mut |child| {
            Self::scan_mutations(child, checker, target_sym, mutated);
            *mutated
        });
    }

    fn is_direct_mutation_node(
        node: P<Node>,
        checker: &mut Checker,
        target_sym: P<Symbol>,
    ) -> bool {
        match node.kind() {
            Kind::BinaryExpression => {
                let bin = node.as_binary_expression();
                Self::is_assignment_operator(bin.operator_token().kind())
                    && Self::references_symbol_or_member(bin.left(), checker, target_sym)
            }
            Kind::PrefixUnaryExpression => {
                let unary = node.as_prefix_unary_expression();
                matches!(
                    unary.operator(),
                    Kind::PlusPlusToken | Kind::MinusMinusToken
                ) && Self::references_symbol_or_member(unary.operand(), checker, target_sym)
            }
            Kind::PostfixUnaryExpression => {
                let unary = node.as_postfix_unary_expression();
                matches!(
                    unary.operator(),
                    Kind::PlusPlusToken | Kind::MinusMinusToken
                ) && Self::references_symbol_or_member(unary.operand(), checker, target_sym)
            }
            Kind::DeleteExpression => Self::references_symbol_or_member(
                node.as_delete_expression().expression(),
                checker,
                target_sym,
            ),
            _ => false,
        }
    }

    fn references_symbol_or_member(
        node: P<Node>,
        checker: &mut Checker,
        target_sym: P<Symbol>,
    ) -> bool {
        let mut current = tsrs_kernel::unwrap_expression(node);
        while matches!(
            current.kind(),
            Kind::PropertyAccessExpression | Kind::ElementAccessExpression
        ) {
            current = if current.kind() == Kind::PropertyAccessExpression {
                tsrs_kernel::unwrap_expression(current.as_property_access_expression().expression())
            } else {
                tsrs_kernel::unwrap_expression(current.as_element_access_expression().expression())
            };
        }
        ast::is_identifier(current)
            && provenance::symbol_at_node(checker, current) == Some(target_sym)
    }

    const fn is_assignment_operator(kind: Kind) -> bool {
        matches!(
            kind,
            Kind::EqualsToken
                | Kind::PlusEqualsToken
                | Kind::MinusEqualsToken
                | Kind::AsteriskEqualsToken
                | Kind::AsteriskAsteriskEqualsToken
                | Kind::SlashEqualsToken
                | Kind::PercentEqualsToken
                | Kind::LessThanLessThanEqualsToken
                | Kind::GreaterThanGreaterThanEqualsToken
                | Kind::GreaterThanGreaterThanGreaterThanEqualsToken
                | Kind::AmpersandEqualsToken
                | Kind::BarEqualsToken
                | Kind::CaretEqualsToken
                | Kind::BarBarEqualsToken
                | Kind::AmpersandAmpersandEqualsToken
                | Kind::QuestionQuestionEqualsToken
        )
    }
}
