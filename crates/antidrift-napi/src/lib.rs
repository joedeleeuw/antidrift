use std::sync::OnceLock;

use antidrift_engine::rule_catalog::{RuleRequest, rule_listing};
use antidrift_engine::service::EngineService;
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

#[napi(object)]
pub struct EngineRuleRequest {
    pub rule: String,
    pub options: Option<String>,
}

#[napi]
pub fn lint_file(
    cwd: String,
    file_path: String,
    rules: Vec<EngineRuleRequest>,
) -> napi::Result<Vec<EngineFinding>> {
    let requests = rules
        .into_iter()
        .map(|request| RuleRequest {
            name: request.rule,
            options: request.options,
        })
        .collect();
    let findings = service()?
        .lint_file(cwd, file_path, requests)
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
    pub default_enabled: bool,
}

#[napi]
#[must_use]
pub fn antidrift_rules() -> Vec<EngineRule> {
    rule_listing()
        .into_iter()
        .map(|(name, default_enabled)| EngineRule {
            name,
            default_enabled,
        })
        .collect()
}
