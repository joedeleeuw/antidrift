use rustc_hash::FxHashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ArtifactTier {
    DebugBuild,
    ReleaseBuild,
    StagedDist,
}

#[must_use]
pub fn classify_artifact_tier(path_text: &str) -> Option<ArtifactTier> {
    let normalized = path_text.replace('\\', "/").to_ascii_lowercase();
    if normalized.contains("target/debug")
        || normalized.contains("build/debug")
        || normalized.contains("/debug/")
    {
        return Some(ArtifactTier::DebugBuild);
    }
    if normalized.contains("target/release")
        || normalized.contains("build/release")
        || normalized.contains("/release/")
    {
        return Some(ArtifactTier::ReleaseBuild);
    }
    if normalized.contains("dist/bin")
        || normalized.contains("/bin/")
        || normalized.starts_with("bin/")
        || normalized.contains("dist/")
        || normalized.contains("artifacts/")
    {
        return Some(ArtifactTier::StagedDist);
    }
    None
}

pub fn spans_multiple_artifact_tiers<'a>(candidates: impl IntoIterator<Item = &'a str>) -> bool {
    let mut tiers = FxHashSet::default();
    for candidate in candidates {
        if let Some(tier) = classify_artifact_tier(candidate) {
            tiers.insert(tier);
            if tiers.len() >= 2 {
                return true;
            }
        }
    }
    false
}

#[must_use]
pub fn has_mtime_ordering_text(scope_text: &str) -> bool {
    scope_text.contains("mtime")
        || scope_text.contains("modified(")
        || scope_text.contains("statSync")
        || scope_text.contains("lstatSync")
}

#[must_use]
pub fn has_hold_open_resource(text: &str) -> bool {
    ((text.contains("fcntl.flock") || text.contains("socket.bind")) && text.contains("time.sleep"))
        || (text.contains("socket.socket(")
            && text.contains(".bind(")
            && text.contains("while True:"))
}

#[must_use]
pub fn is_inline_hold_open_script(text: &str) -> bool {
    let has_ready_signal = text.contains("print(")
        || text.contains("stdout.write")
        || text.contains("console.log(")
        || has_hold_open_resource(text);
    let has_hold_open_timer =
        text.contains("time.sleep(") || text.contains("setInterval(") || text.contains("\nsleep ");
    if has_ready_signal && has_hold_open_timer && !text.contains("stdin") {
        return true;
    }
    text.contains("socket.socket(") && text.contains(".bind(") && text.contains("while True:")
}

#[must_use]
pub fn is_script_binding_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "script", "cmd", "command", "code", "holder", "listener", "occupant",
    ]
    .iter()
    .any(|part| lower.contains(part))
}
