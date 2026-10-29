use rustc_hash::FxHashSet;
use std::hash::Hash;

pub const INDEPENDENT_RUN_LENGTH: usize = 3;

const EFFECT_PREFIXES: &[&str] = &[
    "write", "update", "delete", "remove", "insert", "create", "mutate", "exec", "commit", "push",
    "set", "save", "checkout", "send", "submit", "dispatch", "emit", "publish", "post", "notify",
    "acquire", "reserve", "register", "start", "stop", "shutdown", "close", "flush", "apply",
    "ensure",
];

#[must_use]
pub fn is_effect_callee_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("lock")
        || EFFECT_PREFIXES
            .iter()
            .any(|prefix| lower.starts_with(prefix))
}

#[must_use]
pub fn is_discard_binding_name(name: &str) -> bool {
    name.starts_with('_')
}

pub struct IndependentAwaitRun<B> {
    bindings: FxHashSet<B>,
    length: usize,
}

impl<B> Default for IndependentAwaitRun<B> {
    fn default() -> Self {
        Self {
            bindings: FxHashSet::default(),
            length: 0,
        }
    }
}

impl<B: Hash + Eq> IndependentAwaitRun<B> {
    pub fn reset(&mut self) {
        self.bindings.clear();
        self.length = 0;
    }

    #[must_use]
    pub fn depends_on(&self, referenced: &B) -> bool {
        self.bindings.contains(referenced)
    }

    pub fn extend(&mut self, declared: Vec<B>, dependent: bool) -> bool {
        if declared.is_empty() {
            self.reset();
            return false;
        }
        if dependent {
            self.reset();
        }
        self.bindings.extend(declared);
        self.length += 1;
        self.length == INDEPENDENT_RUN_LENGTH
    }
}
