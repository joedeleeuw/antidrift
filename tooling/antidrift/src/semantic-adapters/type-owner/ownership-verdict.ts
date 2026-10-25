import ts from "typescript";

import { declaredDependencies } from "../provenance/declared-dependencies.ts";
import type { ProjectionProof } from "../projection/owner-projection-proof.ts";
import type { findStructuralProofs } from "../shape/structural-fork-proof.ts";
import type { Coverage } from "./discovery-coverage.ts";
import type { IndexedCandidate } from "./package-entry.ts";

type LocalDeclaration = {
  readonly symbol: ts.Symbol;
  readonly node: ts.Node;
  readonly exported: boolean;
};

type StructuralMatch = Omit<
  ReturnType<typeof findStructuralProofs>[number],
  "candidate"
> & {
  readonly candidate: IndexedCandidate;
};
type WitnessProof = ProjectionProof;

type ArbitrationInput = {
  readonly checker: ts.TypeChecker;
  readonly local: LocalDeclaration;
  readonly packageRoot: string;
  readonly matches: readonly StructuralMatch[];
  readonly coverage: Coverage;
  readonly witnesses?: readonly WitnessProof[];
};

type ArbitrationResult =
  | {
      readonly kind: "block";
      readonly proof: StructuralMatch["proof"] | WitnessProof;
    }
  | {
      readonly kind: "inventory";
      readonly reason:
        | "shape-only"
        | "multiple-owners"
        | "inventory-incomplete"
        | "unresolved";
      readonly proof?: StructuralMatch["proof"];
    }
  | { readonly kind: "clean" };

function candidateIdentity(
  checker: ts.TypeChecker,
  candidate: IndexedCandidate
) {
  const symbol = candidate.symbol ?? candidate.type?.getSymbol();
  return symbol ? checker.getMergedSymbol(symbol) : candidate.label;
}

function distinctExactMatches(
  checker: ts.TypeChecker,
  matches: readonly StructuralMatch[]
) {
  const owners = new Map<unknown, StructuralMatch>();
  for (const match of matches) {
    if (match.relation !== "exact-owner-copy") {
      continue;
    }
    const identity = candidateIdentity(checker, match.candidate);
    if (!owners.has(identity)) {
      owners.set(identity, match);
    }
  }
  return [...owners.values()];
}

export function isNamePromotionForm(local: LocalDeclaration) {
  if (!local.exported || local.symbol.declarations?.length !== 1) {
    return false;
  }
  if (ts.isInterfaceDeclaration(local.node)) {
    return (local.node.heritageClauses?.length ?? 0) === 0;
  }
  return (
    ts.isTypeAliasDeclaration(local.node) &&
    ts.isTypeLiteralNode(local.node.type) &&
    (local.node.typeParameters?.length ?? 0) === 0
  );
}

function exportedNameMatch(
  input: ArbitrationInput,
  exactMatches: readonly StructuralMatch[]
) {
  const { local, packageRoot, coverage } = input;
  const [match] = exactMatches;
  const localName = local.symbol.getName();
  if (
    !match ||
    exactMatches.length !== 1 ||
    match.candidate.workspace !== true ||
    !coverage.complete
  ) {
    return null;
  }
  const { candidate } = match;
  return isNamePromotionForm(local) &&
    candidate.exportName === localName &&
    !localName.includes(".") &&
    candidate.packageName !== undefined &&
    declaredDependencies(packageRoot).includes(candidate.packageName) &&
    candidate.symbol !== undefined &&
    candidate.symbol !== local.symbol &&
    !(candidate.symbol.declarations ?? []).some(
      (declaration: ts.Declaration) =>
        declaration.getSourceFile().fileName ===
        local.symbol.declarations?.[0]?.getSourceFile().fileName
    )
    ? match
    : null;
}

function inventory(
  reason:
    | "shape-only"
    | "multiple-owners"
    | "inventory-incomplete"
    | "unresolved",
  match?: StructuralMatch
): ArbitrationResult {
  return {
    kind: "inventory",
    reason,
    ...(match
      ? {
          proof: {
            ...match.proof,
            diagnostic: { emitted: false as const, reason },
          },
        }
      : {}),
  };
}

export function arbitrateOwnership(input: ArbitrationInput): ArbitrationResult {
  const witnesses = input.witnesses ?? [];
  const witnessOwners = new Set(
    witnesses.map((witness) => witness.ownerType.label)
  );
  if (witnesses.length > 0) {
    if (witnessOwners.size === 1 && witnesses[0]) {
      return { kind: "block", proof: witnesses[0] };
    }
    return inventory("multiple-owners", input.matches[0]);
  }

  const exactMatches = distinctExactMatches(input.checker, input.matches);
  const accepted = exactMatches.filter(
    (match) =>
      match.candidate.authorityState === "accepted" &&
      !match.candidate.requiresProvenance
  );
  if (accepted.length === 1 && accepted[0]) {
    return { kind: "block", proof: accepted[0].proof };
  }
  if (accepted.length > 1) {
    return inventory("multiple-owners", accepted[0]);
  }

  const unresolved = input.matches.find(
    (match) => match.relation === "unresolved-owner-comparison"
  );
  if (unresolved) {
    return inventory("unresolved", unresolved);
  }
  if (exactMatches.length === 0) {
    return input.coverage.complete
      ? { kind: "clean" }
      : inventory("inventory-incomplete");
  }
  const namedOwner = exportedNameMatch(input, exactMatches);
  if (namedOwner?.candidate.reverses === true) {
    return {
      kind: "block",
      proof: {
        ...namedOwner.proof,
        structuralMatch: {
          ...namedOwner.proof.structuralMatch,
          relation: "reverse-dependency-owner-copy",
        },
        diagnostic: { emitted: true, messageId: "sharedContractOwner" },
      },
    };
  }
  if (namedOwner) {
    return {
      kind: "block",
      proof: {
        ...namedOwner.proof,
        authorityState: "accepted",
        structuralMatch: {
          ...namedOwner.proof.structuralMatch,
          relation: "exported-name-exact-owner-copy",
        },
        diagnostic: { emitted: true, messageId: "structuralTypeFork" },
      },
    };
  }
  if (exactMatches.length > 1) {
    return inventory("multiple-owners", exactMatches[0]);
  }
  return input.coverage.complete
    ? inventory("shape-only", exactMatches[0])
    : inventory("inventory-incomplete", exactMatches[0]);
}
