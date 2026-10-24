export const templateSentinelSelectors = [
  {
    selector:
      'LogicalExpression[operator="??"][right.type="TemplateLiteral"][right.expressions.length=0][right.quasis.0.value.cooked=/^(?:unknown|n\\/a|none|unavailable|error|missing)$/i]:matches([left.type="MemberExpression"], [left.type="ChainExpression"][left.expression.type="MemberExpression"], [left.type="TSAsExpression"][left.expression.type="MemberExpression"], [left.type="TSSatisfiesExpression"][left.expression.type="MemberExpression"], [left.type="TSNonNullExpression"][left.expression.type="MemberExpression"], [left.type="TSTypeAssertion"][left.expression.type="MemberExpression"])',
    message:
      "This fallback hides a missing member behind a sentinel. Keep the missing value distinct from a reported value.",
  },
];
