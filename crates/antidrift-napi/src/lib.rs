use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, OnceLock};

use antidrift_engine::session::{Finding, Session, rule_names};
use napi_derive::napi;
use rustc_hash::FxHashMap;

#[napi(object)]
pub struct EngineFinding {
    pub rule: String,
    pub message: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

struct LintRequest {
    cwd: String,
    file_path: String,
    reply: Sender<Result<Vec<Finding>, String>>,
}

static ENGINE: OnceLock<Mutex<Sender<LintRequest>>> = OnceLock::new();
static PROGRAMS_BUILT: AtomicU32 = AtomicU32::new(0);

fn serve(
    request: &LintRequest,
    sessions: &mut FxHashMap<String, Session>,
) -> Result<Vec<Finding>, String> {
    if !sessions.contains_key(&request.cwd) {
        sessions.insert(request.cwd.clone(), Session::new(&request.cwd)?);
    }
    let session = sessions
        .get_mut(&request.cwd)
        .ok_or_else(|| format!("no antidrift session for {}", request.cwd))?;
    let findings = session.lint_file(&request.file_path);
    let built: u32 = sessions.values().map(Session::programs_built).sum();
    PROGRAMS_BUILT.store(built, Ordering::SeqCst);
    findings
}

fn engine() -> napi::Result<&'static Mutex<Sender<LintRequest>>> {
    if let Some(engine) = ENGINE.get() {
        return Ok(engine);
    }
    let (sender, receiver) = channel::<LintRequest>();
    std::thread::Builder::new()
        .name("antidrift-engine".to_owned())
        .stack_size(512 << 20)
        .spawn(move || {
            let mut sessions: FxHashMap<String, Session> = FxHashMap::default();
            for request in receiver {
                let outcome = catch_unwind(AssertUnwindSafe(|| serve(&request, &mut sessions)))
                    .unwrap_or_else(|panic| Err(format!("antidrift engine panicked: {panic:?}")));
                if request.reply.send(outcome).is_err() {
                    break;
                }
            }
        })
        .map_err(|err| {
            napi::Error::from_reason(format!(
                "failed to start the antidrift engine thread: {err}"
            ))
        })?;
    Ok(ENGINE.get_or_init(|| Mutex::new(sender)))
}

#[napi]
pub fn lint_file(cwd: String, file_path: String) -> napi::Result<Vec<EngineFinding>> {
    let (reply, outcome) = channel();
    engine()?
        .lock()
        .map_err(|err| napi::Error::from_reason(format!("antidrift engine lock poisoned: {err}")))?
        .send(LintRequest {
            cwd,
            file_path,
            reply,
        })
        .map_err(|err| napi::Error::from_reason(format!("antidrift engine stopped: {err}")))?;
    let findings = outcome
        .recv()
        .map_err(|err| napi::Error::from_reason(format!("antidrift engine stopped: {err}")))?
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
#[must_use]
pub fn programs_built() -> u32 {
    PROGRAMS_BUILT.load(Ordering::SeqCst)
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
