import { appendFileSync } from "node:fs";
import ts from "typescript";

import { isTestPath } from "../../oxlint-plugin/shared/test-files.js";
import { boundaryObservations } from "../../semantic-adapters/boundary/boundary-observations.ts";
import { RoundTripWidening } from "../../semantic-adapters/callgraph/round-trip-widening.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";
import { scopeProperties } from "../../semantic-adapters/kernel/rule-scope.ts";

const RECOVERY_KINDS = [
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.TypeAssertionExpression,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.ReturnStatement,
];

function observationSink() {
  const observationPath = process.env[boundaryObservations.envVar];
  return observationPath
    ? (observation) => {
        appendFileSync(observationPath, `${JSON.stringify(observation)}\n`);
      }
    : null;
}

export function ruleNoRoundTripWidening() {
  return defineTypeScriptRule({
    ruleName: "no-round-trip-widening",
    skipNonRuleFile: true,
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow a declared contract that drops part of a known type which code downstream then re-establishes.",
      },
      schema: [
        {
          type: "object",
          properties: scopeProperties,
          additionalProperties: false,
        },
      ],
      messages: {
        roundTrip:
          "`{{subject}}` is `{{producer}}`{{others}}, but `{{contract}}` drops {{difference}}; {{recovery}} re-establishes it.{{owner}}",
      },
    },
    run({ program, cwd, filename, reportNode }) {
      const analysis = new RoundTripWidening(program, {
        cwd,
        testFile: isTestPath(filename),
        observe: observationSink(),
      });
      const inspect = (node) => {
        analysis.inspect(node);
      };
      return {
        ...Object.fromEntries(RECOVERY_KINDS.map((kind) => [kind, inspect])),
        exit: {
          [ts.SyntaxKind.SourceFile]() {
            for (const finding of analysis.findings()) {
              reportNode(finding.anchor, {
                messageId: "roundTrip",
                data: finding.data,
              });
            }
          },
        },
      };
    },
  });
}
