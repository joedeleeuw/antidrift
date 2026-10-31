use super::syn_kernel::is_banned_test_attribute;
use antidrift_kernel::file_role::{ProjectPath, is_generated_file};
use proc_macro2::Span;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Attribute, Fields, ImplItemFn, Item, ItemFn, ItemMod};

pub(super) struct SourceContext {
    pub(super) generated: bool,
    pub(super) test_file: bool,
    test_lines: Vec<(usize, usize)>,
}

impl SourceContext {
    pub(super) fn new(rel_path: &str, source: &str, ast: Option<&syn::File>) -> Self {
        let generated = is_generated_file(&ProjectPath::from_relative(rel_path), source);
        let mut test_lines = Vec::new();
        if let Some(ast) = ast {
            let mut collector = TestSpanCollector {
                lines: &mut test_lines,
            };
            collector.visit_file(ast);
        }
        Self {
            generated,
            test_file: false,
            test_lines,
        }
    }

    pub(super) fn in_test_code(&self, line: usize) -> bool {
        self.test_file
            || self
                .test_lines
                .iter()
                .any(|(start, end)| (*start..=*end).contains(&line))
    }
}

struct TestSpanCollector<'a> {
    lines: &'a mut Vec<(usize, usize)>,
}

impl TestSpanCollector<'_> {
    fn record(&mut self, attrs: &[Attribute], start: Span, end: Span) {
        if attrs.iter().any(is_banned_test_attribute) {
            self.lines
                .push((start.start().line.max(1), end.end().line.max(1)));
        }
    }
}

impl<'ast> Visit<'ast> for TestSpanCollector<'_> {
    fn visit_item(&mut self, node: &'ast Item) {
        let (attrs, start, end) = match node {
            Item::Mod(ItemMod {
                attrs,
                content: Some((brace, _)),
                ..
            }) => (attrs, node.span(), brace.span.join()),
            Item::Fn(ItemFn { attrs, block, .. }) => {
                (attrs, node.span(), block.brace_token.span.join())
            }
            Item::Impl(item_impl) => (
                &item_impl.attrs,
                node.span(),
                item_impl.brace_token.span.join(),
            ),
            Item::Struct(item_struct) => (
                &item_struct.attrs,
                node.span(),
                fields_end(&item_struct.fields).unwrap_or_else(|| node.span()),
            ),
            Item::Enum(item_enum) => (
                &item_enum.attrs,
                node.span(),
                item_enum.brace_token.span.join(),
            ),
            Item::Trait(item_trait) => (
                &item_trait.attrs,
                node.span(),
                item_trait.brace_token.span.join(),
            ),
            Item::Macro(item_macro) => (
                &item_macro.attrs,
                node.span(),
                item_macro.mac.delimiter.span().join(),
            ),
            Item::Use(item_use) => (&item_use.attrs, node.span(), node.span()),
            Item::Const(item_const) => (&item_const.attrs, node.span(), item_const.expr.span()),
            Item::Static(item_static) => (&item_static.attrs, node.span(), item_static.expr.span()),
            _ => {
                visit::visit_item(self, node);
                return;
            }
        };
        self.record(attrs, start, end);
        visit::visit_item(self, node);
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        self.record(&node.attrs, node.span(), node.block.brace_token.span.join());
        visit::visit_impl_item_fn(self, node);
    }
}

fn fields_end(fields: &Fields) -> Option<Span> {
    match fields {
        Fields::Named(named) => Some(named.brace_token.span.join()),
        Fields::Unnamed(unnamed) => Some(unnamed.paren_token.span.join()),
        Fields::Unit => None,
    }
}
