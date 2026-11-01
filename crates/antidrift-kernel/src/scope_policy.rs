use crate::file_role::{self, FileRole, ProjectPath, TEST_ROLES};
use serde::Serialize;

const HOST_PATH_EXEMPT_ROLES: &[FileRole] = &[
    FileRole::TestOrSpec,
    FileRole::TestSupport,
    FileRole::Example,
    FileRole::EndToEnd,
    FileRole::Story,
];

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScopePolicy {
    Everywhere,
    ExceptGenerated,
    AuthoredSource,
    NonExampleSource,
    NonScriptEntry,
    SharedOnly,
    TestFilesOnly,
}

impl ScopePolicy {
    #[must_use]
    pub fn admits(
        self,
        file_name: &str,
        source_text: &str,
        explicit_files: bool,
        project_path: impl FnOnce() -> ProjectPath,
    ) -> bool {
        match self {
            Self::Everywhere => true,
            Self::ExceptGenerated => {
                explicit_files || !file_role::is_generated_file(&project_path(), source_text)
            }
            Self::AuthoredSource => {
                if file_role::is_declaration_file(file_name) {
                    return false;
                }
                let path = project_path();
                !path.has_any_role(TEST_ROLES)
                    && (explicit_files || !file_role::is_generated_file(&path, source_text))
            }
            Self::NonExampleSource => {
                explicit_files || !project_path().has_any_role(HOST_PATH_EXEMPT_ROLES)
            }
            Self::NonScriptEntry => {
                explicit_files || !project_path().has_role(FileRole::ScriptEntry)
            }
            Self::SharedOnly => explicit_files || project_path().has_role(FileRole::Shared),
            Self::TestFilesOnly => {
                let path = project_path();
                matches!(path.as_str(), "" | "<input>" | "<text>")
                    || path.has_role(FileRole::TestOrSpec)
            }
        }
    }
}
