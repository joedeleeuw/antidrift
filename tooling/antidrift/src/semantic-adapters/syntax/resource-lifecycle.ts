import { fieldOf, isSyntaxNode } from "../kernel/syntax-node.ts";
import type { Rule } from "eslint";
import {
  createReactStateTracker,
  frameStatePayload,
  lifecycleProof,
  sourceShardProof,
} from "../projection/react-state.ts";
import { emitSemanticFact } from "../../policy/lib/semantic-facts.mjs";

function sourceShardPayload(
  proof: Extract<
    ReturnType<typeof sourceShardProof>,
    {
      proven: true;
    }
  >
) {
  return {
    source: proof.source,
    members: proof.entries.map(({ setter, cell, property }) => ({
      setter,
      cell,
      property,
    })),
    editableCells: proof.editableCells,
    transition: Boolean(proof.transition),
    requestGuard: Boolean(proof.requestGuard),
  };
}
export const ruleNoHandrolledResourceLifecycleCells = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolled resource-lifecycle state machines: an async transition that toggles a boolean lifecycle cell, resets and assigns an error cell, and assigns an awaited resource cell. Broad multi-setter co-mutation and source-member state sharding are inventory only, never blocking.",
    },
    schema: [
      {
        type: "object",
        properties: {
          threshold: { type: "number" },
          shardThreshold: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context: Rule.RuleContext) {
    const options: unknown = context.options[0];
    const threshold = fieldOf(options, "threshold") ?? 3;
    const shardThreshold = fieldOf(options, "shardThreshold") ?? 2;
    if (typeof threshold !== "number" || typeof shardThreshold !== "number") {
      throw new TypeError("Resource-lifecycle thresholds must be numbers");
    }
    const tracker = createReactStateTracker({
      context,
      onFrameExit(frame) {
        if (!isSyntaxNode(frame.node)) {
          throw new TypeError("Resource lifecycle frame has no syntax node");
        }
        if (frame.setters.size > 0) {
          const shardProof = sourceShardProof(frame, {
            threshold: shardThreshold,
          });
          if (shardProof.proven) {
            emitSemanticFact(context, shardProof.node ?? frame.node, {
              factKind: "sourceMemberStateShardCandidate",
              ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
              adapterId: "react-state",
              confidence: "heuristic-inventory",
              provenance: ["AST", "scope-binding", "control-flow"],
              payload: sourceShardPayload(shardProof),
            });
          }
        }
        const proof = frame.isTransition
          ? lifecycleProof(frame)
          : { proven: false as const };
        if (proof.proven && !frame.requestGuard) {
          emitSemanticFact(context, frame.node, {
            factKind: "resourceLifecycleProof",
            ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
            adapterId: "react-state",
            confidence: "deterministic-enforcement",
            provenance: ["AST", "scope-binding", "control-flow"],
            payload: {
              boolCell: proof.boolCell,
              errorCell: proof.errorCell,
              payloadCell: proof.payloadCell,
              ...frameStatePayload(frame),
            },
          });
          context.report({
            node: frame.node,
            message:
              "This async transition hand-rolls a resource lifecycle: a constant lifecycle cell is toggled around the request while sibling cells receive the resource value and caught error. Model one resource/reducer value instead of coupled setters.",
          });
          return;
        }
        if (frame.called.size >= threshold) {
          emitSemanticFact(context, frame.node, {
            factKind: "broadSetterCoMutation",
            ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
            adapterId: "react-state",
            confidence: "heuristic-inventory",
            provenance: ["AST", "scope-binding"],
            payload: frameStatePayload(frame),
          });
        }
      },
    });
    return tracker.visitors;
  },
} satisfies Rule.RuleModule;
