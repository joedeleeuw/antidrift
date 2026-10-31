use std::collections::hash_map::Entry;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use rustc_hash::FxHashMap;
use tsrs_core::tspath;

use crate::headless::{HeadlessRequest, RelayReply};
use crate::headless_host::program_counts;
use crate::relay;
use crate::session::{Finding, Session};

enum EngineRequest {
    Lint {
        cwd: String,
        file_path: String,
        rules: Vec<String>,
        reply: Sender<Result<Vec<Finding>, String>>,
    },
    Headless {
        request: HeadlessRequest,
        reply: Sender<RelayReply>,
    },
}

pub struct EngineStats {
    pub programs_built: u32,
    pub programs_reused: u32,
    pub relayed_requests: u32,
}

pub struct EngineService {
    requests: Mutex<Sender<EngineRequest>>,
    relayed_requests: Arc<AtomicU32>,
    endpoint: Mutex<Option<String>>,
}

fn guarded<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(work))
        .unwrap_or_else(|panic| Err(format!("antidrift engine panicked: {panic:?}")))
}

fn session_for<'a>(
    sessions: &'a mut FxHashMap<String, Session>,
    cwd: &str,
) -> Result<&'a mut Session, String> {
    match sessions.entry(tspath::normalize_path(cwd)) {
        Entry::Occupied(entry) => Ok(entry.into_mut()),
        Entry::Vacant(entry) => {
            let opened = Session::new(entry.key())?;
            Ok(entry.insert(opened))
        }
    }
}

fn serve(receiver: &Receiver<EngineRequest>) {
    let mut sessions: FxHashMap<String, Session> = FxHashMap::default();
    for request in receiver {
        let delivered = match request {
            EngineRequest::Lint {
                cwd,
                file_path,
                rules,
                reply,
            } => reply
                .send(guarded(|| {
                    session_for(&mut sessions, &cwd)?.lint_file(&file_path, &rules)
                }))
                .is_ok(),
            EngineRequest::Headless { request, reply } => {
                let shared = sessions
                    .get(&tspath::normalize_path(&request.cwd))
                    .map(|session| &session.env);
                let answered = guarded(|| Ok(request.serve_cached(shared)));
                reply
                    .send(answered.unwrap_or_else(RelayReply::Failure))
                    .is_ok()
            }
        };
        if !delivered {
            break;
        }
    }
}

impl EngineService {
    pub fn start() -> Result<Self, String> {
        let (sender, receiver) = channel::<EngineRequest>();
        std::thread::Builder::new()
            .name("antidrift-engine".to_owned())
            .stack_size(512 << 20)
            .spawn(move || serve(&receiver))
            .map_err(|err| format!("failed to start the antidrift engine thread: {err}"))?;
        Ok(Self {
            requests: Mutex::new(sender),
            relayed_requests: Arc::new(AtomicU32::new(0)),
            endpoint: Mutex::new(None),
        })
    }

    fn sender(&self) -> Result<Sender<EngineRequest>, String> {
        self.requests
            .lock()
            .map(|requests| requests.clone())
            .map_err(|err| format!("antidrift engine lock poisoned: {err}"))
    }

    pub fn lint_file(
        &self,
        cwd: String,
        file_path: String,
        rules: Vec<String>,
    ) -> Result<Vec<Finding>, String> {
        let (reply, outcome) = channel();
        self.sender()?
            .send(EngineRequest::Lint {
                cwd,
                file_path,
                rules,
                reply,
            })
            .map_err(|err| format!("antidrift engine stopped: {err}"))?;
        outcome
            .recv()
            .map_err(|err| format!("antidrift engine stopped: {err}"))?
    }

    pub fn endpoint(&self) -> Result<String, String> {
        let mut endpoint = self
            .endpoint
            .lock()
            .map_err(|err| format!("antidrift engine relay lock poisoned: {err}"))?;
        if let Some(open) = endpoint.as_ref() {
            return Ok(open.clone());
        }
        let requests = self.sender()?;
        let relayed_requests = Arc::clone(&self.relayed_requests);
        let opened = relay::listen(move |request| {
            relayed_requests.fetch_add(1, Ordering::Relaxed);
            let (reply, outcome) = channel();
            if let Err(err) = requests.send(EngineRequest::Headless { request, reply }) {
                return RelayReply::Failure(format!("antidrift engine stopped: {err}"));
            }
            outcome.recv().unwrap_or_else(|err| {
                RelayReply::Failure(format!("antidrift engine stopped: {err}"))
            })
        })?;
        Ok(endpoint.insert(opened).clone())
    }

    #[must_use]
    pub fn stats(&self) -> EngineStats {
        let (programs_built, programs_reused) = program_counts();
        EngineStats {
            programs_built,
            programs_reused,
            relayed_requests: self.relayed_requests.load(Ordering::Relaxed),
        }
    }
}
