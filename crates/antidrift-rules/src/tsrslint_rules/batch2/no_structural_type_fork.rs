use antidrift_kernel::tsrs_kernel;
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{Kind, ModifierFlags, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor, options_object};

use super::structural_type_fork_helpers::{
    check_redundant_local_return, check_structural_fork_declaration, has_modifier,
};

#[derive(Clone, Copy)]
pub struct FieldBlockConfig {
    pub min_shared_fields: usize,
    pub min_shapes: usize,
    pub min_redundant_declarations: usize,
}

pub struct FieldEntry {
    pub key: String,
    pub display: String,
}

pub struct ShapeEntry {
    pub node: P<Node>,
    pub fields: Vec<FieldEntry>,
    pub keys: FxHashSet<String>,
}

pub struct NoStructuralTypeFork {
    field_blocks: FieldBlockConfig,
}

pub static RULE: NoStructuralTypeFork = NoStructuralTypeFork {
    field_blocks: FieldBlockConfig {
        min_shared_fields: 2,
        min_shapes: 2,
        min_redundant_declarations: 3,
    },
};

impl NoStructuralTypeFork {
    #[must_use]
    pub fn from_options(options: Option<&serde_json::Value>) -> Self {
        let opts = options_object(options);
        let fb = opts
            .get("fieldBlocks")
            .and_then(serde_json::Value::as_object);
        let read_usize = |key: &str, default: usize| -> usize {
            fb.and_then(|map| map.get(key))
                .and_then(serde_json::Value::as_u64)
                .map_or(default, |val| (val as usize).max(1))
        };
        Self {
            field_blocks: FieldBlockConfig {
                min_shared_fields: read_usize("minSharedFields", 2),
                min_shapes: read_usize("minShapes", 2),
                min_redundant_declarations: read_usize("minRedundantDeclarations", 3),
            },
        }
    }
}

fn normalize_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn build_field_block_message(fields: &str, shape_count: usize, redundant: usize) -> RuleMessage {
    RuleMessage::new(
        "duplicatedObjectFieldBlocks",
        format!(
            "Object shapes in this file repeat field block ({fields}) across {shape_count} declarations ({redundant} redundant field declarations); extract a shared base type or schema and compose with extends, intersection, or .merge()/.extend()."
        ),
    )
}

fn extract_ts_property_field(sf: P<SourceFile>, member: P<Node>) -> Option<FieldEntry> {
    if member.kind() != Kind::PropertySignature
        || has_modifier(member, ModifierFlags::Readonly | ModifierFlags::Static)
    {
        return None;
    }
    let prop = member.as_property_signature_declaration();
    let name_node = prop.name();
    let name = match name_node.kind() {
        Kind::Identifier => name_node.as_identifier().text(),
        Kind::StringLiteral => name_node.as_string_literal().text(),
        _ => return None,
    };
    let type_node = prop.type_()?;
    let optional = if prop.postfix_token().is_some() {
        "?"
    } else {
        ""
    };
    let type_text = normalize_ws(tsrs_kernel::node_text(sf, type_node));
    Some(FieldEntry {
        key: format!("{name}{optional}::ts::{type_text}"),
        display: format!("{name}{optional}"),
    })
}

fn collect_ts_shape(sf: P<SourceFile>, node: P<Node>, members: &[P<Node>]) -> Option<ShapeEntry> {
    let mut fields = Vec::with_capacity(members.len());
    let mut keys = FxHashSet::default();
    for &member in members {
        let entry = extract_ts_property_field(sf, member)?;
        if !keys.insert(entry.key.clone()) {
            return None;
        }
        fields.push(entry);
    }
    Some(ShapeEntry { node, fields, keys })
}

fn is_zod_object_callee(callee: P<Node>) -> bool {
    match callee.kind() {
        Kind::Identifier => callee.as_identifier().text() == "object",
        Kind::PropertyAccessExpression => {
            let prop = callee.as_property_access_expression();
            prop.expression().kind() == Kind::Identifier
                && prop.expression().as_identifier().text() == "z"
                && prop.name().kind() == Kind::Identifier
                && prop.name().as_identifier().text() == "object"
        }
        _ => false,
    }
}

fn extract_zod_property_field(sf: P<SourceFile>, prop: P<Node>) -> Option<FieldEntry> {
    if prop.kind() != Kind::PropertyAssignment {
        return None;
    }
    let pa = prop.as_property_assignment();
    let name = match pa.name().kind() {
        Kind::Identifier => pa.name().as_identifier().text(),
        Kind::StringLiteral => pa.name().as_string_literal().text(),
        _ => return None,
    };
    let val_text = normalize_ws(tsrs_kernel::node_text(sf, pa.initializer()));
    Some(FieldEntry {
        key: format!("{name}::zod::{val_text}"),
        display: name.to_owned(),
    })
}

fn collect_zod_shape(sf: P<SourceFile>, call_node: P<Node>) -> Option<ShapeEntry> {
    let parent = call_node.parent()?;
    if parent.kind() != Kind::VariableDeclaration {
        return None;
    }
    let call = call_node.as_call_expression();
    if !is_zod_object_callee(call.expression()) || call.arguments().nodes().len() != 1 {
        return None;
    }
    let arg0 = call.arguments().nodes()[0];
    if arg0.kind() != Kind::ObjectLiteralExpression {
        return None;
    }
    let props = arg0.as_object_literal_expression().properties().nodes();
    let mut fields = Vec::with_capacity(props.len());
    let mut keys = FxHashSet::default();
    for &prop in props {
        let entry = extract_zod_property_field(sf, prop)?;
        if !keys.insert(entry.key.clone()) {
            return None;
        }
        fields.push(entry);
    }
    Some(ShapeEntry {
        node: call_node,
        fields,
        keys,
    })
}

fn evaluate_pair_intersection(
    eligible: &[&ShapeEntry],
    left: &ShapeEntry,
    right: &ShapeEntry,
    cfg: FieldBlockConfig,
) -> Option<(usize, usize, usize, FxHashSet<String>)> {
    let shared: FxHashSet<String> = left.keys.intersection(&right.keys).cloned().collect();
    if shared.len() < cfg.min_shared_fields {
        return None;
    }
    let matching_count = eligible
        .iter()
        .filter(|s| shared.iter().all(|k| s.keys.contains(k)))
        .count();
    let redundant = (matching_count.saturating_sub(1)) * shared.len();
    if matching_count < cfg.min_shapes || redundant < cfg.min_redundant_declarations {
        return None;
    }
    Some((redundant, shared.len(), matching_count, shared))
}

fn find_best_field_block_cluster(
    eligible: &[&ShapeEntry],
    cfg: FieldBlockConfig,
) -> Option<(usize, usize, usize, FxHashSet<String>)> {
    let mut best: Option<(usize, usize, usize, FxHashSet<String>)> = None;
    for (idx, &left) in eligible.iter().enumerate() {
        for &right in &eligible[(idx + 1)..] {
            let Some(cand) = evaluate_pair_intersection(eligible, left, right, cfg) else {
                continue;
            };
            if best
                .as_ref()
                .is_none_or(|b| (cand.0, cand.1, cand.2) > (b.0, b.1, b.2))
            {
                best = Some(cand);
            }
        }
    }
    best
}

fn report_duplicated_field_blocks(ctx: &mut Ctx, shapes: &[ShapeEntry], cfg: FieldBlockConfig) {
    let eligible: Vec<&ShapeEntry> = shapes
        .iter()
        .filter(|s| s.fields.len() >= cfg.min_shared_fields)
        .collect();
    if eligible.len() < cfg.min_shapes {
        return;
    }
    let Some((redundant, _, matching_count, shared)) =
        find_best_field_block_cluster(&eligible, cfg)
    else {
        return;
    };
    let Some(first_shape) = eligible
        .iter()
        .find(|s| shared.iter().all(|k| s.keys.contains(k)))
    else {
        return;
    };
    let display_fields: Vec<&str> = first_shape
        .fields
        .iter()
        .filter(|f| shared.contains(&f.key))
        .map(|f| f.display.as_str())
        .collect();
    ctx.report_node(
        first_shape.node,
        build_field_block_message(&display_fields.join(", "), matching_count, redundant),
    );
}

impl Rule for NoStructuralTypeFork {
    fn name(&self) -> &'static str {
        "antidrift/no-structural-type-fork"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            field_blocks: self.field_blocks,
            shapes: Vec::new(),
            seen_type_literals: FxHashMap::default(),
        })
    }
}

struct Visitor {
    field_blocks: FieldBlockConfig,
    shapes: Vec<ShapeEntry>,
    seen_type_literals: FxHashMap<P<Node>, bool>,
}

fn is_valid_type_literal_parent(parent: P<Node>) -> bool {
    match parent.kind() {
        Kind::TypeAliasDeclaration => parent
            .as_type_alias_declaration()
            .type_parameters()
            .is_none_or(|tp| tp.nodes().is_empty()),
        Kind::InterfaceDeclaration | Kind::VariableDeclaration => true,
        _ => false,
    }
}

impl Visitor {
    fn record_interface_shape(&mut self, ctx: &Ctx, node: P<Node>) {
        let iface = node.as_interface_declaration();
        let has_type_params = iface
            .type_parameters()
            .is_some_and(|tp| !tp.nodes().is_empty());
        let has_heritage = iface
            .heritage_clauses()
            .is_some_and(|hc| !hc.nodes().is_empty());
        if !has_type_params
            && !has_heritage
            && let Some(shape) = collect_ts_shape(ctx.file, node, iface.members().nodes())
        {
            self.shapes.push(shape);
        }
    }

    fn record_type_literal_shape(&mut self, ctx: &Ctx, node: P<Node>) {
        if self.seen_type_literals.insert(node, true).is_some() {
            return;
        }
        let Some(parent) = node.parent() else {
            return;
        };
        if !is_valid_type_literal_parent(parent) {
            return;
        }
        let members = node.as_type_literal_node().members().nodes();
        if let Some(shape) = collect_ts_shape(ctx.file, node, members) {
            self.shapes.push(shape);
        }
    }
}

const LISTENERS: [Listener; 7] = [
    Listener::Enter(Kind::InterfaceDeclaration),
    Listener::Enter(Kind::TypeAliasDeclaration),
    Listener::Enter(Kind::TypeLiteral),
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Exit(Kind::EndOfFile),
];

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        &LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>) {
        if matches!(listener, Listener::Exit(Kind::EndOfFile)) {
            report_duplicated_field_blocks(ctx, &self.shapes, self.field_blocks);
            return;
        }
        match node.kind() {
            Kind::InterfaceDeclaration => {
                self.record_interface_shape(ctx, node);
                check_structural_fork_declaration(ctx, node);
            }
            Kind::TypeAliasDeclaration => {
                check_structural_fork_declaration(ctx, node);
            }
            Kind::TypeLiteral => {
                self.record_type_literal_shape(ctx, node);
            }
            Kind::CallExpression => {
                if let Some(shape) = collect_zod_shape(ctx.file, node) {
                    self.shapes.push(shape);
                }
            }
            Kind::FunctionDeclaration | Kind::VariableDeclaration => {
                check_redundant_local_return(ctx, node);
            }
            _ => {}
        }
    }
}
