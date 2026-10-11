import { isRuleFile, scopeProperties } from "./scope.js";

const MIN_BRANCHES = 4;
const EQUALITY = new Set(["===", "=="]);

function isConstant(node) {
  return (
    node.type === "Literal" ||
    (node.type === "TemplateLiteral" && node.expressions.length === 0)
  );
}

function discriminants(test, sourceCode) {
  if (test.type === "LogicalExpression" && test.operator === "||") {
    const left = discriminants(test.left, sourceCode);
    const right = discriminants(test.right, sourceCode);
    return new Set([...left].filter((text) => right.has(text)));
  }
  if (test.type !== "BinaryExpression" || !EQUALITY.has(test.operator)) {
    return new Set();
  }
  return new Set(
    [test.left, test.right]
      .filter((side) => !isConstant(side))
      .map((side) => sourceCode.getText(side)),
  );
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow if/else-if chains of four or more branches over one discriminant.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      chain:
        "{{count}}-branch if/else-if chain over '{{discriminant}}'. Declare the case space first: a typed table checked with `satisfies`, a discriminated union, or an exhaustive switch.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const { sourceCode } = context;

    return {
      IfStatement(node) {
        if (node.parent.type === "IfStatement" && node.parent.alternate === node) {
          return;
        }
        let shared = discriminants(node.test, sourceCode);
        let count = 1;
        for (
          let branch = node.alternate;
          branch?.type === "IfStatement" && shared.size > 0;
          branch = branch.alternate
        ) {
          const branchDiscriminants = discriminants(branch.test, sourceCode);
          shared = new Set(
            [...shared].filter((text) => branchDiscriminants.has(text)),
          );
          count += 1;
        }
        if (count >= MIN_BRANCHES && shared.size > 0) {
          context.report({
            node,
            messageId: "chain",
            data: { count, discriminant: [...shared][0] },
          });
        }
      },
    };
  },
};
