import type ts from "typescript";

import type { OwnerProjection } from "./owner-projection-view.ts";

export type ProjectionProof = ReturnType<typeof projectionProof>;

export function projectionProof(
  checker: ts.TypeChecker,
  localType: ts.Type,
  owner: OwnerProjection,
  fields: readonly ts.Symbol[],
  site: ts.Node
) {
  const propertyTypes = fields.map((field): [string, string] => [
    field.name,
    checker.typeToString(checker.getTypeOfSymbol(field)),
  ]);
  return {
    authorityState: "accepted",
    diagnostic: {
      emitted: true as const,
      messageId:
        owner.reverses === true
          ? "sharedContractOwner"
          : "ownedContractProjection",
    },
    localType: {
      name: localType.aliasSymbol?.name ?? "anonymous contract",
      props: propertyTypes,
    },
    ownerType: {
      authority: owner.authority,
      label: owner.label,
      props: propertyTypes,
    },
    structuralMatch: {
      matchedProps: fields.map((field) => field.name),
      relation:
        owner.reverses === true
          ? "reverse-dependency-owner-projection"
          : "proven-owner-projection",
      localPropCount: fields.length,
      ownerPropCount: checker.getPropertiesOfType(owner.type).length,
      provenance: {
        file: site.getSourceFile().fileName,
        start: site.getStart(),
      },
    },
  };
}
