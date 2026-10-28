pub mod bag_reshaper;
pub mod bag_state;
pub mod contract_projection;
pub mod inline_parse;

pub use bag_reshaper::{
    BagReshaperClassification, classify_bag_reshaper, collect_return_expressions_from_expression,
    collect_statement_return_expressions,
};
pub use bag_state::{
    BagState, BagValueCheck, collect_binding_pattern_symbols, inspect_bag_value_expression,
    inspect_object_literal_bag_projection, is_bag_member_chain, is_bag_object_reference,
    is_empty_object_fallback, is_nullish_expression, is_pure_bag_condition,
    is_static_scalar_literal, resolve_bag_parameter,
};
pub use contract_projection::is_contract_appeasement_projection;
pub use inline_parse::{
    InlineParseReshapeClassification, InlineParseReshapeKind, classify_inline_parse_reshape,
};
