pub mod delegation;
pub mod passthrough;

pub use delegation::{
    DelegatedCallCandidate, count_program_references_to_symbol, find_delegated_call,
};
pub use passthrough::{PassThroughParam, find_pass_through_parameters, is_named_function_node};
