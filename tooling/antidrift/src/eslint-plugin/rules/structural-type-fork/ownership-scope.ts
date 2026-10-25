import type ts from "typescript";

import {
  importedName,
  specifierPackage,
} from "../../../semantic-adapters/provenance/declared-dependencies.ts";
import type { IndexedCandidate } from "../../../semantic-adapters/type-owner/package-entry.ts";
import { scopedSpecifiers } from "../../../semantic-adapters/provenance/module-imports.ts";

export function scopedProvenanceCandidates(
  program: ts.Program,
  filePaths: readonly string[],
  candidates: readonly IndexedCandidate[]
): IndexedCandidate[] {
  const specifiers = scopedSpecifiers(program, filePaths);
  const packages = new Set(
    [...specifiers].flatMap((specifier) => {
      const packageName = specifierPackage(specifier);
      return packageName ? [packageName, importedName(packageName)] : [];
    })
  );
  const direct = candidates.filter(
    (candidate) =>
      candidate.authorityState === "accepted" ||
      (candidate.specifier &&
        (specifiers.has(candidate.specifier) ||
          specifiers.has(importedName(candidate.specifier))))
  );
  const directSet = new Set(direct);
  const directPackages = new Set(
    direct.map(
      (candidate) => candidate.packageName ?? candidate.label.split("#")[0]
    )
  );
  const fallbacks = candidates.filter((candidate) => {
    const packageName = candidate.packageName ?? candidate.label.split("#")[0];
    return (
      !directSet.has(candidate) &&
      packageName !== undefined &&
      packages.has(packageName) &&
      !directPackages.has(packageName)
    );
  });
  return [...direct, ...fallbacks].map((candidate) =>
    candidate.authorityState === "accepted"
      ? candidate
      : {
          ...candidate,
          authorityState: "accepted" as const,
          requiresProvenance: true,
        }
  );
}
