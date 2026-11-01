use rustc_hash::FxHashMap;
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
