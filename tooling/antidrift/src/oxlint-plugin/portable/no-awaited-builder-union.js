import { isRuleFile, scopeProperties } from "./scope.js";
import { getPropertyName } from "./ast.js";

const AWAIT_KEYWORD_LENGTH = "await".length;
const unwrapWrappers = (node) => {
  if (
    node?.type === "TSAsExpression" ||
    node?.type === "TSSatisfiesExpression" ||
    node?.type === "TSNonNullExpression" ||
    node?.type === "TSInstantiationExpression" ||
    node?.type === "ChainExpression"
  ) {
    return unwrapWrappers(node.expression);
  }
  return node ?? null;
};
const collectBranches = (node, branches) => {
  const expression = unwrapWrappers(node);
  if (expression?.type === "ConditionalExpression") {
    collectBranches(expression.consequent, branches);
    collectBranches(expression.alternate, branches);
    return branches;
  }
  branches.push(node);
  return branches;
};
const hasFixUnsafeWrapper = (node) => {
  const expression = unwrapWrappers(node);
  if (expression !== node) {
    return true;
  }
  if (expression?.type !== "ConditionalExpression") {
    return false;
  }
  return (
    hasFixUnsafeWrapper(expression.consequent) ||
    hasFixUnsafeWrapper(expression.alternate)
  );
};
const describeChain = (node) => {
  const steps = [];
  let current = unwrapWrappers(node);
  for (;;) {
    if (current === null) {
      return null;
    }
    if (current.type === "Identifier") {
      steps.reverse();
      return { root: current.name, steps };
    }
    if (current.type === "ThisExpression") {
      steps.reverse();
      return { root: "this", steps };
    }
    if (current.type === "MemberExpression") {
      const property = current.computed
        ? staticComputedKey(current.property)
        : getPropertyName(current.property);
      steps.push(property === null ? "[]" : `.${property}`);
      current = unwrapWrappers(current.object);
      continue;
    }
    if (current.type === "CallExpression") {
      steps.push("()");
      current = unwrapWrappers(current.callee);
      continue;
    }
    return null;
  }
};
const staticComputedKey = (property) => {
  const node = unwrapWrappers(property);
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0]?.value?.cooked ?? null;
  }
  return null;
};
const isStrictPrefix = (shorter, longer) =>
  shorter.length < longer.length &&
  shorter.every((step, index) => step === longer[index]);
const isBuilderChainUnion = (chains) =>
  chains.some((chain) =>
    chains.some(
      (other) =>
        isStrictPrefix(chain.steps, other.steps) ||
        isStrictPrefix(other.steps, chain.steps),
    ),
  );
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    fixable: "code",
    messages: {
      awaitedBuilderUnion:
        "Awaiting a ternary over two chain states of `{{root}}` makes " +
        "TypeScript instantiate both builder types and their union " +
        "before it can resolve `Awaited<>` over it, which is charged " +
        "against the typecheck-cost baseline. Await inside each branch " +
        "instead (`cond ? await {{root}}.chain() : await {{root}}`): the " +
        "condition is evaluated first either way, so the rewrite " +
        "preserves semantics and resolves one concrete type at a time.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      AwaitExpression(node) {
        const argument = unwrapWrappers(node.argument);
        if (argument?.type !== "ConditionalExpression") {
          return;
        }
        const chains = collectBranches(argument, []).map(describeChain);
        const first = chains.at(0);
        if (first === undefined || first === null) {
          return;
        }
        if (chains.some((chain) => chain === null)) {
          return;
        }
        if (chains.some((chain) => chain.root !== first.root)) {
          return;
        }
        if (!isBuilderChainUnion(chains)) {
          return;
        }
        if (node.argument.type !== "ConditionalExpression") {
          context.report({
            node,
            messageId: "awaitedBuilderUnion",
            data: { root: first.root },
          });
          return;
        }
        context.report({
          node,
          messageId: "awaitedBuilderUnion",
          data: { root: first.root },
          fix: (fixer) => {
            const awaitEnd = node.range[0] + AWAIT_KEYWORD_LENGTH;
            const branches = collectBranches(node.argument, []);
            if (hasFixUnsafeWrapper(node.argument)) {
              return null;
            }
            const hasInterveningComment = context.sourceCode
              .getAllComments()
              .some(
                (comment) =>
                  comment.range[0] >= awaitEnd &&
                  comment.range[0] < node.argument.range[0],
              );
            if (hasInterveningComment) {
              return null;
            }
            let removalEnd = awaitEnd;
            while (/\s/u.test(context.sourceCode.text.at(removalEnd) ?? "")) {
              removalEnd += 1;
            }
            return [
              fixer.removeRange([node.range[0], removalEnd]),
              ...branches.map((branch) =>
                fixer.insertTextBefore(branch, "await "),
              ),
            ];
          },
        });
      },
    };
  },
};
