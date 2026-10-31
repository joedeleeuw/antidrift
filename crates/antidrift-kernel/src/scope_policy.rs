use crate::file_role::{self, ProjectPath, TEST_ROLES};

#[derive(Clone, Copy)]
pub enum ScopePolicy {
    Everywhere,
    AuthoredSource,
    InferredRole(fn(&ProjectPath) -> bool),
    TestFilesOnly,
}

impl ScopePolicy {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Everywhere => "everywhere",
            Self::AuthoredSource => "authored-source",
            Self::InferredRole(_) => "inferred-role",
            Self::TestFilesOnly => "test-files-only",
        }
    }

    #[must_use]
    pub fn admits(
        self,
        path: &ProjectPath,
        file_name: &str,
        source_text: &str,
        explicit_files: bool,
    ) -> bool {
        match self {
            Self::Everywhere => true,
            Self::AuthoredSource => {
                !file_role::is_declaration_file(file_name)
                    && !path.has_any_role(TEST_ROLES)
                    && (explicit_files || !file_role::is_generated_file(path, source_text))
            }
            Self::InferredRole(predicate) => explicit_files || predicate(path),
            Self::TestFilesOnly => {
                matches!(path.as_str(), "" | "<input>" | "<text>")
                    || path.has_role(file_role::FileRole::TestOrSpec)
            }
        }
    }
}
