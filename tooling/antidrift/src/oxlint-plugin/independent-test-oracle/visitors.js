import {
  collectBlockFacts,
  enclosingTestBlockCallback,
  isMembershipAssertionNode,
  parseAssertAssertion,
  parseExpectAssertion,
  testBlockCallback,
} from "../shared/test-block-arrangement.js";
import { contextFilename, isTestFilename } from "../shared/test-files.js";
import {
  analyzeTestBlock,
  classifyErrorShapeAssertion,
} from "./assertion-analysis.js";
import { isStaticPropertyEcho } from "./static-property-loop.js";
import { validatorOutputOracleFinding } from "./validator-output.js";

export function createIndependentTestOracleListeners(context) {
  const filename = contextFilename(context);
  if (!isTestFilename(filename)) {
    return {
      ForOfStatement(node) {
        if (isStaticPropertyEcho(node, context.sourceCode, filename)) {
          context.report({ node, messageId: "staticPropertyEcho" });
        }
      },
    };
  }
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  const factsByCallback = new WeakMap();
  const blockFacts = (callback) => {
    let facts = factsByCallback.get(callback);
    if (!facts) {
      facts = collectBlockFacts(callback, sourceCode);
      factsByCallback.set(callback, facts);
    }
    return facts;
  };
  return {
    CallExpression(node) {
      const validatorMessage = validatorOutputOracleFinding(node, sourceCode);
      if (validatorMessage) {
        context.report({ node, messageId: validatorMessage });
      }
      if (isMembershipAssertionNode(node)) {
        const callback = enclosingTestBlockCallback(node);
        const record = parseExpectAssertion(node) ?? parseAssertAssertion(node);
        if (
          callback &&
          record &&
          classifyErrorShapeAssertion(record, blockFacts(callback))
        ) {
          return;
        }
        context.report({ node, messageId: "noBareMembership" });
        return;
      }
      const callback = testBlockCallback(node);
      if (callback) {
        analyzeTestBlock(blockFacts(callback), context, sourceCode);
      }
    },
    ForOfStatement(node) {
      if (isStaticPropertyEcho(node, sourceCode, filename)) {
        context.report({ node, messageId: "staticPropertyEcho" });
      }
    },
  };
}
