import type * as ts from "typescript";

export const MIN_PROPS: 4;

export type TypeOwnerAuthority =
  | "domain"
  | "generated-source"
  | "installed-package";

export type TypeOwnerAuthorityState = "accepted" | "proposal";

export interface StructuralTypeCandidate {
  label: string;
  props: Map<string, string>;
  authority: TypeOwnerAuthority;
  authorityState: TypeOwnerAuthorityState;
  ownerKey?: string;
}

export interface GeneratedSourceEntry {
  generated: string;
  wrapper?: string;
  bannedDirectImports?: readonly string[];
}

export type GeneratedSourceRegistry = Record<string, GeneratedSourceEntry>;

export interface PackageTypeOwnerEntry {
  package: string;
  exportName: string;
  reason?: string;
}

export type PackageTypeOwnerRegistry = Record<string, PackageTypeOwnerEntry>;

export interface DomainCanonicalEntityEntry {
  owner: string;
  exportName?: string;
}

export type DomainCanonicalEntityRegistry = Record<
  string,
  string | DomainCanonicalEntityEntry
>;

export interface DomainStatusEntry {
  owner: string;
  values: readonly string[];
  valuesExport?: string;
}

export type DomainStatusRegistry = Record<string, DomainStatusEntry>;

export interface StatusLiteralOwner {
  name: string;
  owner: string;
  values: readonly string[];
  value: string;
}

export function isObjectType(type: ts.Type | null | undefined): boolean;

export function typeProps(
  checker: ts.TypeChecker,
  type: ts.Type,
): Map<string, string>;

export function collectCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker,
): StructuralTypeCandidate[];

export function collectAcceptedPackageCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker,
  packageTypeOwners?: PackageTypeOwnerRegistry,
): StructuralTypeCandidate[];

export function collectGeneratedCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker,
  generatedSources?: GeneratedSourceRegistry,
): StructuralTypeCandidate[];

export function collectDomainCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker,
  canonicalEntities?: DomainCanonicalEntityRegistry,
): StructuralTypeCandidate[];

export function resolvesToInstalledType(
  type: ts.Type | null | undefined,
): boolean;

export function resolvesToGeneratedType(
  type: ts.Type | null | undefined,
  generatedSources?: GeneratedSourceRegistry,
): boolean;

export function resolvesToDomainCanonicalType(
  type: ts.Type | null | undefined,
  canonicalEntities?: DomainCanonicalEntityRegistry,
): boolean;

export function normalizedContextName(value: unknown): string;

export function isStatusContextName(
  contextName: unknown,
  statusName: string,
): boolean;

export function nodeKeyName(node: unknown): string;

export function isStatusLiteralContext(
  node: unknown,
  statusName: string,
): boolean;

export function canonicalStatusLiteralOwner(
  node: unknown,
  statuses: DomainStatusRegistry,
): StatusLiteralOwner | null;
