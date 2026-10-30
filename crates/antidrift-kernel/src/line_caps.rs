use crate::diagnostic::Severity;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineCount {
    Physical,
    NonBlank,
}

impl LineCount {
    #[must_use]
    pub fn count(self, text: &str) -> usize {
        match self {
            Self::Physical => text.lines().count(),
            Self::NonBlank => text.lines().filter(|line| !line.trim().is_empty()).count(),
        }
    }

    const fn noun(self) -> &'static str {
        match self {
            Self::Physical => "lines",
            Self::NonBlank => "non-blank lines",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CappedUnit {
    RustFile,
    Module,
    Function,
    Component,
}

pub struct LineCap {
    pub rule_id: &'static str,
    pub count: LineCount,
    pub warn_above: usize,
    pub max: usize,
    split: &'static str,
}

impl CappedUnit {
    pub const ALL: [Self; 4] = [
        Self::RustFile,
        Self::Module,
        Self::Function,
        Self::Component,
    ];

    #[must_use]
    pub const fn cap(self) -> LineCap {
        match self {
            Self::RustFile => LineCap {
                rule_id: "rust/max-file-lines",
                count: LineCount::NonBlank,
                warn_above: 425,
                max: 500,
                split: "split along a domain seam",
            },
            Self::Module => LineCap {
                rule_id: "antidrift/max-module-lines",
                count: LineCount::Physical,
                warn_above: 1200,
                max: 1500,
                split: "split by owned responsibility",
            },
            Self::Function => LineCap {
                rule_id: "antidrift/max-function-lines",
                count: LineCount::Physical,
                warn_above: 40,
                max: 50,
                split: "split by responsibility rather than adding wrappers",
            },
            Self::Component => LineCap {
                rule_id: "antidrift/max-component-lines",
                count: LineCount::Physical,
                warn_above: 150,
                max: 180,
                split: "split container, view, and state or resource boundaries",
            },
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineCapTier {
    Near,
    Over,
}

impl LineCapTier {
    #[must_use]
    pub const fn message_id(self) -> &'static str {
        match self {
            Self::Near => "nearCap",
            Self::Over => "overCap",
        }
    }

    #[must_use]
    pub const fn severity(self) -> Severity {
        match self {
            Self::Near => Severity::Warn,
            Self::Over => Severity::Error,
        }
    }
}

pub struct LineCapFinding {
    pub tier: LineCapTier,
    pub message: String,
}

impl LineCap {
    #[must_use]
    pub fn judge(&self, subject: &str, text: &str) -> Option<LineCapFinding> {
        let lines = self.count.count(text);
        let noun = self.count.noun();
        let (max, warn_above, split) = (self.max, self.warn_above, self.split);
        if lines > max {
            return Some(LineCapFinding {
                tier: LineCapTier::Over,
                message: format!("{subject} has {lines} {noun} (max {max}); {split}."),
            });
        }
        (lines > warn_above).then(|| LineCapFinding {
            tier: LineCapTier::Near,
            message: format!(
                "{subject} has {lines} {noun} (warn threshold {warn_above}, max {max}); {split} before reaching the ceiling."
            ),
        })
    }
}

#[must_use]
pub fn tiered_severity(rule_id: &str, message_id: &str, configured: Severity) -> Severity {
    let is_line_cap = CappedUnit::ALL
        .iter()
        .any(|unit| unit.cap().rule_id == rule_id);
    if is_line_cap && message_id == LineCapTier::Near.message_id() {
        return configured.min(LineCapTier::Near.severity());
    }
    configured
}
