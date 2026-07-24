import { emitSemanticFact } from "../../policy/lib/semantic-facts.mjs";

export const structuralDerivationUtilities = new Set([
  "Omit",
  "Partial",
  "Pick",
  "Readonly",
  "Required",
]);
export function isExactStructuralFork(local, canonical) {
  if (local.size !== canonical.size) {
    return false;
  }
  for (const [name, typeStr] of local) {
    if (canonical.get(name) !== typeStr) {
      return false;
    }
  }
  return true;
}
export function sortedProps(props) {
  return [...props.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}
export function structuralCandidateRank(candidate) {
  return candidate.authorityState === "accepted" ? 0 : 1;
}
export function sortedStructuralCandidates(candidates) {
  return [...candidates].sort(
    (left, right) =>
      structuralCandidateRank(left) - structuralCandidateRank(right) ||
      left.label.localeCompare(right.label),
  );
}
export function structuralMatchProof(sym, local, candidate, diagnostic) {
  const localProps = sortedProps(local);
  return {
    authorityState: candidate.authorityState ?? "proposal",
    diagnostic,
    localType: {
      name: sym.getName(),
      props: localProps,
    },
    ownerType: {
      authority: candidate.authority ?? "unknown",
      label: candidate.label,
      props: sortedProps(candidate.props),
    },
    structuralMatch: {
      matchedProps: localProps.map(([name]) => name),
      relation: "exact-owner-copy",
      localPropCount: local.size,
      ownerPropCount: candidate.props.size,
    },
  };
}
export function emitStructuralMatchFact(context, node, ruleId, proof) {
  return emitSemanticFact(context, node, {
    factKind: "structuralMatch",
    ruleId,
    adapterId: "typescript-eslint/type-owner",
    confidence: proof.diagnostic.emitted
      ? "deterministic-enforcement"
      : "deterministic-inventory",
    provenance: ["AST", "TypeChecker"],
    payload: proof,
  });
}
export function structuralDiagnosticFor(candidate, messageId) {
  if (candidate.authorityState === "accepted") {
    return { emitted: true, messageId };
  }
  return {
    emitted: false,
    reason: "owner-authority-unaccepted",
  };
}
export function findStructuralProof(sym, local, candidates, messageId) {
  for (const candidate of sortedStructuralCandidates(candidates)) {
    if (isExactStructuralFork(local, candidate.props)) {
      return structuralMatchProof(
        sym,
        local,
        candidate,
        structuralDiagnosticFor(candidate, messageId),
      );
    }
  }
  return null;
}
export function isAllOptionalObjectShape(node) {
  let members = [];
  if (
    node.type === "TSTypeAliasDeclaration" &&
    node.typeAnnotation?.type === "TSTypeLiteral"
  ) {
    members = node.typeAnnotation.members;
  } else if (node.type === "TSInterfaceDeclaration") {
    members = node.body.body;
  }
  const props = members.filter(
    (member) => member.type === "TSPropertySignature",
  );
  return props.length > 0 && props.every((prop) => prop.optional);
}
export function typeReferenceName(typeNode) {
  if (typeNode?.typeName?.type === "Identifier") {
    return typeNode.typeName.name;
  }
  if (typeNode?.typeName?.type === "TSQualifiedName") {
    return typeNode.typeName.right?.name ?? typeNode.typeName.left?.name ?? "";
  }
  return "";
}
export function typeReferenceArguments(typeNode) {
  return (
    typeNode?.typeArguments?.params ?? typeNode?.typeParameters?.params ?? []
  );
}
export function isDerivationSourceReference(typeNode) {
  return (
    typeNode?.type === "TSTypeReference" || typeNode?.type === "TSImportType"
  );
}
export function isStructuralDerivationAlias(node) {
  if (node.type !== "TSTypeAliasDeclaration") {
    return false;
  }
  const annotation = node.typeAnnotation;
  if (annotation?.type === "TSTupleType") {
    return true;
  }
  if (annotation?.type !== "TSTypeReference") {
    return false;
  }
  if (!structuralDerivationUtilities.has(typeReferenceName(annotation))) {
    return false;
  }
  return isDerivationSourceReference(typeReferenceArguments(annotation)[0]);
}
