import { findDescendant } from "./ast.js";
import { contributesToOutput } from "./expression-output.js";
import { queriesInRange } from "./query-provenance.js";
import { patternIdentifiers } from "./static-resolution.js";
import { sourcePath } from "../shared/source-path.js";
import {
  findVariable,
  isFunctionLike,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";

const COLLECTION_METHODS = new Set(["map", "flatMap", "filter"]);

function iterationContract(node, sourceCode) {
  if (node.type === "ForOfStatement") {
    const pattern =
      node.left.type === "VariableDeclaration"
        ? node.left.declarations[0].id
        : node.left;
    return {
      collection: node.right,
      body: node.body,
      bindings: [...patternIdentifiers(pattern)].map((identifier) =>
        findVariable(sourceCode, identifier)
      ),
    };
  }
  if (
    node.type !== "CallExpression" ||
    !COLLECTION_METHODS.has(staticPropertyName(node.callee))
  ) {
    return null;
  }
  const callback = unwrapExpression(node.arguments[0]);
  if (!isFunctionLike(callback) || !callback.params[0]) return null;
  return {
    collection: node.callee.object,
    body: callback.body,
    bindings: [...patternIdentifiers(callback.params[0])].map((identifier) =>
      findVariable(sourceCode, identifier)
    ),
  };
}

function lookupParts(node) {
  if (
    node.type === "CallExpression" &&
    staticPropertyName(node.callee) === "get" &&
    node.arguments.length === 1
  ) {
    return { receiver: node.callee.object, key: node.arguments[0] };
  }
  if (
    node.type === "MemberExpression" &&
    node.computed &&
    !staticPropertyName(node)
  ) {
    return { receiver: node.object, key: node.property };
  }
  return null;
}

export function keyedCollectionJoin(node, state) {
  const iteration = iterationContract(node, state.sourceCode);
  if (!iteration) return false;
  const outer = queriesInRange(iteration.collection, state).queries;
  if (outer.size === 0) return false;
  return Boolean(
    findDescendant(iteration.body, (candidate) => {
      const lookup = lookupParts(candidate);
      if (!lookup) return false;
      const keyOrigin = sourcePath(lookup.key, state.sourceCode);
      if (!keyOrigin || !iteration.bindings.includes(keyOrigin.binding)) {
        return false;
      }
      const inner = queriesInRange(lookup.receiver, state).queries;
      return (
        [...inner].some((query) => !outer.has(query)) &&
        contributesToOutput(candidate, state.sourceCode)
      );
    })
  );
}
