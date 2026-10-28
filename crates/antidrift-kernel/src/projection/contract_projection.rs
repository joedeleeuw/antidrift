use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{
    self as ast, CaseOrDefaultClause, IfStatement, Kind, Node, SourceFile, SwitchStatement,
};
use tsrs_checker::{Checker, Type};
use tsrs_core::P;

use crate::{provenance, shape, tsrs_kernel};

type ConstraintMap = FxHashMap<String, FxHashSet<String>>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceBindingKind {
    Identity,
    Destructured,
    Member,
    Literal,
}

#[derive(Clone)]
struct SourceBinding {
    kind: SourceBindingKind,
    owner_names: FxHashSet<String>,
}

#[derive(Clone, Copy)]
enum ProjectionRecord {
    Source {
        kind: SourceBindingKind,
        typ: P<Type>,
    },
    Fallback,
    Unsupported,
}

struct EqualityConstraint {
    key: String,
    literal: String,
}

struct ProjectionWalker<'a> {
    bindings: FxHashMap<String, SourceBinding>,
    records: Vec<ProjectionRecord>,
    sf: P<SourceFile>,
    checker: &'a mut Checker,
}

fn collect_object_binding_pattern_for_projection(
    pattern: P<Node>,
    bindings: &mut FxHashMap<String, SourceBinding>,
    owner_names: &FxHashSet<String>,
) {
    if pattern.kind() != Kind::ObjectBindingPattern {
        return;
    }
    for &elem_node in pattern.as_binding_pattern().elements().nodes() {
        let elem = elem_node.as_binding_element();
        let Some(name_node) = elem.name() else {
            continue;
        };
        if ast::is_identifier(name_node) {
            bindings.insert(
                name_node.as_identifier().text().to_string(),
                SourceBinding {
                    kind: SourceBindingKind::Destructured,
                    owner_names: owner_names.clone(),
                },
            );
            continue;
        }
        if name_node.kind() == Kind::ObjectBindingPattern {
            collect_object_binding_pattern_for_projection(name_node, bindings, owner_names);
        }
    }
}

fn source_bindings_for_function(func: P<Node>) -> FxHashMap<String, SourceBinding> {
    let mut bindings = FxHashMap::default();
    for &param_node in func.parameters() {
        let param = param_node.as_parameter_declaration();
        let mut owner_names = FxHashSet::default();
        provenance::collect_type_owner_names(param.type_(), &mut owner_names);
        let name_node = param.name();
        if ast::is_identifier(name_node) {
            bindings.insert(
                name_node.as_identifier().text().to_string(),
                SourceBinding {
                    kind: SourceBindingKind::Identity,
                    owner_names,
                },
            );
            continue;
        }
        if name_node.kind() == Kind::ObjectBindingPattern {
            collect_object_binding_pattern_for_projection(name_node, &mut bindings, &owner_names);
        }
    }
    bindings
}

fn clone_constraint_map(input: &ConstraintMap, constraint: &EqualityConstraint) -> ConstraintMap {
    let mut out = input.clone();
    out.entry(constraint.key.clone())
        .or_default()
        .insert(constraint.literal.clone());
    out
}

fn matching_literal_projection(literal: &str, constraints: &ConstraintMap) -> bool {
    constraints
        .values()
        .any(|values| values.len() == 1 && values.contains(literal))
}

fn clause_constraints(
    clause: &CaseOrDefaultClause,
    disc: Option<&(String, FxHashSet<String>)>,
    constraints: &ConstraintMap,
) -> Option<ConstraintMap> {
    let (disc_key, disc_type_keys) = disc?;
    let clause_expr = clause.expression()?;
    let lit = tsrs_kernel::expression_literal_key(clause_expr)?;
    if !disc_type_keys.contains(&lit) {
        return None;
    }
    Some(clone_constraint_map(
        constraints,
        &EqualityConstraint {
            key: disc_key.clone(),
            literal: lit,
        },
    ))
}

impl ProjectionWalker<'_> {
    fn source_for_expression(&mut self, expr: P<Node>) -> Option<(SourceBindingKind, P<Type>)> {
        let unwrapped = tsrs_kernel::unwrap_expression(expr);
        if ast::is_identifier(unwrapped) {
            let binding = self.bindings.get(unwrapped.as_identifier().text())?;
            let kind = binding.kind;
            return Some((kind, self.checker.get_type_at_location(unwrapped)));
        }
        if !ast::is_property_access_expression(unwrapped)
            && !ast::is_element_access_expression(unwrapped)
        {
            return None;
        }
        if let Some(term_name) = tsrs_kernel::terminal_member_name(unwrapped)
            && (term_name == "length" || term_name == "size")
        {
            return None;
        }
        let root_name = tsrs_kernel::member_chain_root_identifier(unwrapped)?;
        if !self.bindings.contains_key(&root_name) {
            return None;
        }
        Some((
            SourceBindingKind::Member,
            self.checker.get_type_at_location(unwrapped),
        ))
    }

    fn equality_constraints_for_test(&mut self, test: P<Node>) -> Vec<EqualityConstraint> {
        let unwrapped = tsrs_kernel::unwrap_expression(test);
        if !ast::is_binary_expression(unwrapped) {
            return Vec::new();
        }
        let bin = unwrapped.as_binary_expression();
        let op_kind = bin.operator_token().kind();
        if op_kind == Kind::BarBarToken {
            let mut left = self.equality_constraints_for_test(bin.left());
            let right = self.equality_constraints_for_test(bin.right());
            left.extend(right);
            return left;
        }
        if !matches!(
            op_kind,
            Kind::EqualsEqualsEqualsToken | Kind::EqualsEqualsToken
        ) {
            return Vec::new();
        }
        let left_lit = tsrs_kernel::expression_literal_key(bin.left());
        let right_lit = tsrs_kernel::expression_literal_key(bin.right());
        let (source_expr, lit) = if let Some(lit) = left_lit {
            (bin.right(), lit)
        } else if let Some(lit) = right_lit {
            (bin.left(), lit)
        } else {
            return Vec::new();
        };
        let Some((_, src_type)) = self.source_for_expression(source_expr) else {
            return Vec::new();
        };
        let mut type_keys = FxHashSet::default();
        shape::type_literal_keys(src_type, &mut type_keys);
        if !type_keys.contains(&lit) {
            return Vec::new();
        }
        let key = tsrs_kernel::node_text(self.sf, tsrs_kernel::unwrap_expression(source_expr))
            .trim()
            .to_string();
        vec![EqualityConstraint { key, literal: lit }]
    }

    fn collect_from_conditional(
        &mut self,
        cond: &ast::ConditionalExpression,
        constraints: &ConstraintMap,
    ) {
        let next = self.equality_constraints_for_test(cond.condition());
        if next.is_empty() {
            self.collect_from_expr(Some(cond.when_true()), constraints);
        } else {
            for item in &next {
                let next_map = clone_constraint_map(constraints, item);
                self.collect_from_expr(Some(cond.when_true()), &next_map);
            }
        }
        self.collect_from_expr(Some(cond.when_false()), constraints);
    }

    fn collect_from_expr(&mut self, expr: Option<P<Node>>, constraints: &ConstraintMap) {
        let Some(raw_expr) = expr else {
            self.records.push(ProjectionRecord::Fallback);
            return;
        };
        let unwrapped = tsrs_kernel::unwrap_expression(raw_expr);
        if ast::is_conditional_expression(unwrapped) {
            self.collect_from_conditional(unwrapped.as_conditional_expression(), constraints);
            return;
        }
        if tsrs_kernel::is_undefined_or_void_expression(Some(unwrapped)) {
            self.records.push(ProjectionRecord::Fallback);
            return;
        }
        if let Some((kind, typ)) = self.source_for_expression(unwrapped) {
            self.records.push(ProjectionRecord::Source { kind, typ });
            return;
        }
        if let Some(lit) = tsrs_kernel::expression_literal_key(unwrapped)
            && matching_literal_projection(&lit, constraints)
        {
            self.records.push(ProjectionRecord::Source {
                kind: SourceBindingKind::Literal,
                typ: self.checker.get_type_at_location(unwrapped),
            });
            return;
        }
        self.records.push(ProjectionRecord::Unsupported);
    }

    fn collect_from_switch(&mut self, sw: &SwitchStatement, constraints: &ConstraintMap) {
        let disc = self
            .source_for_expression(sw.expression())
            .map(|(_, disc_type)| {
                let disc_key = tsrs_kernel::node_text(
                    self.sf,
                    tsrs_kernel::unwrap_expression(sw.expression()),
                )
                .trim()
                .to_string();
                let mut disc_type_keys = FxHashSet::default();
                shape::type_literal_keys(disc_type, &mut disc_type_keys);
                (disc_key, disc_type_keys)
            });
        for &clause_node in sw.case_block().as_case_block().clauses().nodes() {
            let clause = clause_node.as_case_or_default_clause();
            let next_owned = clause_constraints(clause, disc.as_ref(), constraints);
            let active_constraints = next_owned.as_ref().unwrap_or(constraints);
            for &child in clause.statements().nodes() {
                self.collect_from_stmt(child, active_constraints);
            }
        }
    }

    fn collect_from_if_stmt(&mut self, if_stmt: &IfStatement, constraints: &ConstraintMap) {
        let next = self.equality_constraints_for_test(if_stmt.expression());
        if next.is_empty() {
            self.collect_from_stmt(if_stmt.then_statement(), constraints);
        } else {
            for item in &next {
                let next_map = clone_constraint_map(constraints, item);
                self.collect_from_stmt(if_stmt.then_statement(), &next_map);
            }
        }
        if let Some(else_stmt) = if_stmt.else_statement() {
            self.collect_from_stmt(else_stmt, constraints);
        }
    }

    fn collect_from_stmt(&mut self, stmt: P<Node>, constraints: &ConstraintMap) {
        match stmt.kind() {
            Kind::ReturnStatement => {
                self.collect_from_expr(stmt.as_return_statement().expression(), constraints);
            }
            Kind::Block => {
                for &child in stmt.as_block().statements().nodes() {
                    self.collect_from_stmt(child, constraints);
                }
            }
            Kind::IfStatement => {
                self.collect_from_if_stmt(stmt.as_if_statement(), constraints);
            }
            Kind::SwitchStatement => {
                self.collect_from_switch(stmt.as_switch_statement(), constraints);
            }
            _ => {
                self.records.push(ProjectionRecord::Unsupported);
            }
        }
    }
}

fn disjoint_non_empty_sets(left: &FxHashSet<String>, right: &FxHashSet<String>) -> bool {
    !left.is_empty() && !right.is_empty() && left.is_disjoint(right)
}

fn filter_meaningful_records(
    records: &[ProjectionRecord],
) -> Option<Vec<(SourceBindingKind, P<Type>)>> {
    let mut meaningful = Vec::new();
    for &rec in records {
        match rec {
            ProjectionRecord::Fallback => {}
            ProjectionRecord::Unsupported => return None,
            ProjectionRecord::Source { kind, typ } => meaningful.push((kind, typ)),
        }
    }
    if meaningful.is_empty() {
        None
    } else {
        Some(meaningful)
    }
}

fn collect_source_owner_names(bindings: &FxHashMap<String, SourceBinding>) -> FxHashSet<String> {
    let mut source_owners = FxHashSet::default();
    bindings.values().for_each(|binding| {
        source_owners.extend(binding.owner_names.iter().cloned());
    });
    source_owners
}

pub fn is_contract_appeasement_projection(
    func: P<Node>,
    sf: P<SourceFile>,
    checker: &mut Checker,
) -> bool {
    let Some(return_type_node) = tsrs_kernel::function_return_type_node(func) else {
        return false;
    };
    let Some(body) = tsrs_kernel::function_body_node(func) else {
        return false;
    };
    if tsrs_kernel::contains_call_or_new(Some(body)) {
        return false;
    }
    let return_type = checker.get_type_from_type_node_exported(return_type_node);
    let bindings = source_bindings_for_function(func);
    if bindings.is_empty() {
        return false;
    }
    let source_owners = collect_source_owner_names(&bindings);
    let mut walker = ProjectionWalker {
        bindings,
        records: Vec::new(),
        sf,
        checker,
    };
    let constraints = FxHashMap::default();
    if ast::is_block(body) {
        walker.collect_from_stmt(body, &constraints);
    } else {
        walker.collect_from_expr(Some(body), &constraints);
    }
    let Some(meaningful) = filter_meaningful_records(&walker.records) else {
        return false;
    };
    let mut target_owners = FxHashSet::default();
    provenance::collect_type_owner_names(Some(return_type_node), &mut target_owners);
    if disjoint_non_empty_sets(&source_owners, &target_owners) {
        return true;
    }
    for (kind, typ) in meaningful {
        if kind == SourceBindingKind::Identity
            || !shape::same_type_ignoring_nullish(checker, typ, return_type)
        {
            return false;
        }
    }
    true
}
