use super::abort_guards::AbortGuard;
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Node};
use tsrs_core::P;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum WriteClass {
    TrueConst,
    FalseConst,
    NullConst,
    Awaited,
    CaughtError,
}

pub(super) enum ArgumentClass {
    Updater,
    Other,
    Recorded(WriteClass),
}

#[derive(Default)]
pub(super) struct FrameCells {
    pub(super) setters: FxHashSet<&'static str>,
    pub(super) cell_of: FxHashMap<&'static str, &'static str>,
    pub(super) awaited_names: FxHashSet<&'static str>,
    pub(super) writes: Vec<(&'static str, FxHashSet<WriteClass>)>,
    pub(super) is_transition: bool,
    pub(super) source_member_setters: Vec<&'static str>,
    pub(super) catch_setters: Vec<&'static str>,
    pub(super) updater_setters: FxHashSet<&'static str>,
    pub(super) abort_controllers: FxHashSet<&'static str>,
    pub(super) abort_controller_refs: FxHashSet<&'static str>,
    pub(super) abort_guards: Vec<AbortGuard>,
    pub(super) abort_guarded_setters: FxHashSet<&'static str>,
}

pub(super) struct StateFrame {
    pub(super) node: P<Node>,
    pub(super) cells: FrameCells,
}

impl StateFrame {
    pub(super) fn new(node: P<Node>) -> Self {
        let mut cells = FrameCells::default();
        for &param in node.parameters() {
            let name = param.as_parameter_declaration().name();
            if ast::is_identifier(name) && matches!(name.as_identifier().text(), "set" | "setState")
            {
                cells.setters.insert(name.as_identifier().text());
            }
        }
        Self { node, cells }
    }

    pub(super) fn has_abort_controller(&self, name: &str) -> bool {
        self.cells.abort_controllers.contains(name)
    }

    pub(super) fn has_abort_controller_ref(&self, name: &str) -> bool {
        self.cells.abort_controller_refs.contains(name)
    }

    pub(super) fn record_write(&mut self, setter: &'static str, class: WriteClass) {
        if let Some((_, classes)) = self.cells.writes.iter_mut().find(|(n, _)| *n == setter) {
            classes.insert(class);
        } else {
            self.cells
                .writes
                .push((setter, FxHashSet::from_iter([class])));
        }
    }

    pub(super) fn merge_parent_writes(&mut self, parent: &Self) {
        if self.cells.catch_setters.is_empty()
            || !self
                .cells
                .writes
                .iter()
                .any(|(_, c)| c.contains(&WriteClass::FalseConst))
        {
            return;
        }
        for (setter, parent_classes) in &parent.cells.writes {
            if let Some((_, classes)) = self.cells.writes.iter_mut().find(|(n, _)| n == setter) {
                classes.extend(parent_classes.clone());
            } else {
                self.cells.writes.push((*setter, parent_classes.clone()));
            }
        }
    }

    pub(super) fn record_object_writes(
        &mut self,
        prop_writes: Vec<(&'static str, WriteClass)>,
        guarded: bool,
        in_catch: bool,
    ) {
        for (prop_name, write_class) in prop_writes {
            self.cells.setters.insert(prop_name);
            self.record_write(prop_name, write_class);
            if guarded {
                self.cells.abort_guarded_setters.insert(prop_name);
            }
            if in_catch
                && write_class == WriteClass::CaughtError
                && !self.cells.catch_setters.contains(&prop_name)
            {
                self.cells.catch_setters.push(prop_name);
            }
        }
    }

    pub(super) fn lifecycle_payload_cell(
        &self,
        owned: &FxHashSet<&'static str>,
    ) -> Option<&'static str> {
        if self
            .cells
            .updater_setters
            .iter()
            .any(|setter| owned.contains(setter))
        {
            return None;
        }
        let entries: Vec<&(&'static str, FxHashSet<WriteClass>)> = self
            .cells
            .writes
            .iter()
            .filter(|(setter, _)| owned.contains(setter))
            .collect();
        let bool_cell = entries.iter().find_map(|(setter, classes)| {
            (classes.contains(&WriteClass::TrueConst) && classes.contains(&WriteClass::FalseConst))
                .then_some(*setter)
        })?;
        let error_cell = self
            .cells
            .catch_setters
            .iter()
            .copied()
            .find(|name| *name != bool_cell && owned.contains(name))?;
        let blocked = [bool_cell, error_cell];
        entries
            .iter()
            .find_map(|(name, classes)| {
                (!blocked.contains(name) && classes.contains(&WriteClass::Awaited)).then_some(*name)
            })
            .or_else(|| {
                self.cells
                    .source_member_setters
                    .iter()
                    .copied()
                    .find(|setter| owned.contains(setter) && !blocked.contains(setter))
            })
    }
}
