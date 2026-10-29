use std::cell::RefCell;
use std::rc::Rc;

use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, SourceFile, Symbol};
use tsrs_checker::Checker;
use tsrs_compiler::Program;
use tsrs_core::P;

use crate::{provenance, tsrs_kernel};

#[derive(Clone, Copy, Debug)]
pub struct IdentifierRef {
    pub file: P<SourceFile>,
    pub node: P<Node>,
    pub is_test_file: bool,
}

#[derive(Clone, Debug)]
pub struct CallSiteRecord {
    pub file: P<SourceFile>,
    pub call_node: P<Node>,
    pub callee_name_node: P<Node>,
    pub is_test_file: bool,
    pub arg_nodes: Vec<P<Node>>,
}

#[derive(Clone, Debug)]
struct HeritageRecord {
    declaration: P<Node>,
    binding_name: Option<P<Node>>,
    is_abstract: bool,
    is_interface: bool,
    is_test_file: bool,
    targets: Vec<P<Node>>,
}

#[derive(Clone, Copy, Debug)]
struct AnnotatedObjectLiteral {
    type_name: P<Node>,
    is_test_file: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SeamAdapterSummary {
    pub prod_adapters: usize,
    pub test_adapters: usize,
    pub has_class_implements: bool,
}

impl SeamAdapterSummary {
    const fn count(&mut self, is_test_file: bool) {
        if is_test_file {
            self.test_adapters += 1;
        } else {
            self.prod_adapters += 1;
        }
    }
}

#[derive(Default)]
pub struct ProgramSymbolIndex {
    identifiers: FxHashMap<&'static str, Vec<IdentifierRef>>,
    call_sites: FxHashMap<&'static str, Vec<CallSiteRecord>>,
    aliases: FxHashMap<&'static str, Vec<&'static str>>,
    heritage: Vec<HeritageRecord>,
    heritage_by_target: FxHashMap<&'static str, Vec<usize>>,
    annotated_objects: FxHashMap<&'static str, Vec<AnnotatedObjectLiteral>>,
}

type CacheKey = (usize, usize);

thread_local! {
    static INDEX_CACHE: RefCell<Option<(CacheKey, Rc<ProgramSymbolIndex>)>> = const { RefCell::new(None) };
}

struct FileScan<'a> {
    index: &'a mut ProgramSymbolIndex,
    file: P<SourceFile>,
    is_test_file: bool,
}

fn callee_name_node(callee: P<Node>) -> Option<P<Node>> {
    let inner = tsrs_kernel::unwrap_expression(callee);
    match inner.kind() {
        Kind::Identifier => Some(inner),
        Kind::PropertyAccessExpression => {
            let name = inner.as_property_access_expression().name();
            ast::is_identifier(name).then_some(name)
        }
        _ => None,
    }
}

fn rightmost_type_identifier(type_name: P<Node>) -> Option<P<Node>> {
    let identifier = if ast::is_qualified_name(type_name) {
        type_name.as_qualified_name().right()
    } else {
        type_name
    };
    ast::is_identifier(identifier).then_some(identifier)
}

fn class_binding_name(declaration: P<Node>) -> Option<P<Node>> {
    if let Some(name) = declaration.name() {
        return Some(name);
    }
    let parent = declaration.parent()?;
    (parent.kind() == Kind::VariableDeclaration)
        .then(|| parent.as_variable_declaration().name())
        .filter(|name| ast::is_identifier(*name))
}

fn heritage_target_identifier(type_node: P<Node>) -> Option<P<Node>> {
    let target = match type_node.kind() {
        Kind::ExpressionWithTypeArguments => {
            let inner = tsrs_kernel::unwrap_expression(
                type_node.as_expression_with_type_arguments().expression(),
            );
            if inner.kind() == Kind::PropertyAccessExpression {
                inner.as_property_access_expression().name()
            } else {
                inner
            }
        }
        Kind::TypeReference => {
            return rightmost_type_identifier(type_node.as_type_reference_node().type_name());
        }
        _ => return None,
    };
    ast::is_identifier(target).then_some(target)
}

fn heritage_targets(declaration: P<Node>) -> Vec<P<Node>> {
    let clauses = match declaration.kind() {
        Kind::ClassDeclaration => declaration.as_class_declaration().heritage_clauses(),
        Kind::ClassExpression => declaration.as_class_expression().heritage_clauses(),
        Kind::InterfaceDeclaration => declaration.as_interface_declaration().heritage_clauses(),
        _ => None,
    };
    let Some(clauses) = clauses else {
        return Vec::new();
    };
    clauses
        .nodes()
        .iter()
        .flat_map(|clause| clause.as_heritage_clause().types().nodes().iter())
        .filter_map(|&type_node| heritage_target_identifier(type_node))
        .collect()
}

fn object_literal_annotation(node: P<Node>) -> Option<P<Node>> {
    let mut current = node;
    while let Some(parent) = current.parent() {
        if parent.kind() != Kind::ParenthesizedExpression {
            break;
        }
        current = parent;
    }
    let parent = current.parent()?;
    let type_node = match parent.kind() {
        Kind::VariableDeclaration => {
            let decl = parent.as_variable_declaration();
            (decl.initializer() == Some(current))
                .then(|| decl.type_())
                .flatten()
        }
        Kind::AsExpression => Some(parent.as_as_expression().type_()),
        Kind::SatisfiesExpression => Some(parent.as_satisfies_expression().type_()),
        _ => None,
    }?;
    (type_node.kind() == Kind::TypeReference)
        .then(|| rightmost_type_identifier(type_node.as_type_reference_node().type_name()))
        .flatten()
}

impl FileScan<'_> {
    fn record_alias(&mut self, original: P<Node>, local: P<Node>) {
        let (Some(from), Some(to)) = (
            tsrs_kernel::property_name_text(original),
            tsrs_kernel::property_name_text(local),
        ) else {
            return;
        };
        if from != to {
            self.index.add_alias(from, to);
        }
    }

    fn record_default_export(&mut self, node: P<Node>) {
        if !ast::has_syntactic_modifier(node, ModifierFlags::Default) {
            return;
        }
        if let Some(name) = node.name().filter(|name| ast::is_identifier(*name)) {
            self.index.add_alias(name.as_identifier().text(), "default");
        }
    }

    fn record_call(&mut self, node: P<Node>, callee: P<Node>, arguments: &[P<Node>]) {
        let Some(name_node) = callee_name_node(callee) else {
            return;
        };
        self.index
            .call_sites
            .entry(name_node.as_identifier().text())
            .or_default()
            .push(CallSiteRecord {
                file: self.file,
                call_node: node,
                callee_name_node: name_node,
                is_test_file: self.is_test_file,
                arg_nodes: arguments.to_vec(),
            });
    }

    fn record_heritage(&mut self, node: P<Node>) {
        let targets = heritage_targets(node);
        if targets.is_empty() {
            return;
        }
        let record_idx = self.index.heritage.len();
        for &target in &targets {
            self.index
                .heritage_by_target
                .entry(target.as_identifier().text())
                .or_default()
                .push(record_idx);
        }
        self.index.heritage.push(HeritageRecord {
            declaration: node,
            binding_name: class_binding_name(node),
            is_abstract: ast::has_syntactic_modifier(node, ModifierFlags::Abstract),
            is_interface: node.kind() == Kind::InterfaceDeclaration,
            is_test_file: self.is_test_file,
            targets,
        });
    }

    fn record_object_literal(&mut self, node: P<Node>) {
        let Some(type_name) = object_literal_annotation(node) else {
            return;
        };
        self.index
            .annotated_objects
            .entry(type_name.as_identifier().text())
            .or_default()
            .push(AnnotatedObjectLiteral {
                type_name,
                is_test_file: self.is_test_file,
            });
    }

    fn record_node(&mut self, node: P<Node>) {
        match node.kind() {
            Kind::Identifier => self
                .index
                .identifiers
                .entry(node.as_identifier().text())
                .or_default()
                .push(IdentifierRef {
                    file: self.file,
                    node,
                    is_test_file: self.is_test_file,
                }),
            Kind::CallExpression => {
                let call = node.as_call_expression();
                self.record_call(node, call.expression(), call.arguments().nodes());
            }
            Kind::NewExpression => {
                let call = node.as_new_expression();
                let arguments = call.arguments().map_or(&[][..], |list| list.nodes());
                self.record_call(node, call.expression(), arguments);
            }
            Kind::ClassDeclaration | Kind::ClassExpression | Kind::InterfaceDeclaration => {
                self.record_heritage(node);
                self.record_default_export(node);
            }
            Kind::FunctionDeclaration => self.record_default_export(node),
            Kind::ObjectLiteralExpression => self.record_object_literal(node),
            Kind::ImportSpecifier => {
                let specifier = node.as_import_specifier();
                if let Some(original) = specifier.property_name() {
                    self.record_alias(original, specifier.name());
                }
            }
            Kind::ExportSpecifier => {
                let specifier = node.as_export_specifier();
                if let Some(original) = specifier.property_name() {
                    self.record_alias(original, specifier.name());
                }
            }
            Kind::ImportClause => {
                if let Some(local) = node.as_import_clause().name() {
                    self.index
                        .add_alias("default", local.as_identifier().text());
                }
            }
            Kind::ExportAssignment => {
                let expression = node.as_export_assignment().expression();
                if ast::is_identifier(expression) {
                    self.index
                        .add_alias(expression.as_identifier().text(), "default");
                }
            }
            _ => {}
        }
    }

    fn walk(&mut self, node: P<Node>) {
        self.record_node(node);
        node.for_each_child(&mut |child| {
            self.walk(child);
            false
        });
    }
}

impl ProgramSymbolIndex {
    pub fn for_program(program: &Program) -> Rc<Self> {
        let files = program.get_source_files();
        let key = (files.as_ptr().addr(), files.len());
        INDEX_CACHE.with(|cache| {
            if let Some((cached_key, index)) = cache.borrow().as_ref()
                && *cached_key == key
            {
                return Rc::clone(index);
            }
            let index = Rc::new(Self::build(program, files));
            *cache.borrow_mut() = Some((key, Rc::clone(&index)));
            index
        })
    }

    fn build(program: &Program, files: &[P<SourceFile>]) -> Self {
        let mut index = Self::default();
        for &sf in files {
            if tsrs_kernel::is_declaration_file(sf.file_name())
                || program.is_source_file_from_external_library(sf)
            {
                continue;
            }
            let mut scan = FileScan {
                index: &mut index,
                file: sf,
                is_test_file: tsrs_kernel::is_test_file(sf.file_name()),
            };
            scan.walk(sf.as_node());
        }
        index
    }

    fn add_alias(&mut self, from: &'static str, to: &'static str) {
        let locals = self.aliases.entry(from).or_default();
        if !locals.contains(&to) {
            locals.push(to);
        }
    }

    fn candidate_names(&self, name: &'static str) -> Vec<&'static str> {
        let mut names = vec![name];
        let mut seen: FxHashSet<&'static str> = FxHashSet::from_iter([name]);
        let mut cursor = 0;
        while let Some(&current) = names.get(cursor) {
            cursor += 1;
            let locals = self.aliases.get(current).map_or(&[][..], Vec::as_slice);
            names.extend(locals.iter().copied().filter(|local| seen.insert(local)));
        }
        names
    }

    fn candidates<'a, T>(
        &self,
        buckets: &'a FxHashMap<&'static str, Vec<T>>,
        name: &'static str,
    ) -> Vec<(&'static str, &'a T)> {
        self.candidate_names(name)
            .into_iter()
            .flat_map(|candidate| {
                buckets
                    .get(candidate)
                    .map_or(&[][..], Vec::as_slice)
                    .iter()
                    .map(move |entry| (candidate, entry))
            })
            .collect()
    }

    pub fn references_to_symbol(
        &self,
        checker: &mut Checker,
        target: P<Symbol>,
        name: &'static str,
    ) -> Vec<IdentifierRef> {
        let resolved = provenance::resolve_aliased_symbol(checker, target);
        self.candidates(&self.identifiers, name)
            .into_iter()
            .map(|(_, reference)| *reference)
            .filter(|reference| {
                let is_declaration_name = reference
                    .node
                    .parent()
                    .is_some_and(|parent| resolved.declarations().contains(&parent));
                !is_declaration_name
                    && provenance::symbol_at_node(checker, reference.node) == Some(resolved)
            })
            .collect()
    }

    pub fn call_sites_for_symbol(
        &self,
        checker: &mut Checker,
        target: P<Symbol>,
        name: &'static str,
    ) -> Vec<&CallSiteRecord> {
        let resolved = provenance::resolve_aliased_symbol(checker, target);
        self.candidates(&self.call_sites, name)
            .into_iter()
            .map(|(_, site)| site)
            .filter(|site| {
                provenance::symbol_at_node(checker, site.callee_name_node) == Some(resolved)
            })
            .collect()
    }

    pub fn adapter_counts_for_seam(
        &self,
        checker: &mut Checker,
        seam: P<Symbol>,
        seam_name: &'static str,
    ) -> SeamAdapterSummary {
        let resolved = provenance::resolve_aliased_symbol(checker, seam);
        let mut summary = SeamAdapterSummary::default();
        let mut visited = FxHashSet::default();
        self.walk_adapters(checker, resolved, seam_name, &mut visited, &mut summary);
        summary
    }

    fn heritage_records_for(
        &self,
        checker: &mut Checker,
        target: P<Symbol>,
        name: &'static str,
    ) -> Vec<&HeritageRecord> {
        let mut records: Vec<&HeritageRecord> = Vec::new();
        for (candidate, &record_idx) in self.candidates(&self.heritage_by_target, name) {
            let Some(record) = self.heritage.get(record_idx) else {
                continue;
            };
            let names_target = record.targets.iter().any(|&identifier| {
                identifier.as_identifier().text() == candidate
                    && provenance::symbol_at_node(checker, identifier) == Some(target)
            });
            if names_target
                && !records
                    .iter()
                    .any(|seen| seen.declaration == record.declaration)
            {
                records.push(record);
            }
        }
        records
    }

    fn walk_adapters(
        &self,
        checker: &mut Checker,
        target: P<Symbol>,
        name: &'static str,
        visited: &mut FxHashSet<P<Node>>,
        summary: &mut SeamAdapterSummary,
    ) -> bool {
        let mut has_adapters = false;
        for record in self.heritage_records_for(checker, target, name) {
            has_adapters = true;
            summary.has_class_implements |= !record.is_interface;
            if !visited.insert(record.declaration) {
                continue;
            }
            let sub_seam = record.binding_name.and_then(|binding| {
                let symbol = provenance::symbol_at_node(checker, binding)?;
                Some((symbol, tsrs_kernel::property_name_text(binding)?))
            });
            let has_subtypes = sub_seam.is_some_and(|(symbol, sub_name)| {
                self.walk_adapters(checker, symbol, sub_name, visited, summary)
            });
            if !record.is_interface && !record.is_abstract && !has_subtypes {
                summary.count(record.is_test_file);
            }
        }
        for (_, object) in self.candidates(&self.annotated_objects, name) {
            if provenance::symbol_at_node(checker, object.type_name) == Some(target) {
                has_adapters = true;
                summary.count(object.is_test_file);
            }
        }
        has_adapters
    }
}
