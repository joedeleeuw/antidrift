import type ts from "typescript";

import type { StructuralTypeCandidate } from "../type-owner.mjs";
import { contractScopeKey } from "./contract-sites.ts";
import type { LocalContractScope } from "./contract-sites.ts";
import {
  collectContractValueFlow,
  createProvenanceSearch,
} from "./contract-value-flow.ts";
import type { OwnerProjectionIndex } from "./owner-projection.ts";
import type { ProjectionProof } from "./owner-projection-proof.ts";

type CachedProvenance = {
  readonly candidates: readonly StructuralTypeCandidate[];
  readonly scope: string;
  readonly complete: boolean;
  readonly incomplete: ReadonlySet<ts.Node>;
  readonly findings: ReadonlyMap<ts.Node, ProjectionProof[]>;
};

const provenanceByProgram = new WeakMap<ts.Program, CachedProvenance[]>();

function sameCandidates(
  cachedCandidates: readonly StructuralTypeCandidate[],
  accepted: readonly StructuralTypeCandidate[]
): boolean {
  return (
    cachedCandidates.length === accepted.length &&
    accepted.every((candidate, index) => {
      const cachedCandidate = cachedCandidates[index];
      return (
        cachedCandidate !== undefined &&
        candidate.type === cachedCandidate.type &&
        candidate.label === cachedCandidate.label &&
        candidate.authority === cachedCandidate.authority
      );
    })
  );
}

export function collectOwnedContractProvenance(
  program: ts.Program,
  checker: ts.TypeChecker,
  candidates: readonly StructuralTypeCandidate[],
  filePaths: readonly string[],
  localContracts: LocalContractScope,
  owners?: OwnerProjectionIndex
) {
  const accepted = candidates.filter(
    (candidate) => candidate.authorityState === "accepted"
  );
  if (filePaths.length === 0 || accepted.length === 0) {
    return {
      findings: new Map<ts.Node, ProjectionProof[]>(),
      complete: true,
      incomplete: new Set<ts.Node>(),
    };
  }
  if (filePaths.length > 32) {
    throw new TypeError("Owner provenance scope exceeds 32 files.");
  }
  const scopeKey = contractScopeKey(filePaths, localContracts);
  const programCache = provenanceByProgram.get(program) ?? [];
  provenanceByProgram.set(program, programCache);
  const cached = programCache.find(
    (entry) =>
      entry.scope === scopeKey && sameCandidates(entry.candidates, accepted)
  );
  if (cached) {
    return {
      findings: cached.findings,
      complete: cached.complete,
      incomplete: cached.incomplete,
    };
  }
  const search = createProvenanceSearch(
    checker,
    accepted,
    localContracts,
    owners
  );
  collectContractValueFlow(program, filePaths, search);
  if (!search.work.complete) {
    for (const declaration of localContracts.declarations.keys()) {
      search.incomplete.add(declaration);
    }
  }
  const complete = search.work.complete && search.incomplete.size === 0;
  if (programCache.length >= 32) {
    programCache.shift();
  }
  programCache.push({
    candidates: accepted,
    scope: scopeKey,
    complete,
    incomplete: search.incomplete,
    findings: search.findings,
  });
  return {
    findings: search.findings,
    complete,
    incomplete: search.incomplete,
  };
}
