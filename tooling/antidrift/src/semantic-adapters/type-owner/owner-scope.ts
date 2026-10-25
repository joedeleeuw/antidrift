import type ts from "typescript";

import type { ownerProjections } from "../projection/owner-projection.ts";
import type { Coverage } from "./discovery-coverage.ts";
import type {
  IndexedCandidate,
  ResolvedPackageEntry,
} from "./package-entry.ts";

export type OwnerScope = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly candidates: readonly IndexedCandidate[];
  readonly coverage: Coverage;
  readonly missingEntries: readonly ResolvedPackageEntry[];
  projections?: ReturnType<typeof ownerProjections>;
};

export type CandidatesFor = (query: {
  packageRoot: string;
  mode?: ts.ResolutionMode;
  sourceFile?: ts.SourceFile;
  expand?: string;
}) => OwnerScope;
