const OUTCOME_FLAG_FIELDS: &[&str] = &[
    "ok",
    "success",
    "succeeded",
    "isOk",
    "isSuccess",
    "is_ok",
    "is_success",
];

const OUTCOME_ERROR_FIELDS: &[&str] = &[
    "error",
    "err",
    "errorMessage",
    "error_message",
    "failure",
    "reason",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutcomeArm {
    pub shape: String,
    pub flag: bool,
    pub error_present: bool,
}

#[must_use]
pub fn is_outcome_flag_field(name: &str) -> bool {
    OUTCOME_FLAG_FIELDS.contains(&name)
}

#[must_use]
pub fn is_outcome_error_field(name: &str) -> bool {
    OUTCOME_ERROR_FIELDS.contains(&name)
}

#[must_use]
pub fn outcome_shape_key<'a>(record: &str, fields: impl IntoIterator<Item = &'a str>) -> String {
    let mut names: Vec<&str> = fields.into_iter().collect();
    names.sort_unstable();
    names.dedup();
    format!("{record}{{{}}}", names.join(","))
}

#[must_use]
pub fn find_sum_to_product_pair(arms: &[OutcomeArm]) -> Option<(usize, usize)> {
    arms.iter().enumerate().find_map(|(ok_index, ok_arm)| {
        if !ok_arm.flag || ok_arm.error_present {
            return None;
        }
        arms.iter()
            .enumerate()
            .find(|(err_index, err_arm)| {
                *err_index != ok_index
                    && !err_arm.flag
                    && err_arm.error_present
                    && err_arm.shape == ok_arm.shape
            })
            .map(|(err_index, _)| (ok_index, err_index))
    })
}
