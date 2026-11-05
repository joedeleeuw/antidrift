import { sourcePath } from "../shared/source-path.js";
import { splitIdentifierWords } from "../shared/scope.js";
import {
  firstPartyContract,
  getResolvedType,
  getTypeServices,
  isOptionalProperty,
  propertyType,
  shareEntityIdentity,
} from "../shared/type-services.js";
import { schemaDiscriminantKeys } from "../shared/runtime-schema-libraries.js";

export function sharesIdentifierStem(left, right) {
  if (left === right) return true;
  const rightWords = new Set(
    splitIdentifierWords(right).filter((word) => word.length >= 3)
  );
  return splitIdentifierWords(left).some(
    (word) => word.length >= 3 && rightWords.has(word)
  );
}

export function repeatedBranchFields(branchSignatures) {
  if (branchSignatures.length < 2) return [];
  const occurrences = new Map();
  for (const signatures of branchSignatures) {
    for (const signature of new Set(signatures)) {
      occurrences.set(signature, (occurrences.get(signature) ?? 0) + 1);
    }
  }
  const minBranches = branchSignatures.length === 2 ? 2 : 3;
  const shared = [...occurrences]
    .filter(([, count]) => count >= minBranches)
    .map(([signature]) => signature);
  return shared.length >= 2 ? shared : [];
}

function relatedContracts(left, right) {
  const leftFiles = new Set(
    left.symbol.declarations.map((declaration) => declaration.getSourceFile())
  );
  return (
    right.symbol.declarations.some((declaration) =>
      leftFiles.has(declaration.getSourceFile())
    ) || sharesIdentifierStem(left.name, right.name)
  );
}

function independentlyRepeated(property, contract, services) {
  if (schemaDiscriminantKeys.has(property.name)) return false;
  const declaredType = propertyType(property, services);
  if (declaredType.isLiteral?.()) return false;
  return contract.properties.some((peer) => {
    if (
      peer.name !== property.name ||
      isOptionalProperty(peer) !== isOptionalProperty(property)
    ) {
      return false;
    }
    if (
      peer.declarations.some((declaration) =>
        property.declarations.includes(declaration)
      )
    ) {
      return false;
    }
    const peerType = propertyType(peer, services);
    return (
      services.checker.isTypeAssignableTo(declaredType, peerType) &&
      services.checker.isTypeAssignableTo(peerType, declaredType)
    );
  });
}

export function resolvedRepeatedFields(node, sourceCode) {
  const services = getTypeServices(sourceCode);
  if (!services || node.type !== "TSUnionType") return null;
  const branches = node.types.map((branch) =>
    firstPartyContract(getResolvedType(branch, sourceCode), services)
  );
  if (branches.length < 2 || branches.some((contract) => !contract)) {
    return null;
  }
  const [first, ...rest] = branches;
  if (!rest.every((peer) => relatedContracts(first, peer))) return [];
  const shared = first.properties
    .filter((property) =>
      rest.every((peer) => independentlyRepeated(property, peer, services))
    )
    .map(
      (property) =>
        `${property.name}${isOptionalProperty(property) ? "?" : ""}: ${services.checker.typeToString(propertyType(property, services))}`
    );
  return shared.length >= 2 ? shared : [];
}

function literalTypes(type) {
  const branches = type.isUnion?.() ? type.types : [type];
  return branches.every(
    (branch) =>
      branch.isLiteral?.() ||
      branch.intrinsicName === "true" ||
      branch.intrinsicName === "false"
  )
    ? branches
    : null;
}

function hasDisjointTag(summary, detail, services) {
  return summary.properties.some((property) => {
    const peer = detail.properties.find(
      (candidate) => candidate.name === property.name
    );
    if (!peer || isOptionalProperty(property) || isOptionalProperty(peer)) {
      return false;
    }
    const left = literalTypes(propertyType(property, services));
    const right = literalTypes(propertyType(peer, services));
    return (
      left &&
      right &&
      !left.some((first) =>
        right.some(
          (second) =>
            services.checker.isTypeAssignableTo(first, second) ||
            services.checker.isTypeAssignableTo(second, first)
        )
      )
    );
  });
}

function strictProjection(summary, detail, probedKey, services) {
  const added = detail.properties.find(
    (property) => property.name === probedKey
  );
  return (
    added &&
    !isOptionalProperty(added) &&
    !summary.properties.some((property) => property.name === probedKey) &&
    summary.properties.every((property) =>
      detail.properties.some(
        (peer) =>
          peer.name === property.name &&
          (isOptionalProperty(property) || !isOptionalProperty(peer))
      )
    ) &&
    (sharesIdentifierStem(summary.name, detail.name) ||
      shareEntityIdentity(summary, detail, services)) &&
    services.checker.isTypeAssignableTo(detail.type, summary.type) &&
    !services.checker.isTypeAssignableTo(summary.type, detail.type) &&
    !hasDisjointTag(summary, detail, services)
  );
}

export function checkProjectionUnionProbe(node, context) {
  if (
    node.operator !== "in" ||
    node.left.type !== "Literal" ||
    typeof node.left.value !== "string"
  ) {
    return;
  }
  const services = getTypeServices(context.sourceCode);
  const origin = sourcePath(node.right, context.sourceCode);
  if (!services || origin?.binding.defs[0]?.type !== "Parameter") return;
  const union = getResolvedType(node.right, context.sourceCode);
  if (!union?.isUnion?.()) return;
  const contracts = union.types.map((branch) =>
    firstPartyContract(branch, services)
  );
  if (contracts.length < 2 || contracts.some((contract) => !contract)) return;
  for (const summary of contracts) {
    const detail = contracts.find(
      (candidate) =>
        candidate !== summary &&
        strictProjection(summary, candidate, node.left.value, services)
    );
    if (!detail) continue;
    context.report({
      node,
      message: `Union parameter mixes summary and detail representations ('${summary.name}' and '${detail.name}') and probes '${node.left.value}' with 'in'; pass one canonical contract or discriminate variants explicitly.`,
    });
    return;
  }
}
