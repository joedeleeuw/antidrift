use std::sync::OnceLock;

use antidrift_engine::service::EngineService;
use antidrift_engine::session::rule_names;
use napi_derive::napi;

#[napi(object)]
pub struct EngineFinding {
    pub rule: String,
    pub message: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[napi(object)]
pub struct EngineStats {
    pub programs_built: u32,
    pub programs_reused: u32,
    pub relayed_requests: u32,
}

static SERVICE: OnceLock<EngineService> = OnceLock::new();

fn service() -> napi::Result<&'static EngineService> {
    if let Some(service) = SERVICE.get() {
        return Ok(service);
    }
    let started = EngineService::start().map_err(napi::Error::from_reason)?;
    Ok(SERVICE.get_or_init(|| started))
}

#[napi]
pub fn lint_file(cwd: String, file_path: String) -> napi::Result<Vec<EngineFinding>> {
    let findings = service()?
        .lint_file(cwd, file_path)
        .map_err(napi::Error::from_reason)?;
    Ok(findings
        .into_iter()
        .map(|finding| EngineFinding {
            rule: finding.rule,
            message: finding.message,
            line: finding.location.line,
            column: finding.location.column,
            end_line: finding.location.end_line,
            end_column: finding.location.end_column,
        })
        .collect())
}

#[napi]
pub fn engine_endpoint() -> napi::Result<String> {
    service()?.endpoint().map_err(napi::Error::from_reason)
}

#[napi]
pub fn engine_stats() -> napi::Result<EngineStats> {
    let stats = service()?.stats();
    Ok(EngineStats {
        programs_built: stats.programs_built,
        programs_reused: stats.programs_reused,
        relayed_requests: stats.relayed_requests,
    })
}

#[napi(object)]
pub struct EngineRule {
    pub name: String,
}

#[napi]
#[must_use]
pub fn antidrift_rules() -> Vec<EngineRule> {
    rule_names()
        .into_iter()
        .map(|name| EngineRule { name })
        .collect()
}
