import type * as ts from "typescript";

export type {
  DomainStatusEntry,
  DomainStatusRegistry,
  StatusLiteralOwner,
} from "./shape/status-literal.ts";
export {
  canonicalStatusLiteralOwner,
  isStatusContextName,
  isStatusLiteralContext,
  nodeKeyName,
  normalizedContextName,
} from "./shape/status-literal.ts";

export const MIN_PROPS: 4;

export type TypeOwnerAuthority =
  | "domain"
  | "generated-source"
  | "installed-package";

export type TypeOwnerAuthorityState = "accepted" | "proposal";

export interface StructuralProperty {
  type: string;
  optional: boolean;
  readonly: boolean;
  method: boolean;
}

export interface StructuralTypeCandidate {
  label: string;
  type?: ts.Type;
  props: Map<string, string>;
  detailedProps?: Map<string, StructuralProperty>;
  authority: TypeOwnerAuthority;
  authorityState: TypeOwnerAuthorityState;
  requiresProvenance?: boolean;
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

export function isObjectType(type: ts.Type | null | undefined): boolean;

export function typeProps(
  checker: ts.TypeChecker,
  type: ts.Type
): Map<string, string>;

export function typePropsDetailed(
  checker: ts.TypeChecker,
  type: ts.Type
): Map<string, StructuralProperty>;

export function collectCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker
): StructuralTypeCandidate[];

export function collectAcceptedPackageCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker,
  packageTypeOwners?: PackageTypeOwnerRegistry
): StructuralTypeCandidate[];

export function collectGeneratedCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker,
  generatedSources?: GeneratedSourceRegistry
): StructuralTypeCandidate[];

export function collectDomainCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker,
  canonicalEntities?: DomainCanonicalEntityRegistry
): StructuralTypeCandidate[];

export function collectConvexGeneratedCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker
): StructuralTypeCandidate[];

export function isConvexGeneratedFile(fileName: string): boolean;

export function resolvesToInstalledType(
  type: ts.Type | null | undefined
): boolean;

export function resolvesToGeneratedType(
  type: ts.Type | null | undefined,
  generatedSources?: GeneratedSourceRegistry
): boolean;

export function resolvesToDomainCanonicalType(
  type: ts.Type | null | undefined,
  canonicalEntities?: DomainCanonicalEntityRegistry
): boolean;
