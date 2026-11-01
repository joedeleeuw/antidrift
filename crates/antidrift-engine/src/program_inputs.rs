use rustc_hash::{FxHashMap, FxHashSet};

use crate::headless_host::BoundProgram;
use tsrs_ast::SourceFile;
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrs_vfs::osvfs;

fn project_sources(program: &Program) -> impl Iterator<Item = &P<SourceFile>> {
    program.source_files().iter().filter(|sf| {
        !program.is_lib_file(**sf) && !program.is_source_file_from_external_library(**sf)
    })
}

pub(crate) fn matches_inputs(
    program: &Program,
    overrides: Option<&FxHashMap<String, String>>,
) -> bool {
    let disk = osvfs::fs();
    project_sources(program).all(|sf| {
        if let Some(text) = overrides.and_then(|sources| sources.get(sf.file_name())) {
            return text == sf.text();
        }
        disk.read_file(sf.file_name())
            .is_some_and(|text| text == sf.text())
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileStamp {
    modified: std::time::SystemTime,
    len: u64,
}

impl FileStamp {
    fn read(file_name: &str) -> std::io::Result<Self> {
        let metadata = std::fs::metadata(file_name)?;
        Ok(Self {
            modified: metadata.modified()?,
            len: metadata.len(),
        })
    }
}

pub(crate) fn stamp_program_inputs(
    program: &Program,
) -> Result<FxHashMap<String, FileStamp>, String> {
    project_sources(program)
        .map(|sf| {
            let file_name = sf.file_name().to_owned();
            let stamp = FileStamp::read(&file_name)
                .map_err(|err| format!("could not stat program input {file_name}: {err}"))?;
            Ok((file_name, stamp))
        })
        .collect()
}

pub(crate) fn matches_stamps(
    program: &Program,
    stamps: &FxHashMap<String, FileStamp>,
    overrides: &FxHashMap<String, String>,
    disk_unchanged: bool,
) -> bool {
    project_sources(program).all(|sf| {
        if let Some(text) = overrides.get(sf.file_name()) {
            return text == sf.text();
        }
        disk_unchanged
            || FileStamp::read(sf.file_name())
                .is_ok_and(|current| stamps.get(sf.file_name()) == Some(&current))
    })
}

pub(crate) struct Batch {
    pub(crate) files: Vec<String>,
    pub(crate) bound: Option<BoundProgram>,
    pub(crate) stamps: FxHashMap<String, FileStamp>,
    pub(crate) validated_run: Option<String>,
    pub(crate) missing: Vec<String>,
    pub(crate) linted: FxHashSet<String>,
}

pub(crate) struct Family {
    pub(crate) configured: Vec<(String, Batch)>,
    pub(crate) inferred: Batch,
}

#[derive(Clone, Copy)]
pub(crate) enum Slot {
    Configured(usize),
    Inferred,
}

impl Batch {
    pub(crate) fn of(files: Vec<String>) -> Self {
        Self {
            files,
            bound: None,
            stamps: FxHashMap::default(),
            validated_run: None,
            missing: Vec::new(),
            linted: FxHashSet::default(),
        }
    }

    pub(crate) fn validated(&self, run_id: Option<&str>) -> bool {
        run_id.is_some() && self.validated_run.as_deref() == run_id
    }

    pub(crate) fn matches(
        &self,
        overrides: &FxHashMap<String, String>,
        run_id: Option<&str>,
    ) -> bool {
        self.bound.as_ref().is_none_or(|bound| {
            matches_stamps(
                bound.program,
                &self.stamps,
                overrides,
                self.validated(run_id),
            )
        })
    }

    pub(crate) fn bind(&mut self, bound: BoundProgram, run_id: Option<&str>) -> Result<(), String> {
        self.stamps = if run_id.is_some() {
            FxHashMap::default()
        } else {
            stamp_program_inputs(bound.program)?
        };
        self.bound = Some(bound);
        self.mark_validated(run_id);
        Ok(())
    }

    pub(crate) fn mark_validated(&mut self, run_id: Option<&str>) {
        if let Some(run_id) = run_id {
            self.validated_run = Some(run_id.to_owned());
        }
    }
}
