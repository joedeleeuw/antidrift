import { appendFileSync } from "node:fs";
import ts from "typescript";
import { boundaryModel } from "../../semantic-adapters/boundary-model.mjs";
import { boundaryObservations } from "../../semantic-adapters/boundary/boundary-observations.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

export default function ruleUnknownInputMustBeDecoded() {
  return defineTypeScriptRule({
    ruleName: "unknown-input-must-be-decoded",
    skipGenerated: false,
    meta: {
      type: "problem",
      docs: {
        description:
          "Require decoding before untrusted input reaches a cast or typed use.",
      },
      schema: [],
      messages: {
        decodeUnknown:
          "Untrusted input reaches a typed use without a dominating decode. Decode it at the receiving boundary.",
        incompleteAnalysis:
          "Untrusted input provenance could not be resolved ({{cause}}). Decode the value before typed use.",
      },
    },
    run({ program, cwd, reportNode }) {
      const observationPath = process.env[boundaryObservations.envVar];
      const observe = observationPath
        ? (observation) => {
            appendFileSync(observationPath, `${JSON.stringify(observation)}\n`);
          }
        : undefined;
      const model = boundaryModel(
        program,
        observe ? { observe, rootDirectory: cwd } : undefined
      );
      const reported = new Set();
      function reportRoots(node, roots) {
        if (reported.has(node) || !roots.length) return;
        reported.add(node);
        if (roots.some((root) => !root.incomplete)) {
          reportNode(node, { messageId: "decodeUnknown" });
          return;
        }
        reportNode(node, {
          messageId: "incompleteAnalysis",
          data: { cause: roots[0].incomplete },
        });
      }
      function sink(node) {
        reportRoots(node, model.uncheckedAt(node));
      }
      function callArguments(node) {
        for (const argument of node.arguments ?? []) {
          reportRoots(argument, model.uncheckedArgument(argument));
        }
      }
      return {
        [ts.SyntaxKind.AsExpression]: sink,
        [ts.SyntaxKind.TypeAssertionExpression]: sink,
        [ts.SyntaxKind.VariableDeclaration]: sink,
        [ts.SyntaxKind.BinaryExpression]: sink,
        [ts.SyntaxKind.ReturnStatement]: sink,
        [ts.SyntaxKind.CallExpression](node) {
          reportRoots(node, model.uncheckedAt(node));
          callArguments(node);
        },
        [ts.SyntaxKind.NewExpression]: callArguments,
      };
    },
  });
}
