import { appendFileSync } from "node:fs";
import ts from "typescript";
import { boundaryModel } from "../../semantic-adapters/boundary/boundary-model.ts";
import { boundaryObservations } from "../../semantic-adapters/boundary/boundary-observations.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";
import { defensiveShapeProbe } from "../../semantic-adapters/boundary/shape-probe.js";

export default function ruleUnknownInputMustBeDecoded() {
  return defineTypeScriptRule({
    ruleName: "unknown-input-must-be-decoded",
    skipGenerated: false,
    meta: {
      type: "problem",
      docs: {
        description:
          "Require decoding before untrusted input reaches a cast, typed use, or repeated Object.entries shape probing.",
      },
      schema: [],
      messages: {
        decodeUnknown:
          "Untrusted input reaches a typed use without a dominating decode. Decode it at the receiving boundary.",
        incompleteAnalysis:
          "Untrusted input provenance could not be resolved ({{cause}}). Decode the value before typed use.",
        defensiveShapeProbe:
          "Do not unpack broad object shapes by probing property names inside Object.entries(...). Move the normalization to an owned schema or converter.",
      },
    },
    run({ program, cwd, reportNode, services, checker, sourceFile }) {
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
      function reportIncompleteMapping(node) {
        reportNode(node, {
          messageId: "incompleteAnalysis",
          data: {
            cause: "Object.entries shape probing requires ESTree mapping",
          },
        });
      }
      if (!services.tsNodeToESTreeNodeMap) {
        reportIncompleteMapping(sourceFile);
      }
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
          const forwardMap = services.tsNodeToESTreeNodeMap;
          const syntaxNode = forwardMap?.get(node);
          if (forwardMap && !syntaxNode) {
            reportIncompleteMapping(node);
          }
          const shapeProbe =
            syntaxNode && defensiveShapeProbe(syntaxNode, services, checker);
          if (shapeProbe?.status === "incomplete") {
            reportIncompleteMapping(node);
          }
          if (shapeProbe?.status === "report") {
            const tsCallback = services.esTreeNodeToTSNodeMap.get(
              shapeProbe.callback
            );
            if (tsCallback) {
              reportNode(tsCallback, { messageId: "defensiveShapeProbe" });
            } else {
              reportIncompleteMapping(node);
            }
          }
          reportRoots(node, model.uncheckedAt(node));
          callArguments(node);
        },
        [ts.SyntaxKind.NewExpression]: callArguments,
      };
    },
  });
}
