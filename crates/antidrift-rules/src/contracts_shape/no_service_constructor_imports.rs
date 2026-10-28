use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{boundary, provenance, tsrs_kernel};
use tsrs_ast::{Kind, Node, SourceFile, Symbol};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

const RULE_NAME: &str = "antidrift/no-service-constructor-imports";

pub struct NoServiceConstructorImports {
    scope: RuleScope,
}

pub static RULE: NoServiceConstructorImports = NoServiceConstructorImports {
    scope: RuleScope::DEFAULT,
};

impl NoServiceConstructorImports {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

struct ImportBinding {
    report_target: P<Node>,
    local_identifier: P<Node>,
}

fn build_service_constructor_import_message(
    module_specifier: &str,
    imported_name: &str,
) -> RuleMessage {
    RuleMessage::new(
        "serviceConstructorImport",
        format!(
            "Import the service tag or Layer from '{module_specifier}' instead of its raw constructor '{imported_name}'; resolve the service through the Effect context or wire '{imported_name}' inside a Layer."
        ),
    )
}

fn collect_named_import_bindings(named: P<Node>, bindings: &mut Vec<ImportBinding>) {
    if named.kind() != Kind::NamedImports {
        return;
    }
    for &elem in named.as_named_imports().elements().nodes() {
        if elem.kind() != Kind::ImportSpecifier {
            continue;
        }
        let spec = elem.as_import_specifier();
        if !spec.is_type_only() {
            bindings.push(ImportBinding {
                report_target: elem,
                local_identifier: spec.name(),
            });
        }
    }
}

fn collect_import_bindings(import_clause: Option<P<Node>>) -> Vec<ImportBinding> {
    let Some(clause_node) = import_clause else {
        return Vec::new();
    };
    if clause_node.kind() != Kind::ImportClause {
        return Vec::new();
    }
    let clause = clause_node.as_import_clause();
    if clause.phase_modifier() == Kind::TypeKeyword {
        return Vec::new();
    }
    let mut bindings = Vec::new();
    if let Some(name) = clause.name() {
        bindings.push(ImportBinding {
            report_target: name,
            local_identifier: name,
        });
    }
    if let Some(named) = clause.named_bindings() {
        collect_named_import_bindings(named, &mut bindings);
    }
    bindings
}

fn is_valid_service_target_file(ctx: &Ctx, target_file: P<SourceFile>) -> bool {
    if target_file == ctx.file || tsrs_kernel::is_declaration_file(target_file.file_name()) {
        return false;
    }
    let origin = provenance::classify_source_file_origin(ctx.program, target_file, Some(ctx.file));
    !matches!(
        origin,
        provenance::DeclarationOrigin::DefaultLib | provenance::DeclarationOrigin::NodeModules
    )
}

fn check_import_binding(
    ctx: &mut Ctx,
    import: P<Node>,
    module_text: &str,
    prov: &boundary::ServiceProvenance,
    binding: &ImportBinding,
) {
    if binding.local_identifier.kind() != Kind::Identifier {
        return;
    }
    let Some(raw_sym) = ctx
        .checker
        .get_symbol_at_location_exported(binding.local_identifier)
    else {
        return;
    };
    let target_sym = provenance::resolve_aliased_symbol(ctx.checker, raw_sym);
    if !prov.constructor_symbols.contains(&target_sym) {
        return;
    }
    if boundary::is_only_used_in_layer_construction(
        ctx.checker,
        ctx.file,
        Some(import),
        binding.local_identifier,
    ) {
        return;
    }
    let imported_name = binding.local_identifier.as_identifier().text();
    ctx.report_node(
        binding.report_target,
        build_service_constructor_import_message(module_text, imported_name),
    );
}

fn resolve_module_symbol(ctx: &mut Ctx, module_specifier: P<Node>) -> Option<P<Symbol>> {
    let raw = ctx
        .checker
        .get_symbol_at_location_exported(module_specifier)?;
    Some(provenance::resolve_aliased_symbol(ctx.checker, raw))
}

fn check_import_declaration(ctx: &mut Ctx, import: P<Node>) {
    if tsrs_kernel::is_test_file(ctx.file.file_name()) {
        return;
    }
    let import_decl = import.as_import_declaration();
    let module_specifier = import_decl.module_specifier();
    if module_specifier.kind() != Kind::StringLiteral {
        return;
    }
    let Some(target_file) = provenance::resolve_imported_source_file(ctx.checker, module_specifier)
    else {
        return;
    };
    if !is_valid_service_target_file(ctx, target_file) {
        return;
    }
    let module_symbol = resolve_module_symbol(ctx, module_specifier);
    let prov = boundary::service_contract_provenance(ctx.checker, module_symbol, target_file);
    if !prov.has_service_contract || prov.constructor_symbols.is_empty() {
        return;
    }
    let module_text = module_specifier.as_string_literal().text();
    for binding in collect_import_bindings(import_decl.import_clause()) {
        check_import_binding(ctx, import, module_text, &prov, &binding);
    }
}

impl Rule for NoServiceConstructorImports {
    fn name(&self) -> &'static str {
        "antidrift/no-service-constructor-imports"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

struct Visitor;

const LISTENERS: [Listener; 1] = [Listener::Enter(Kind::ImportDeclaration)];

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        &LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if node.kind() == Kind::ImportDeclaration {
            check_import_declaration(ctx, node);
        }
    }
}
