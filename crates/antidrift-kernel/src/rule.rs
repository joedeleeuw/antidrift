use tsrs_ast::{Kind, Node, SourceFile};
use tsrs_checker::Checker;
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrslint::utils::trim_node_text_range;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Listener {
    Enter(Kind),
    Exit(Kind),
}

#[derive(Clone, Debug)]
pub struct RuleMessage {
    pub id: &'static str,
    pub description: String,
}

impl RuleMessage {
    #[must_use]
    pub fn new(id: &'static str, description: impl Into<String>) -> Self {
        Self {
            id,
            description: description.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixRange {
    pub pos: i32,
    pub end: i32,
    pub replacement: String,
}

#[derive(Clone, Debug)]
pub struct EmittedDiagnostic {
    pub pos: i32,
    pub end: i32,
    pub message: RuleMessage,
    pub fixes: Option<Vec<FixRange>>,
}

pub struct Ctx<'a> {
    pub checker: &'a mut Checker,
    pub program: &'static Program,
    pub file: P<SourceFile>,
    fix: bool,
    emitted: Vec<EmittedDiagnostic>,
}

impl<'a> Ctx<'a> {
    #[must_use]
    pub const fn new(
        checker: &'a mut Checker,
        program: &'static Program,
        file: P<SourceFile>,
        fix: bool,
    ) -> Self {
        Self {
            checker,
            program,
            file,
            fix,
            emitted: Vec::new(),
        }
    }

    #[must_use]
    pub fn trim(&self, node: P<Node>) -> (i32, i32) {
        trim_node_text_range(self.file, node)
    }

    pub fn report_range(&mut self, pos: i32, end: i32, message: RuleMessage) {
        self.emitted.push(EmittedDiagnostic {
            pos,
            end,
            message,
            fixes: None,
        });
    }

    pub fn report_node(&mut self, node: P<Node>, message: RuleMessage) {
        let (pos, end) = self.trim(node);
        self.report_range(pos, end, message);
    }

    pub fn report_node_with_fixes(
        &mut self,
        node: P<Node>,
        message: RuleMessage,
        fixes: impl FnOnce(&mut Self) -> Vec<FixRange>,
    ) {
        let (pos, end) = self.trim(node);
        let resolved = if self.fix { fixes(self) } else { Vec::new() };
        self.emitted.push(EmittedDiagnostic {
            pos,
            end,
            message,
            fixes: Some(resolved),
        });
    }

    #[must_use]
    pub fn fix_replace_range(&self, pos: i32, end: i32, text: impl Into<String>) -> FixRange {
        FixRange {
            pos,
            end,
            replacement: if self.fix { text.into() } else { String::new() },
        }
    }

    pub fn take_emitted(&mut self) -> Vec<EmittedDiagnostic> {
        std::mem::take(&mut self.emitted)
    }
}

pub trait RuleVisitor {
    fn listeners(&self) -> &[Listener];
    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>);
}

pub trait Rule: Send + Sync {
    fn name(&self) -> &'static str;
    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor>;
}

#[derive(Clone, Copy)]
pub struct RuleSpec {
    pub name: &'static str,
    pub listeners: &'static [Listener],
    pub visit: fn(&mut Ctx, Listener, P<Node>),
}

impl RuleSpec {
    #[must_use]
    pub const fn new(
        name: &'static str,
        listeners: &'static [Listener],
        visit: fn(&mut Ctx, Listener, P<Node>),
    ) -> Self {
        Self {
            name,
            listeners,
            visit,
        }
    }
}

impl Rule for RuleSpec {
    fn name(&self) -> &'static str {
        self.name
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if self.listeners.is_empty() {
            (self.visit)(ctx, Listener::Enter(Kind::SourceFile), ctx.file.as_node());
        }
        Box::new(*self)
    }
}

impl RuleVisitor for RuleSpec {
    fn listeners(&self) -> &[Listener] {
        self.listeners
    }

    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>) {
        (self.visit)(ctx, listener, node);
    }
}
