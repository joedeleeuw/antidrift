import type ts from "typescript";

import {
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  syntaxText,
} from "../kernel/syntax-node.ts";
import type {
  StructuralProperty,
  StructuralTypeCandidate,
} from "../type-owner.mjs";
import { equivalentType } from "./equivalent-types.ts";
import { shapeComparison } from "./shape-identity.ts";

type StructuralRelation =
  | "exact-owner-copy"
  | "exported-name-exact-owner-copy"
  | "reverse-dependency-owner-copy"
  | "loosened-owner-copy"
  | "partial-owner-copy"
  | "unresolved-owner-comparison";

type StructuralDiagnostic =
  | { readonly emitted: true; readonly messageId: string }
  | { readonly emitted: false; readonly reason: string };

export type LocalStructuralType = {
  readonly type: ts.Type;
  readonly symbol: ts.Symbol;
  readonly declaration?: ts.Node;
  readonly props: ReadonlyMap<string, string>;
  readonly detailedProps: ReadonlyMap<string, StructuralProperty>;
};

type StructuralRelationDraft = {
  exact: boolean;
  loosened: boolean;
  subset: boolean;
};

export const structuralDerivationUtilities = new Set([
  "Omit",
  "Partial",
  "Pick",
  "Readonly",
  "Required",
]);

function samePropertyType(
  checker: ts.TypeChecker,
  name: string,
  localType: ts.Type,
  ownerType: ts.Type | undefined
): boolean {
  const localSymbol = checker.getPropertyOfType(localType, name);
  const ownerSymbol = ownerType && checker.getPropertyOfType(ownerType, name);
  return (
    localSymbol !== undefined &&
    ownerSymbol !== undefined &&
    equivalentType(
      checker,
      checker.getTypeOfSymbol(localSymbol),
      checker.getTypeOfSymbol(ownerSymbol)
    )
  );
}

function relaxModifiers(
  draft: StructuralRelationDraft,
  localProp: StructuralProperty,
  ownerProp: StructuralProperty
): void {
  if (
    localProp.optional === ownerProp.optional &&
    localProp.readonly === ownerProp.readonly
  ) {
    return;
  }
  draft.exact = false;
  draft.subset = false;
  const optionalRelaxation = localProp.optional && !ownerProp.optional;
  const readonlyDrop = ownerProp.readonly && !localProp.readonly;
  if (
    (!optionalRelaxation && localProp.optional !== ownerProp.optional) ||
    (!readonlyDrop && localProp.readonly !== ownerProp.readonly)
  ) {
    draft.loosened = false;
  }
}

export function classifyStructuralRelation(
  local: ReadonlyMap<string, StructuralProperty>,
  owner: ReadonlyMap<string, StructuralProperty>,
  checker: ts.TypeChecker,
  localType: ts.Type,
  ownerType: ts.Type | undefined
): StructuralRelation | null {
  if (local.size === 0 || owner.size === 0 || local.size > owner.size) {
    return null;
  }
  const draft = {
    exact: local.size === owner.size,
    loosened: local.size === owner.size,
    subset: true,
  };
  for (const [name, localProp] of local) {
    const ownerProp = owner.get(name);
    if (
      !ownerProp ||
      !samePropertyType(checker, name, localType, ownerType) ||
      localProp.method !== ownerProp.method
    ) {
      return null;
    }
    relaxModifiers(draft, localProp, ownerProp);
  }
  if (draft.exact) {
    return equivalentType(checker, localType, ownerType)
      ? "exact-owner-copy"
      : null;
  }
  if (draft.loosened) {
    return "loosened-owner-copy";
  }
  if (draft.subset && local.size < owner.size) {
    return "partial-owner-copy";
  }
  return null;
}

function sortedProps(
  propertyTypes: ReadonlyMap<string, string>
): [string, string][] {
  return [...propertyTypes.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
}

function structuralCandidateRank(candidate: StructuralTypeCandidate): number {
  if (candidate.authorityState !== "accepted") {
    return 2;
  }
  return candidate.requiresProvenance ? 1 : 0;
}

export function sortedStructuralCandidates(
  candidates: readonly StructuralTypeCandidate[]
): StructuralTypeCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      structuralCandidateRank(left) - structuralCandidateRank(right) ||
      left.label.localeCompare(right.label)
  );
}

function structuralMatchProof(
  local: LocalStructuralType,
  candidate: StructuralTypeCandidate,
  diagnostic: StructuralDiagnostic,
  relation: StructuralRelation
) {
  const localProps = sortedProps(local.props);
  return {
    authorityState: candidate.authorityState,
    diagnostic,
    localType: {
      name: local.symbol.getName(),
      props: localProps,
    },
    ownerType: {
      authority: candidate.authority,
      label: candidate.label,
      props: sortedProps(candidate.props),
    },
    structuralMatch: {
      matchedProps: localProps.map(([name]) => name),
      relation,
      localPropCount: local.props.size,
      ownerPropCount: candidate.props.size,
    },
  };
}

export function structuralMatchFact(
  ruleId: string,
  proof: { readonly diagnostic: StructuralDiagnostic }
) {
  return {
    factKind: "structuralMatch",
    ruleId,
    adapterId: "typescript-eslint/type-owner",
    confidence: proof.diagnostic.emitted
      ? "deterministic-enforcement"
      : "deterministic-inventory",
    provenance: ["AST", "TypeChecker"],
    payload: proof,
  };
}

function structuralDiagnosticFor(
  candidate: StructuralTypeCandidate,
  messageId: string,
  relation: StructuralRelation
): StructuralDiagnostic {
  if (relation === "unresolved-owner-comparison") {
    return { emitted: false, reason: relation };
  }
  if (
    candidate.authorityState === "accepted" &&
    !candidate.requiresProvenance &&
    relation === "exact-owner-copy"
  ) {
    return { emitted: true, messageId };
  }
  if (candidate.authorityState === "accepted") {
    return {
      emitted: false,
      reason: candidate.requiresProvenance
        ? "owner-use-unproven"
        : `structural-relation-${relation}`,
    };
  }
  return {
    emitted: false,
    reason: "owner-authority-unaccepted",
  };
}

function samePropertyNames(
  local: ReadonlyMap<string, StructuralProperty>,
  owner: ReadonlyMap<string, StructuralProperty>
) {
  return (
    local.size === owner.size &&
    [...local.keys()].every((name) => owner.has(name))
  );
}

export function findStructuralProofs(
  checker: ts.TypeChecker,
  local: LocalStructuralType,
  candidates: readonly StructuralTypeCandidate[],
  messageId: string,
  program?: ts.Program
) {
  const compare = program ? shapeComparison(program) : null;
  const matches = [];
  for (const candidate of sortedStructuralCandidates(candidates)) {
    let relation: StructuralRelation | null = candidate.detailedProps
      ? classifyStructuralRelation(
          local.detailedProps,
          candidate.detailedProps,
          checker,
          local.type,
          candidate.type
        )
      : null;
    if (
      !relation &&
      compare &&
      candidate.type !== undefined &&
      candidate.detailedProps &&
      samePropertyNames(local.detailedProps, candidate.detailedProps)
    ) {
      const verdict = compare(local.type, candidate.type);
      if (verdict === true) {
        relation = "exact-owner-copy";
      } else if (typeof verdict !== "boolean") {
        relation = "unresolved-owner-comparison";
      }
    }
    if (relation) {
      matches.push({
        candidate,
        relation,
        proof: structuralMatchProof(
          local,
          candidate,
          structuralDiagnosticFor(candidate, messageId, relation),
          relation
        ),
      });
    }
  }
  return matches;
}

function objectShapeMembers(node: unknown): readonly unknown[] {
  const annotation = syntaxField(node, "typeAnnotation");
  if (
    isSyntaxType(node, "TSTypeAliasDeclaration") &&
    isSyntaxType(annotation, "TSTypeLiteral")
  ) {
    return syntaxChildren(annotation, "members");
  }
  if (isSyntaxType(node, "TSInterfaceDeclaration")) {
    return syntaxChildren(syntaxField(node, "body"), "body");
  }
  return [];
}

export function isAllOptionalObjectShape(node: unknown): boolean {
  const propertySignatures = objectShapeMembers(node).filter((member) =>
    isSyntaxType(member, "TSPropertySignature")
  );
  return (
    propertySignatures.length > 0 &&
    propertySignatures.every((signature) =>
      Boolean(syntaxField(signature, "optional"))
    )
  );
}

function typeReferenceName(typeNode: unknown): string {
  const typeName = syntaxField(typeNode, "typeName");
  if (isSyntaxType(typeName, "Identifier")) {
    return syntaxText(typeName, "name") ?? "";
  }
  if (isSyntaxType(typeName, "TSQualifiedName")) {
    return (
      syntaxText(syntaxField(typeName, "right"), "name") ??
      syntaxText(syntaxField(typeName, "left"), "name") ??
      ""
    );
  }
  return "";
}

function typeReferenceArguments(typeNode: unknown): readonly unknown[] {
  const typeArguments =
    syntaxField(syntaxField(typeNode, "typeArguments"), "params") ??
    syntaxField(syntaxField(typeNode, "typeParameters"), "params");
  return Array.isArray(typeArguments) ? typeArguments : [];
}

function isDerivationSourceReference(typeNode: unknown): boolean {
  return (
    isSyntaxType(typeNode, "TSTypeReference") ||
    isSyntaxType(typeNode, "TSImportType")
  );
}

function isZodInference(typeNode: unknown): boolean {
  if (!isSyntaxType(typeNode, "TSTypeReference")) {
    return false;
  }
  const typeName = syntaxField(typeNode, "typeName");
  return (
    isSyntaxType(typeName, "TSQualifiedName") &&
    syntaxText(syntaxField(typeName, "left"), "name") === "z" &&
    syntaxText(syntaxField(typeName, "right"), "name") === "infer" &&
    isSyntaxType(typeReferenceArguments(typeNode)[0], "TSTypeQuery")
  );
}

export function isStructuralDerivationAlias(node: unknown): boolean {
  if (!isSyntaxType(node, "TSTypeAliasDeclaration")) {
    return false;
  }
  const annotation = syntaxField(node, "typeAnnotation");
  if (isSyntaxType(annotation, "TSTupleType")) {
    return true;
  }
  if (isZodInference(annotation)) {
    return true;
  }
  return (
    isSyntaxType(annotation, "TSTypeReference") &&
    structuralDerivationUtilities.has(typeReferenceName(annotation)) &&
    isDerivationSourceReference(typeReferenceArguments(annotation)[0])
  );
}
