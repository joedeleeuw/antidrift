pub mod bag_reshaper;
pub mod bag_state;
pub mod constant_return_field;
pub mod contract_projection;
pub mod inline_parse;
pub mod sum_erasure;

pub use bag_reshaper::{
    BagReshaperClassification, classify_bag_reshaper, collect_binding_pattern_symbols,
    collect_return_expressions_from_expression, collect_statement_return_expressions,
    resolve_bag_parameter,
};
pub use bag_state::{
    BagProjectionOptions, BagState, BagValueCheck, inspect_bag_value_expression,
    inspect_object_literal_bag_projection, inspect_object_literal_bag_projection_with_options,
    is_bag_member_chain, is_bag_object_reference, is_empty_object_fallback, is_nullish_expression,
    is_pure_bag_condition, is_static_scalar_literal,
};
pub use constant_return_field::{
    ConstantReturnFieldViolation, find_constant_return_field_violations,
};
pub use contract_projection::is_contract_appeasement_projection;
pub use inline_parse::{
    InlineParseReshapeClassification, InlineParseReshapeKind, classify_inline_parse_reshape,
};
pub use sum_erasure::{find_sum_to_product_erasure, outcome_arm};
