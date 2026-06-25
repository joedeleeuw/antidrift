import { describe, expect, it } from "vitest";

import {
  ASYNC_ARRAY_METHODS_NEVER_AWAIT,
  ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION,
  asyncArrayCallbackClassification,
  asyncCallbackArgument,
  isDirectlyWrappedInPromiseCombinator,
  isPromiseCombinator,
  isReturnedExpression,
  markAwaitedPendingMaps,
  markReturnedPendingMaps,
  promiseCombinatorVariables,
  queuePendingAsyncMap,
} from "./async-control-flow.mjs";

function memberCall(method, callback) {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: { type: "Identifier", name: "items" },
      property: { type: "Identifier", name: method },
    },
    arguments: [callback],
  };
}

describe("async-control-flow array callback helpers", () => {
  it("classifies async array callbacks and collected promise variables", () => {
    const callback = { type: "ArrowFunctionExpression", async: true };
    const forEachCall = memberCall("forEach", callback);
    const mapCall = memberCall("map", callback);
    const variable = { name: "mapped" };
    const declarator = {
      type: "VariableDeclarator",
      id: { type: "Identifier", name: "mapped" },
      init: mapCall,
    };
    mapCall.parent = declarator;
    const sourceCode = {
      scopeManager: {
        getDeclaredVariables(node) {
          return node === declarator ? [variable] : [];
        },
      },
      getScope() {
        return { set: new Map([["mapped", variable]]), upper: null };
      },
    };
    const pending = [];

    expect(ASYNC_ARRAY_METHODS_NEVER_AWAIT.has("forEach")).toBe(true);
    expect(ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION.has("map")).toBe(true);
    expect(asyncCallbackArgument(forEachCall)).toBe(callback);
    expect(asyncArrayCallbackClassification(forEachCall)).toEqual({
      callback,
      method: "forEach",
      kind: "never-await",
    });
    expect(asyncArrayCallbackClassification(mapCall)).toEqual({
      callback,
      method: "map",
      kind: "requires-collection",
    });
    expect(queuePendingAsyncMap(sourceCode, mapCall, callback, "map", pending))
      .toBe(true);
    expect(pending).toEqual([
      {
        variable,
        node: callback,
        method: "map",
        awaited: false,
        returned: false,
      },
    ]);

    const promiseAll = {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: { type: "Identifier", name: "Promise" },
        property: { type: "Identifier", name: "all" },
      },
      arguments: [{ type: "Identifier", name: "mapped" }],
    };
    markAwaitedPendingMaps(sourceCode, promiseAll, pending);
    expect(pending[0].awaited).toBe(true);
    expect(promiseCombinatorVariables(sourceCode, promiseAll)).toEqual([
      variable,
    ]);
    expect(isPromiseCombinator(promiseAll.callee)).toBe(true);

    const directMap = memberCall("flatMap", callback);
    const directPromiseAll = { ...promiseAll, arguments: [directMap] };
    directMap.parent = directPromiseAll;
    expect(isDirectlyWrappedInPromiseCombinator(directMap)).toBe(true);
    expect(isReturnedExpression(directMap)).toBe(false);

    const returnedMap = memberCall("map", callback);
    returnedMap.parent = { type: "ReturnStatement", argument: returnedMap };
    expect(isReturnedExpression(returnedMap)).toBe(true);

    const conciseArrowMap = memberCall("map", callback);
    conciseArrowMap.parent = {
      type: "ArrowFunctionExpression",
      body: conciseArrowMap,
    };
    expect(isReturnedExpression(conciseArrowMap)).toBe(true);

    const conditionalMap = memberCall("map", callback);
    const conditional = {
      type: "ConditionalExpression",
      consequent: conditionalMap,
      alternate: { type: "ArrayExpression", elements: [] },
    };
    conditionalMap.parent = conditional;
    conditional.parent = { type: "ReturnStatement", argument: conditional };
    expect(isReturnedExpression(conditionalMap)).toBe(true);

    const pendingForReturn = [
      {
        variable,
        node: callback,
        method: "map",
        awaited: false,
        returned: false,
      },
    ];
    markReturnedPendingMaps(
      sourceCode,
      { type: "ReturnStatement", argument: { type: "Identifier", name: "mapped" } },
      pendingForReturn,
    );
    expect(pendingForReturn[0].returned).toBe(true);

    const pendingForLength = [
      {
        variable,
        node: callback,
        method: "map",
        awaited: false,
        returned: false,
      },
    ];
    markReturnedPendingMaps(
      sourceCode,
      {
        type: "ReturnStatement",
        argument: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "mapped" },
          property: { type: "Identifier", name: "length" },
        },
      },
      pendingForLength,
    );
    expect(pendingForLength[0].returned).toBe(false);
  });
});
