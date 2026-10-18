import {
  createReactStateTracker,
  frameStatePayload,
  lifecycleProof,
  sourceShardProof,
} from "./projection/react-state.ts";
import { emitSemanticFact } from "../policy/lib/semantic-facts.mjs";
import {
  asyncArrayCallbackClassification,
  findVariable,
  isDirectlyWrappedInPromiseCombinator,
  isReturnedExpression,
  markAwaitedPendingMaps,
  markReturnedPendingMaps,
  queuePendingAsyncMap,
} from "./kernel/async-control-flow.ts";
import { createAuthBoundaryTracker } from "./boundary/auth-boundary.ts";
import { canonicalStatusLiteralOwner } from "./shape/status-literal.ts";
import {
  getFunctionNode,
  isFunctionLike,
  memberNodeTypes,
} from "./kernel/syntax-function.ts";
import { unwrapExpression } from "./kernel/syntax-node.ts";

const exportedLocalNamesByProgram = new WeakMap();

function getFunctionName(node) {
  if (node.type === "FunctionDeclaration") return node.id?.name ?? "";
  if (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return node.id?.name ?? "";
  }
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
    return node.id.name;
  }
  if (memberNodeTypes.has(node.type)) {
    const key = node.key;
    if (key?.type === "Identifier" || key?.type === "PrivateIdentifier") {
      return key.name;
    }
    if (key?.type === "Literal" && typeof key.value === "string") {
      return key.value;
    }
  }
  return "";
}

function declarationName(node) {
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
    return node.id.name;
  }
  if (
    (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
    node.id?.type === "Identifier"
  ) {
    return node.id.name;
  }
  return getFunctionName(node);
}

function programNode(node) {
  let cur = node;
  while (cur?.parent) cur = cur.parent;
  return cur?.type === "Program" ? cur : null;
}

function exportedLocalNames(program) {
  if (!program) return new Set();
  const cached = exportedLocalNamesByProgram.get(program);
  if (cached) return cached;
  const names = new Set();
  for (const statement of program?.body ?? []) {
    if (statement.type === "ExportNamedDeclaration") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.local?.type === "Identifier") {
          names.add(specifier.local.name);
        }
      }
    } else if (
      statement.type === "ExportDefaultDeclaration" &&
      statement.declaration?.type === "Identifier"
    ) {
      names.add(statement.declaration.name);
    }
  }
  exportedLocalNamesByProgram.set(program, names);
  return names;
}

function isExported(node) {
  if (
    node.parent?.type === "ExportNamedDeclaration" ||
    node.parent?.type === "ExportDefaultDeclaration"
  ) {
    return true;
  }
  const name = declarationName(node);
  return Boolean(name && exportedLocalNames(programNode(node)).has(name));
}

function enclosingClassExported(memberNode) {
  const classNode = memberNode.parent?.parent; // member → ClassBody → Class
  if (
    classNode?.type !== "ClassDeclaration" &&
    classNode?.type !== "ClassExpression"
  ) {
    return false;
  }
  if (
    classNode.parent?.type === "ExportNamedDeclaration" ||
    classNode.parent?.type === "ExportDefaultDeclaration"
  ) {
    return true;
  }
  // export const X = class { ... }
  return (
    classNode.parent?.type === "VariableDeclarator" &&
    classNode.parent.parent?.parent?.type === "ExportNamedDeclaration"
  );
}

// `value satisfies T` and `value as T` keep `value` owned by the enclosing
// declaration; return the outermost such wrapper so callers can read its owner.
function outermostTypeWrapper(node) {
  let cur = node;
  while (
    (cur.parent?.type === "TSSatisfiesExpression" ||
      cur.parent?.type === "TSAsExpression") &&
    cur.parent.expression === cur
  ) {
    cur = cur.parent;
  }
  return cur;
}

function enclosingObjectExported(memberNode) {
  const objectNode = memberNode.parent;
  if (objectNode?.type !== "ObjectExpression") return false;
  const owned = outermostTypeWrapper(objectNode);
  if (owned.parent?.type === "ExportDefaultDeclaration") return true;
  return (
    owned.parent?.type === "VariableDeclarator" &&
    owned.parent.init === owned &&
    isBoundary(owned.parent)
  );
}

function enclosingReturnedObjectFromBoundary(memberNode) {
  const objectNode = memberNode.parent;
  if (objectNode?.type !== "ObjectExpression") return false;
  if (
    objectNode.parent?.type === "ArrowFunctionExpression" &&
    objectNode.parent.body === objectNode
  ) {
    const arrowParent = objectNode.parent.parent;
    if (arrowParent?.type === "VariableDeclarator") {
      return isBoundary(arrowParent);
    }
    return isBoundary(objectNode.parent);
  }
  if (objectNode.parent?.type !== "ReturnStatement") return false;
  let cur = objectNode.parent.parent;
  while (cur) {
    if (cur.type === "FunctionDeclaration") return isBoundary(cur);
    if (
      (cur.type === "FunctionExpression" ||
        cur.type === "ArrowFunctionExpression") &&
      cur.parent?.type === "VariableDeclarator"
    ) {
      return isBoundary(cur.parent);
    }
    if (memberNodeTypes.has(cur.type)) return isBoundary(cur);
    cur = cur.parent;
  }
  return false;
}

function functionBoundaryNode(fn) {
  if (fn?.type === "FunctionDeclaration") return fn;
  if (
    fn?.type === "FunctionExpression" ||
    fn?.type === "ArrowFunctionExpression"
  ) {
    const owned = outermostTypeWrapper(fn);
    if (
      owned.parent?.type === "VariableDeclarator" &&
      owned.parent.init === owned
    ) {
      return owned.parent;
    }
  }
  if (fn && memberNodeTypes.has(fn.parent?.type)) return fn.parent;
  return fn;
}

function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      cur.type === "FunctionDeclaration" ||
      cur.type === "FunctionExpression" ||
      cur.type === "ArrowFunctionExpression"
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function objectExpressionExposesIdentifier(objectNode, name) {
  return (
    objectNode?.type === "ObjectExpression" &&
    objectNode.properties.some((property) => {
      if (property.type !== "Property") return false;
      if (
        property.value?.type === "Identifier" &&
        property.value.name === name
      ) {
        return true;
      }
      return (
        property.shorthand &&
        property.key?.type === "Identifier" &&
        property.key.name === name
      );
    })
  );
}

function returnedObjectExposesIdentifier(fn, name) {
  if (fn?.body?.type === "ObjectExpression") {
    return objectExpressionExposesIdentifier(fn.body, name);
  }
  if (fn?.body?.type !== "BlockStatement") return false;
  return fn.body.body.some(
    (statement) =>
      statement.type === "ReturnStatement" &&
      objectExpressionExposesIdentifier(
        unwrapExpression(statement.argument),
        name
      )
  );
}

function callableReturnedFromBoundaryFactory(node) {
  const name = node.id?.type === "Identifier" ? node.id.name : null;
  if (!name) return false;
  const fn = getFunctionNode(node);
  if (!fn) return false;
  const owner = enclosingFunction(node);
  if (!owner || !isBoundary(functionBoundaryNode(owner))) return false;
  return returnedObjectExposesIdentifier(owner, name);
}

export function isBoundary(node) {
  if (!memberNodeTypes.has(node.type)) {
    if (isExported(node)) return true;
    if (
      (node.type === "VariableDeclarator" ||
        node.type === "FunctionDeclaration") &&
      callableReturnedFromBoundaryFactory(node)
    ) {
      return true;
    }
    return (
      node.type === "VariableDeclarator" &&
      node.parent?.parent?.type === "ExportNamedDeclaration"
    );
  }
  if (
    node.kind === "get" ||
    node.kind === "set" ||
    node.kind === "constructor"
  ) {
    return true;
  }
  if (node.type === "Property") {
    return (
      enclosingObjectExported(node) || enclosingReturnedObjectFromBoundary(node)
    );
  }
  if (
    node.key?.type === "PrivateIdentifier" ||
    node.accessibility === "private" ||
    node.accessibility === "protected"
  ) {
    return false;
  }
  return enclosingClassExported(node);
}

function functionForImplementationParameter(param) {
  const maybeFunction = param?.parent;
  return isFunctionLike(maybeFunction) && maybeFunction.body
    ? maybeFunction
    : null;
}

function isBoundaryObjectMethod(fn) {
  const property = fn?.parent;
  return (
    property?.type === "Property" &&
    property.value === fn &&
    (enclosingObjectExported(property) ||
      enclosingReturnedObjectFromBoundary(property))
  );
}

function collectJsxLocals(statement, jsxLocals) {
  if (statement.type !== "VariableDeclaration") return;
  for (const declaration of statement.declarations) {
    if (
      declaration.id?.type === "Identifier" &&
      containsJsxNode(declaration.init)
    ) {
      jsxLocals.add(declaration.id.name);
    }
  }
}

function returnsJsxExpression(statement, jsxLocals) {
  if (statement.type !== "ReturnStatement") return false;
  if (containsJsxNode(statement.argument)) return true;
  return Boolean(
    statement.argument?.type === "Identifier" &&
    jsxLocals.has(statement.argument.name)
  );
}

function statementsReturnJsx(statements, outerJsxLocals) {
  const jsxLocals = new Set(outerJsxLocals);
  for (const statement of statements) {
    collectJsxLocals(statement, jsxLocals);
    if (statementReturnsJsx(statement, jsxLocals)) return true;
  }
  return false;
}

// Follows nested control flow to its return statements; nested functions own
// their own returns and are not statements here, so they are never entered.
function statementReturnsJsx(statement, jsxLocals) {
  switch (statement?.type) {
    case "ReturnStatement":
      return returnsJsxExpression(statement, jsxLocals);
    case "BlockStatement":
      return statementsReturnJsx(statement.body, jsxLocals);
    case "IfStatement":
      return (
        statementReturnsJsx(statement.consequent, jsxLocals) ||
        statementReturnsJsx(statement.alternate, jsxLocals)
      );
    case "SwitchStatement":
      return statement.cases.some((switchCase) =>
        statementsReturnJsx(switchCase.consequent, jsxLocals)
      );
    case "TryStatement":
      return (
        statementReturnsJsx(statement.block, jsxLocals) ||
        statementReturnsJsx(statement.handler?.body, jsxLocals) ||
        statementReturnsJsx(statement.finalizer, jsxLocals)
      );
    case "LabeledStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
      return statementReturnsJsx(statement.body, jsxLocals);
    default:
      return false;
  }
}

export function functionReturnsJsx(fn) {
  if (fn?.body?.type !== "BlockStatement") return containsJsxNode(fn?.body);
  return statementsReturnJsx(fn.body.body, new Set());
}

function isExportedFunctionBoundary(fn) {
  const owner = functionBoundaryNode(fn);
  if (!owner) return false;
  // isBoundary treats every constructor and accessor as a boundary; this rule
  // only guards members of classes that leave the module.
  if (owner.type === "MethodDefinition" && !memberOfExportedClass(owner)) {
    return false;
  }
  return isBoundary(owner);
}

function memberOfExportedClass(memberNode) {
  const classNode = memberNode.parent?.parent;
  return (
    enclosingClassExported(memberNode) ||
    (classNode?.type === "ClassDeclaration" && isExported(classNode))
  );
}

export function inlineStructuralTypeAtBoundary(node) {
  const parent = node.parent;
  const param = parent?.parent;
  if (parent?.type !== "TSTypeAnnotation" || !param) return false;

  const fn = functionForImplementationParameter(param);
  if (!fn) return false;
  if (functionReturnsJsx(fn)) return false;

  return isBoundaryObjectMethod(fn) || isExportedFunctionBoundary(fn);
}

function sourceShardPayload(proof) {
  return {
    source: proof.source,
    members: proof.entries.map(({ setter, cell, property }) => ({
      setter,
      cell,
      property,
    })),
    editableCells: proof.editableCells,
    transition: Boolean(proof.transition),
    requestGuard: Boolean(proof.requestGuard),
  };
}

export function ruleNoHandrolledResourceLifecycleCells() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow hand-rolled resource-lifecycle state machines: an async transition that toggles a boolean lifecycle cell, resets and assigns an error cell, and assigns an awaited resource cell. Broad multi-setter co-mutation and source-member state sharding are inventory only, never blocking.",
      },
      schema: [
        {
          type: "object",
          properties: {
            threshold: { type: "number" },
            shardThreshold: { type: "number" },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const options = context.options[0] ?? {};
      const threshold = options.threshold ?? 3;
      const shardThreshold = options.shardThreshold ?? 2;
      const tracker = createReactStateTracker({
        context,
        onFrameExit(frame) {
          if (frame.setters.size > 0) {
            const shardProof = sourceShardProof(frame, {
              threshold: shardThreshold,
            });
            if (shardProof.proven) {
              emitSemanticFact(context, shardProof.node ?? frame.node, {
                factKind: "sourceMemberStateShardCandidate",
                ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
                adapterId: "react-state",
                confidence: "heuristic-inventory",
                provenance: ["AST", "scope-binding", "control-flow"],
                payload: sourceShardPayload(shardProof),
              });
            }
          }
          const proof = frame.isTransition
            ? lifecycleProof(frame)
            : { proven: false };
          if (proof.proven && !frame.requestGuard) {
            emitSemanticFact(context, frame.node, {
              factKind: "resourceLifecycleProof",
              ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
              adapterId: "react-state",
              confidence: "deterministic-enforcement",
              provenance: ["AST", "scope-binding", "control-flow"],
              payload: {
                boolCell: proof.boolCell,
                errorCell: proof.errorCell,
                payloadCell: proof.payloadCell,
                ...frameStatePayload(frame),
              },
            });
            context.report({
              node: frame.node,
              message:
                "This async transition hand-rolls a resource lifecycle: a constant lifecycle cell is toggled around the request while sibling cells receive the resource value and caught error. Model one resource/reducer value instead of coupled setters.",
            });
            return;
          }
          if (frame.called.size >= threshold) {
            emitSemanticFact(context, frame.node, {
              factKind: "broadSetterCoMutation",
              ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
              adapterId: "react-state",
              confidence: "heuristic-inventory",
              provenance: ["AST", "scope-binding"],
              payload: frameStatePayload(frame),
            });
          }
        },
      });
      return tracker.visitors;
    },
  };
}

function isUnshadowedGlobalName(sourceCode, identifier, name) {
  if (identifier?.type !== "Identifier" || identifier.name !== name) {
    return false;
  }
  const variable = findVariable(sourceCode, identifier);
  return !variable || variable.defs.length === 0;
}

function isGlobalFetchCall(sourceCode, callee) {
  if (callee?.type === "Identifier") {
    return isUnshadowedGlobalName(sourceCode, callee, "fetch");
  }
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  const propertyName =
    callee.property?.type === "Identifier" ? callee.property.name : "";
  return (
    propertyName === "fetch" &&
    ["globalThis", "window", "self"].some((name) =>
      isUnshadowedGlobalName(sourceCode, callee.object, name)
    )
  );
}

function containsJsxNode(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true;
  if (isFunctionLike(node)) return false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value) && value.some((item) => containsJsxNode(item))) {
      return true;
    }
    if (value?.type && containsJsxNode(value)) return true;
  }
  return false;
}

export function ruleNoRawFetchInComponent() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow raw fetch calls inside React components.",
      },
      schema: [],
    },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const stack = [];
      function enterFunction(node) {
        stack.push({
          returnsJsx:
            node.type === "ArrowFunctionExpression" &&
            containsJsxNode(node.body),
          fetches: [],
          jsxLocals: new Set(),
        });
      }
      function exitFunction() {
        const frame = stack.pop();
        if (!frame) return;
        if (!frame.returnsJsx) {
          stack[stack.length - 1]?.fetches.push(...frame.fetches);
          return;
        }
        for (const node of frame.fetches) {
          context.report({
            node,
            message:
              "Do not call raw fetch inside React components. Use an API client, loader, or query resource.",
          });
        }
      }

      return {
        FunctionDeclaration: enterFunction,
        "FunctionDeclaration:exit": exitFunction,
        FunctionExpression: enterFunction,
        "FunctionExpression:exit": exitFunction,
        ArrowFunctionExpression: enterFunction,
        "ArrowFunctionExpression:exit": exitFunction,
        VariableDeclarator(node) {
          const frame = stack[stack.length - 1];
          if (
            frame &&
            node.id?.type === "Identifier" &&
            containsJsxNode(node.init)
          ) {
            frame.jsxLocals.add(node.id.name);
          }
        },
        ReturnStatement(node) {
          if (stack.length === 0) return;
          const frame = stack[stack.length - 1];
          if (
            containsJsxNode(node.argument) ||
            (node.argument?.type === "Identifier" &&
              frame.jsxLocals.has(node.argument.name))
          ) {
            frame.returnsJsx = true;
          }
        },
        CallExpression(node) {
          if (isGlobalFetchCall(sourceCode, node.callee) && stack.length > 0) {
            const frame = stack[stack.length - 1];
            frame.fetches.push(node);
          }
        },
      };
    },
  };
}

function asyncMapMessage(method) {
  return `Wrap .${method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited.`;
}

function enabledAsyncArrayBranches(option) {
  return new Set(["never-await", ...(option?.branches ?? [])]);
}

export function ruleNoAsyncArrayMethod() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow async callbacks passed to array iteration methods that silently drop or mishandle the returned promises.",
      },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            branches: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: {
                enum: ["never-await", "requires-collection"],
              },
            },
          },
        },
      ],
    },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const pendingAsyncMaps = [];
      const enabledBranches = enabledAsyncArrayBranches(context.options[0]);
      return {
        "Program:exit"() {
          for (const pending of pendingAsyncMaps) {
            if (!pending.awaited && !pending.returned) {
              context.report({
                node: pending.node,
                message: asyncMapMessage(pending.method),
              });
            }
          }
        },
        ReturnStatement(node) {
          markReturnedPendingMaps(sourceCode, node, pendingAsyncMaps);
        },
        CallExpression(node) {
          markAwaitedPendingMaps(sourceCode, node, pendingAsyncMaps);
          const classification = asyncArrayCallbackClassification(node);
          if (!classification) return;
          const { callback, method } = classification;
          if (!enabledBranches.has(classification.kind)) return;
          if (classification.kind === "never-await") {
            context.report({
              node: callback,
              message: `.${method}() does not await its callback, so an async callback here runs unhandled. Use a for...of loop.`,
            });
            return;
          }
          if (classification.kind === "requires-collection") {
            if (isDirectlyWrappedInPromiseCombinator(node)) return;
            if (isReturnedExpression(node)) return;
            if (
              queuePendingAsyncMap(
                sourceCode,
                node,
                callback,
                method,
                pendingAsyncMaps
              )
            ) {
              return;
            }
            context.report({
              node: callback,
              message: asyncMapMessage(method),
            });
          }
        },
      };
    },
  };
}

export function ruleRequireAuthzCheck() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require an authorization/ownership check when a handler reads request params.",
      },
      schema: [
        {
          type: "object",
          properties: {
            authzFunctions: {
              type: "array",
              items: { type: "string", minLength: 1 },
              uniqueItems: true,
            },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const authzFunctions = context.options[0]?.authzFunctions ?? [];
      if (authzFunctions.length === 0) {
        return {};
      }
      const tracker = createAuthBoundaryTracker({
        authzFunctions,
        onFrameExit(frame) {
          if (frame.paramsAccess && !frame.sawAuthz) {
            context.report({
              node: frame.paramsAccess,
              message:
                "Handler reads request params without a configured authorization/ownership check.",
            });
          }
        },
      });
      return tracker.visitors;
    },
  };
}

function fileMatchesPath(filename, filePath) {
  return filename.replace(/\\/gu, "/").endsWith(filePath.replace(/\\/gu, "/"));
}

export function ruleNoStatusLiteralInType() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow re-declaring canonical domain status values as type literals outside the owning module (domain registry).",
      },
      schema: [
        {
          type: "object",
          properties: { statuses: { type: "object" } },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const statuses = context.options[0]?.statuses ?? {};
      if (Object.keys(statuses).length === 0) return {};
      const filename = context.filename ?? context.getFilename();
      return {
        TSLiteralType(node) {
          const owner = canonicalStatusLiteralOwner(node, statuses);
          if (!owner) return;
          if (fileMatchesPath(filename, owner.owner)) return;
          context.report({
            node,
            message: `String literal '${owner.value}' duplicates a canonical status from ${owner.owner}. Import the type instead.`,
          });
        },
      };
    },
  };
}
