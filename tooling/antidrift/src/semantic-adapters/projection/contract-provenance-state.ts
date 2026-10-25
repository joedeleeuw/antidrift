import type ts from "typescript";

import type { createRelevantTypeIndex } from "./relevant-contracts.ts";
import type { OwnerProjectionIndex } from "./owner-projection.ts";
import type { ProjectionProof } from "./owner-projection-proof.ts";
import type { DiscriminantBridge } from "./value-bridge.ts";

export type ContractProvenanceSearch = {
  readonly checker: ts.TypeChecker;
  readonly owners: OwnerProjectionIndex;
  readonly relevant: ReturnType<typeof createRelevantTypeIndex>;
  readonly comparisons: Map<ts.Symbol, Map<ts.Symbol, boolean>>;
  readonly copies: Map<ts.Type, Map<string, Set<ts.Type>>>;
  readonly bridges: Map<ts.Symbol, DiscriminantBridge[]>;
  readonly findings: Map<ts.Node, ProjectionProof[]>;
  readonly incomplete: Set<ts.Node>;
  readonly work: { count: number; complete: boolean };
};
