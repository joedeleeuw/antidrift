import { emitSemanticFact } from "../../policy/lib/semantic-facts.mjs";

export const structuralDerivationUtilities = new Set([
  "Omit",
  "Partial",
  "Pick",
  "Readonly",
  "Required",
]);
// Classify a local type against an owner using full-fidelity fingerprints.
// - exact-owner-copy: same properties, same types, same optionality/readonly/method-ness
// - loosened-owner-copy: same properties and types, but local relaxes optionality or drops readonly
// - partial-owner-copy: local is a strict subset of the owner, every local property exact
// Tightened copies (required where the owner is optional) and any other shape
// difference are deliberately unmatched.
export function classifyStructuralRelation(local, owner) {
  if (local.size === 0 || owner.size === 0 || local.size > owner.size) {
    return null;
  }
  let exact = local.size === owner.size;
  let loosened = local.size === owner.size;
  let subset = true;
  for (const [name, localProp] of local) {
    const ownerProp = owner.get(name);
    if (!ownerProp) {
      return null;
    }
    if (
      localProp.type !== ownerProp.type ||
      localProp.method !== ownerProp.method
    ) {
      return null;
    }
    if (
      localProp.optional !== ownerProp.optional ||
      localProp.readonly !== ownerProp.readonly
    ) {
      exact = false;
      subset = false;
      const optionalRelaxation = localProp.optional && !ownerProp.optional;
      const readonlyDrop = ownerProp.readonly && !localProp.readonly;
      if (
        (!optionalRelaxation && localProp.optional !== ownerProp.optional) ||
        (!readonlyDrop && localProp.readonly !== ownerProp.readonly)
      ) {
        loosened = false;
      }
    }
  }
  if (exact) return "exact-owner-copy";
  if (loosened) return "loosened-owner-copy";
  if (subset && local.size < owner.size) return "partial-owner-copy";
  return null;
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
export function structuralMatchProof(
  sym,
  local,
  candidate,
  diagnostic,
  relation = "exact-owner-copy",
) {
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
      relation,
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
export function structuralDiagnosticFor(candidate, messageId, relation) {
  if (
    candidate.authorityState === "accepted" &&
    relation === "exact-owner-copy"
  ) {
    return { emitted: true, messageId };
  }
  if (candidate.authorityState === "accepted") {
    return {
      emitted: false,
      reason: `structural-relation-${relation}`,
    };
  }
  return {
    emitted: false,
    reason: "owner-authority-unaccepted",
  };
}
const relationRank = {
  "exact-owner-copy": 0,
  "loosened-owner-copy": 1,
  "partial-owner-copy": 2,
};

export function findStructuralProof(
  sym,
  local,
  localDetailed,
  candidates,
  messageId,
) {
  let best = null;
  for (const candidate of sortedStructuralCandidates(candidates)) {
    if (!candidate.detailedProps) continue;
    const relation = classifyStructuralRelation(
      localDetailed,
      candidate.detailedProps,
    );
    if (!relation) continue;
    if (best && relationRank[relation] >= relationRank[best.relation]) {
      continue;
    }
    best = { candidate, relation };
    if (relation === "exact-owner-copy") break;
  }
  if (!best) return null;
  return structuralMatchProof(
    sym,
    local,
    best.candidate,
    structuralDiagnosticFor(best.candidate, messageId, best.relation),
    best.relation,
  );
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
