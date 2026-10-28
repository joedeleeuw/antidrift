use antidrift_kernel::rule::{ReportDiagnostic, Rule, RuleContext};
use antidrift_kernel::rule_scope::is_rule_file;
use oxc::ast::ast::{
    ArrowFunctionExpression, BindingPattern, Class, FormalParameters, Function, MethodDefinition,
    PropertyDefinition, PropertyKey, TSInterfaceDeclaration, TSPropertySignature,
    TSTypeAliasDeclaration, VariableDeclarator,
};
use oxc::ast_visit::{Visit, walk};
use oxc::span::Span;

pub(super) struct NoCompatNamesRule;

impl Rule for NoCompatNamesRule {
    fn id(&self) -> &'static str {
        "antidrift/no-compat-names"
    }

    fn run(&self, ctx: &mut RuleContext<'_, '_>) {
        if !is_rule_file(ctx, None) {
            return;
        }
        let Some(program) = ctx.program else {
            return;
        };
        let mut visitor = CompatNamesVisitor {
            flagged: Vec::new(),
        };
        visitor.visit_program(program);
        for (span, name) in visitor.flagged {
            ctx.report(ReportDiagnostic {
                span,
                message_id: Some("compatName".to_string()),
                message: format!(
                    "'{name}' declares a compatibility or retirement path. Delete the old path instead of keeping or naming it."
                ),
                fix: None,
            });
        }
    }
}

struct CompatNamesVisitor {
    flagged: Vec<(Span, String)>,
}

impl CompatNamesVisitor {
    fn check_ident(&mut self, name: &str, span: Span) {
        if is_compat_name(name) {
            self.flagged.push((span, name.to_string()));
        }
    }

    fn check_pattern(&mut self, pattern: &BindingPattern<'_>) {
        match pattern {
            BindingPattern::BindingIdentifier(id) => self.check_ident(id.name.as_str(), id.span),
            BindingPattern::AssignmentPattern(assign) => self.check_pattern(&assign.left),
            BindingPattern::ArrayPattern(arr) => {
                for elem in arr.elements.iter().flatten() {
                    self.check_pattern(elem);
                }
                if let Some(rest) = &arr.rest {
                    self.check_pattern(&rest.argument);
                }
            }
            BindingPattern::ObjectPattern(obj) => {
                for prop in &obj.properties {
                    self.check_pattern(&prop.value);
                }
                if let Some(rest) = &obj.rest {
                    self.check_pattern(&rest.argument);
                }
            }
        }
    }

    fn check_params(&mut self, params: &FormalParameters<'_>) {
        for param in &params.items {
            self.check_pattern(&param.pattern);
        }
        if let Some(rest) = &params.rest {
            self.check_pattern(&rest.rest.argument);
        }
    }

    fn check_key(&mut self, computed: bool, key: &PropertyKey<'_>) {
        if computed {
            return;
        }
        if let PropertyKey::StaticIdentifier(id) = key {
            self.check_ident(id.name.as_str(), id.span);
        }
    }
}

impl<'a> Visit<'a> for CompatNamesVisitor {
    fn visit_function(&mut self, it: &Function<'a>, flags: oxc::semantic::ScopeFlags) {
        if it.is_function_declaration()
            && let Some(id) = &it.id
        {
            self.check_ident(id.name.as_str(), id.span);
        }
        self.check_params(&it.params);
        walk::walk_function(self, it, flags);
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        self.check_params(&it.params);
        walk::walk_arrow_function_expression(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        self.check_pattern(&it.id);
        walk::walk_variable_declarator(self, it);
    }

    fn visit_class(&mut self, it: &Class<'a>) {
        if it.is_declaration()
            && let Some(id) = &it.id
        {
            self.check_ident(id.name.as_str(), id.span);
        }
        walk::walk_class(self, it);
    }

    fn visit_ts_interface_declaration(&mut self, it: &TSInterfaceDeclaration<'a>) {
        self.check_ident(it.id.name.as_str(), it.id.span);
        walk::walk_ts_interface_declaration(self, it);
    }

    fn visit_ts_type_alias_declaration(&mut self, it: &TSTypeAliasDeclaration<'a>) {
        self.check_ident(it.id.name.as_str(), it.id.span);
        walk::walk_ts_type_alias_declaration(self, it);
    }

    fn visit_method_definition(&mut self, it: &MethodDefinition<'a>) {
        self.check_key(it.computed, &it.key);
        walk::walk_method_definition(self, it);
    }

    fn visit_property_definition(&mut self, it: &PropertyDefinition<'a>) {
        self.check_key(it.computed, &it.key);
        walk::walk_property_definition(self, it);
    }

    fn visit_ts_property_signature(&mut self, it: &TSPropertySignature<'a>) {
        self.check_key(it.computed, &it.key);
        walk::walk_ts_property_signature(self, it);
    }
}

fn is_compat_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.contains("legacy")
        || lower.contains("deprecated")
        || lower.contains("retire")
        || lower.contains("nolonger")
        || lower.contains("no_longer")
    {
        return true;
    }
    let mut search_from = 0usize;
    while let Some(offset) = lower[search_from..].find("compat") {
        let abs = search_from + offset;
        if !lower[abs..].starts_with("compatible") {
            return true;
        }
        search_from = abs + 6;
    }
    false
}
