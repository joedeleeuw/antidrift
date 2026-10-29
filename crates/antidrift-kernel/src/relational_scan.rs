const OUTER_TRAVERSAL_METHODS: &[&str] = &[
    "map",
    "filter",
    "flatMap",
    "flat_map",
    "filter_map",
    "reduce",
    "forEach",
    "for_each",
];

const INNER_LINEAR_SCAN_METHODS: &[&str] = &[
    "find",
    "filter",
    "some",
    "every",
    "any",
    "position",
    "includes",
    "findIndex",
    "findLast",
];

#[must_use]
pub fn is_outer_traversal_method(method: &str) -> bool {
    OUTER_TRAVERSAL_METHODS.contains(&method)
}

#[must_use]
pub fn is_inner_linear_scan_method(method: &str) -> bool {
    INNER_LINEAR_SCAN_METHODS.contains(&method)
}

#[must_use]
pub fn is_cross_param_key_pair(
    left_root: Option<&str>,
    right_root: Option<&str>,
    outer_param: &str,
    inner_param: &str,
) -> bool {
    let (Some(left), Some(right)) = (left_root, right_root) else {
        return false;
    };
    outer_param != inner_param
        && ((left == outer_param && right == inner_param)
            || (left == inner_param && right == outer_param))
}
