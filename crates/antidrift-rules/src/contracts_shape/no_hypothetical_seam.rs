use antidrift_kernel::callgraph::{CallSiteRecord, ProgramSymbolIndex};
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{provenance, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, Symbol};
use tsrs_checker::Checker;
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-hypothetical-seam";

const EFFECTFUL_NAMES: &[&str] = &[
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fetch",
    "setTimeout",
    "readFile",
    "readFileSync",
    "writeFile",
    "writeFileSync",
];

const EFFECTFUL_MEMBERS: &[(&str, &str)] = &[
    ("Date", "now"),
    ("performance", "now"),
    ("crypto", "randomUUID"),
    ("Math", "random"),
];

pub struct NoHypotheticalSeam {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoHypotheticalSeam = NoHypotheticalSeam {
    scope: RuleScope::DEFAULT,
};

impl NoHypotheticalSeam {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ClassDeclaration),
    Listener::Enter(Kind::InterfaceDeclaration),
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::Constructor),
];

impl Rule for NoHypotheticalSeam {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx)
            || !tsrs_kernel::is_authored_source_file(ctx.file)
            || provenance::is_package_entry_file(ctx.file.file_name())
        {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>) {
        match listener {
            Listener::Enter(Kind::ClassDeclaration) => {
                if ast::has_syntactic_modifier(node, ModifierFlags::Abstract) {
                    check_single_adapter_seam(ctx, node);
                }
            }
            Listener::Enter(Kind::InterfaceDeclaration) => check_single_adapter_seam(ctx, node),
            Listener::Enter(
                Kind::FunctionDeclaration | Kind::MethodDeclaration | Kind::Constructor,
            ) => {
                check_test_only_seams(ctx, node);
            }
            _ => {}
        }
    }
}

fn identifier_name(node: Option<P<Node>>) -> Option<(P<Node>, &'static str)> {
    node.filter(|name| ast::is_identifier(*name))
        .map(|name| (name, name.as_identifier().text()))
}

fn check_single_adapter_seam(ctx: &mut Ctx, node: P<Node>) {
    let Some((name_node, name)) = identifier_name(node.name()) else {
        return;
    };
    let Some(seam) = provenance::symbol_at_node(ctx.checker, name_node) else {
        return;
    };
    let index = ProgramSymbolIndex::for_program(ctx.program);
    let summary = index.adapter_counts_for_seam(ctx.checker, seam, name);
    if summary.has_class_implements && summary.prod_adapters == 1 && summary.test_adapters == 0 {
        ctx.report_node(
            name_node,
            RuleMessage::new(
                "singleAdapterSeam",
                format!(
                    "'{name}' is a seam with exactly one production adapter and no test adapter. Delete '{name}' and depend on the adapter directly until a second adapter exists."
                ),
            ),
        );
    }
}

enum SeamSlot {
    Positional,
    Property(&'static str),
}

struct DefaultedDependency {
    slot: SeamSlot,
    local: P<Node>,
    default_expr: P<Node>,
    is_parameter_property: bool,
}

fn defaulted_dependencies(param: P<Node>) -> Vec<DefaultedDependency> {
    let decl = param.as_parameter_declaration();
    let name = decl.name();
    if ast::is_identifier(name) {
        return decl
            .initializer()
            .map(|default_expr| DefaultedDependency {
                slot: SeamSlot::Positional,
                local: name,
                default_expr,
                is_parameter_property: ast::has_syntactic_modifier(
                    param,
                    ModifierFlags::ParameterPropertyModifier,
                ),
            })
            .into_iter()
            .collect();
    }
    if name.kind() != Kind::ObjectBindingPattern {
        return Vec::new();
    }
    let mut dependencies = Vec::new();
    for &element in name.as_binding_pattern().elements().nodes() {
        let binding = element.as_binding_element();
        let (Some(local), Some(default_expr)) = (binding.name(), binding.initializer()) else {
            continue;
        };
        let key_node = binding.property_name().unwrap_or(local);
        if let (true, Some(key)) = (
            ast::is_identifier(local),
            tsrs_kernel::property_name_text(key_node),
        ) {
            dependencies.push(DefaultedDependency {
                slot: SeamSlot::Property(key),
                local,
                default_expr,
                is_parameter_property: false,
            });
        }
    }
    dependencies
}

fn is_first_party_function_declaration(program: &Program, decl: P<Node>) -> bool {
    let Some(sf) = ast::get_source_file_of_node(decl) else {
        return false;
    };
    if tsrs_kernel::is_declaration_file(sf.file_name())
        || program.is_source_file_from_external_library(sf)
    {
        return false;
    }
    match decl.kind() {
        Kind::FunctionDeclaration => true,
        Kind::VariableDeclaration => {
            let is_module_scope = decl
                .parent()
                .and_then(|list| list.parent())
                .and_then(|stmt| stmt.parent())
                .is_some_and(ast::is_source_file);
            is_module_scope
                && tsrs_kernel::function_node_from_declaration(decl).is_some_and(|func| {
                    matches!(func.kind(), Kind::ArrowFunction | Kind::FunctionExpression)
                })
        }
        _ => false,
    }
}

fn is_effectful_default(ctx: &mut Ctx, default_expr: P<Node>) -> bool {
    let inner = tsrs_kernel::unwrap_expression(default_expr);
    if inner.kind() == Kind::PropertyAccessExpression {
        let Some((root, members)) = tsrs_kernel::static_member_chain(inner) else {
            return false;
        };
        let root_name = ast::is_identifier(root).then(|| root.as_identifier().text());
        return EFFECTFUL_MEMBERS
            .iter()
            .any(|&(owner, member)| root_name == Some(owner) && members == [member])
            || members
                .last()
                .is_some_and(|member| EFFECTFUL_NAMES.contains(member));
    }
    if !ast::is_identifier(inner) {
        return false;
    }
    let text = inner.as_identifier().text();
    if EFFECTFUL_NAMES.contains(&text) {
        return true;
    }
    if text.starts_with(|first: char| first.is_ascii_uppercase()) {
        return false;
    }
    let Some(symbol) = provenance::symbol_at_node(ctx.checker, inner) else {
        return false;
    };
    symbol
        .value_declaration()
        .is_some_and(|decl| is_first_party_function_declaration(ctx.program, decl))
}

fn is_this_field_assignment(ident: P<Node>) -> bool {
    let Some(parent) = ident.parent() else {
        return false;
    };
    if parent.kind() != Kind::BinaryExpression {
        return false;
    }
    let binary = parent.as_binary_expression();
    binary.right() == ident
        && binary.operator_token().kind() == Kind::EqualsToken
        && binary.left().kind() == Kind::PropertyAccessExpression
        && binary
            .left()
            .as_property_access_expression()
            .expression()
            .kind()
            == Kind::ThisKeyword
}

fn is_invoked(ident: P<Node>) -> bool {
    ident.parent().is_some_and(|parent| {
        parent.kind() == Kind::CallExpression && parent.as_call_expression().expression() == ident
    })
}

fn uses_dependency(
    checker: &mut Checker,
    node: P<Node>,
    local: P<Node>,
    local_symbol: P<Symbol>,
) -> bool {
    if ast::is_identifier(node)
        && node != local
        && node.as_identifier().text() == local.as_identifier().text()
        && checker.get_symbol_at_location_exported(node) == Some(local_symbol)
        && (is_invoked(node) || is_this_field_assignment(node))
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        found = uses_dependency(checker, child, local, local_symbol);
        found
    });
    found
}

fn call_overrides_slot(site: &CallSiteRecord, param_index: usize, slot: &SeamSlot) -> bool {
    let spread_before = site
        .arg_nodes
        .iter()
        .take(param_index + 1)
        .any(|arg| arg.kind() == Kind::SpreadElement);
    if spread_before {
        return true;
    }
    let Some(&arg) = site.arg_nodes.get(param_index) else {
        return false;
    };
    if tsrs_kernel::is_undefined_or_void_expression(Some(arg)) {
        return false;
    }
    let SeamSlot::Property(key) = slot else {
        return true;
    };
    let inner = tsrs_kernel::unwrap_expression(arg);
    if inner.kind() != Kind::ObjectLiteralExpression {
        return true;
    }
    inner
        .as_object_literal_expression()
        .properties()
        .nodes()
        .iter()
        .any(|&prop| {
            prop.kind() == Kind::SpreadAssignment
                || prop
                    .name()
                    .and_then(tsrs_kernel::property_name_text)
                    .is_some_and(|name| name == *key)
        })
}

struct SeamTarget {
    symbol: P<Symbol>,
    name: &'static str,
    call_kind: Kind,
}

fn seam_target(ctx: &mut Ctx, fn_node: P<Node>) -> Option<SeamTarget> {
    let (name_node, call_kind) = if fn_node.kind() == Kind::Constructor {
        (fn_node.parent()?.name(), Kind::NewExpression)
    } else {
        (fn_node.name(), Kind::CallExpression)
    };
    let (name_node, name) = identifier_name(name_node)?;
    let symbol = provenance::symbol_at_node(ctx.checker, name_node)?;
    Some(SeamTarget {
        symbol,
        name,
        call_kind,
    })
}

fn is_callee_reference(node: P<Node>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    let callee = if parent.kind() == Kind::PropertyAccessExpression
        && parent.as_property_access_expression().name() == node
    {
        parent
    } else {
        node
    };
    callee.parent().is_some_and(|call| match call.kind() {
        Kind::CallExpression => call.as_call_expression().expression() == callee,
        Kind::NewExpression => call.as_new_expression().expression() == callee,
        _ => false,
    })
}

fn has_opaque_reference(ctx: &mut Ctx, index: &ProgramSymbolIndex, target: &SeamTarget) -> bool {
    index
        .references_to_symbol(ctx.checker, target.symbol, target.name)
        .iter()
        .any(|reference| {
            let node = reference.node;
            let in_specifier = node.parent().is_some_and(|parent| {
                ast::is_import_specifier(parent) || ast::is_export_specifier(parent)
            });
            !is_callee_reference(node) && !in_specifier && !ast::is_part_of_type_node(node)
        })
}

fn check_test_only_seams(ctx: &mut Ctx, fn_node: P<Node>) {
    let Some(body) = fn_node.body() else {
        return;
    };
    let candidates: Vec<(usize, DefaultedDependency)> = fn_node
        .parameters()
        .iter()
        .enumerate()
        .flat_map(|(idx, &param)| {
            defaulted_dependencies(param)
                .into_iter()
                .map(move |dependency| (idx, dependency))
        })
        .collect();
    if candidates.is_empty() {
        return;
    }
    let Some(target) = seam_target(ctx, fn_node) else {
        return;
    };
    let index = ProgramSymbolIndex::for_program(ctx.program);
    if has_opaque_reference(ctx, &index, &target) {
        return;
    }
    let sites: Vec<&CallSiteRecord> = index
        .call_sites_for_symbol(ctx.checker, target.symbol, target.name)
        .into_iter()
        .filter(|site| site.call_node.kind() == target.call_kind)
        .collect();
    if sites.is_empty() {
        return;
    }
    for (param_index, dependency) in candidates {
        report_test_only_seam(ctx, body, &sites, param_index, &dependency);
    }
}

fn report_test_only_seam(
    ctx: &mut Ctx,
    body: P<Node>,
    sites: &[&CallSiteRecord],
    param_index: usize,
    dependency: &DefaultedDependency,
) {
    if !is_effectful_default(ctx, dependency.default_expr) {
        return;
    }
    let Some(local_symbol) = ctx
        .checker
        .get_symbol_at_location_exported(dependency.local)
    else {
        return;
    };
    if !dependency.is_parameter_property
        && !uses_dependency(ctx.checker, body, dependency.local, local_symbol)
    {
        return;
    }
    let overriding = sites
        .iter()
        .filter(|site| call_overrides_slot(site, param_index, &dependency.slot));
    let (prod, test) = overriding.fold((0usize, 0usize), |(prod, test), site| {
        if site.is_test_file {
            (prod, test + 1)
        } else {
            (prod + 1, test)
        }
    });
    if prod > 0 {
        return;
    }
    let local = dependency.local.as_identifier().text();
    let default_text = tsrs_kernel::node_text(ctx.file, dependency.default_expr);
    let detail = if test > 0 {
        format!("only {test} test call site(s) inject it")
    } else {
        "no call site injects it".to_owned()
    };
    ctx.report_node(
        dependency.local,
        RuleMessage::new(
            "testOnlySeam",
            format!(
                "'{local}' defaults to '{default_text}' and {detail}; no production caller supplies another implementation. Call '{default_text}' directly and delete the parameter."
            ),
        ),
    );
}
