import type ts from "typescript";

import type { StructuralTypeCandidate } from "../type-owner.mjs";
import type { Exhaustion } from "./discovery-coverage.ts";

export type PackageEntry = {
  readonly packageName: string;
  readonly specifier: string;
  readonly reverses: boolean;
  readonly workspace: boolean;
};

export type ResolvedPackageEntry = PackageEntry & {
  readonly mode: ts.ResolutionMode | undefined;
  readonly fileName: string;
};

export type PackageDiscovery = {
  readonly coverage: { exhausted: Exhaustion[] };
};

export type IndexedCandidate = StructuralTypeCandidate &
  Partial<PackageEntry> & {
    readonly symbol?: ts.Symbol;
    readonly exportName?: string;
  };
