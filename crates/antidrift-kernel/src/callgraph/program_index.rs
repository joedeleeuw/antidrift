use std::cell::RefCell;
use std::rc::Rc;

use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{Node, SourceFile, Symbol};
use tsrs_checker::Checker;
use tsrs_compiler::Program;
use tsrs_core::P;

use super::file_scan::{AnnotatedObjectLiteral, FileScan, HeritageRecord};
use crate::{file_role, provenance, tsrs_kernel};

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
    pub(super) identifiers: FxHashMap<&'static str, Vec<IdentifierRef>>,
    pub(super) call_sites: FxHashMap<&'static str, Vec<CallSiteRecord>>,
    pub(super) aliases: FxHashMap<&'static str, Vec<&'static str>>,
    pub(super) heritage: Vec<HeritageRecord>,
    pub(super) heritage_by_target: FxHashMap<&'static str, Vec<usize>>,
    pub(super) annotated_objects: FxHashMap<&'static str, Vec<AnnotatedObjectLiteral>>,
}

type CacheKey = (usize, usize);

thread_local! {
    static INDEX_CACHE: RefCell<Option<(CacheKey, Rc<ProgramSymbolIndex>)>> = const { RefCell::new(None) };
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
            if file_role::is_declaration_file(sf.file_name())
                || program.is_source_file_from_external_library(sf)
            {
                continue;
            }
            let mut scan = FileScan {
                index: &mut index,
                file: sf,
                is_test_file: file_role::ProjectPath::of(program, sf.file_name())
                    .has_any_role(file_role::TEST_ROLES),
            };
            scan.walk(sf.as_node());
        }
        index
    }

    pub(super) fn add_alias(&mut self, from: &'static str, to: &'static str) {
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
