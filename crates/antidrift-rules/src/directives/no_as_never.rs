use antidrift_kernel::rule::{ReportDiagnostic, Rule, RuleContext};
use antidrift_kernel::rule_scope::is_rule_file;
use oxc::ast::ast::{TSAsExpression, TSType, TSTypeName};
use oxc::ast_visit::Visit;
use oxc::span::Span;

pub(super) struct NoAsNeverRule;

impl Rule for NoAsNeverRule {
    fn id(&self) -> &'static str {
        "antidrift/no-as-never"
    }

    fn run(&self, ctx: &mut RuleContext<'_, '_>) {
        if !is_rule_file(ctx, None) {
            return;
        }
        let Some(program) = ctx.program else {
            return;
        };
        let mut finder = AsNeverVisitor {
            offending_spans: Vec::new(),
        };
        finder.visit_program(program);
        for span in finder.offending_spans {
            ctx.report(ReportDiagnostic {
                span,
                message_id: Some("forbidden".to_string()),
                message: "Do not cast to 'never'. Fix the type boundary instead.".to_string(),
                fix: None,
            });
        }
    }
}

struct AsNeverVisitor {
    offending_spans: Vec<Span>,
}

impl<'a> Visit<'a> for AsNeverVisitor {
    fn visit_ts_as_expression(&mut self, it: &TSAsExpression<'a>) {
        if is_never_type_annotation(&it.type_annotation) {
            self.offending_spans.push(it.span);
        }
        oxc::ast_visit::walk::walk_ts_as_expression(self, it);
    }
}

fn is_never_type_annotation(annotation: &TSType<'_>) -> bool {
    match annotation {
        TSType::TSNeverKeyword(_) => true,
        TSType::TSTypeReference(type_ref) => match &type_ref.type_name {
            TSTypeName::IdentifierReference(ident) => ident.name == "never",
            _ => false,
        },
        _ => false,
    }
}
