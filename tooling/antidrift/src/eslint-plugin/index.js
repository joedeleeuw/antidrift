import { typeProps, collectCanonicalTypes, collectDomainCanonicalTypes, collectGeneratedCanonicalTypes, isObjectType, resolvesToDomainCanonicalType, resolvesToGeneratedType, resolvesToInstalledType, MIN_PROPS } from "../policy/lib/type-index.mjs";

const rawTailwindColorPattern = /\b(?:text|bg|border|ring)-(?:red|blue|green|yellow|gray|slate|zinc|neutral)-\d{2,3}\b/u;
const hoverTranslatePattern = /hover:-?translate-[xy]/u;
const arrayMethodsNeedingPromiseAll = new Set(["map", "flatMap"]);
const arrayMethodsNeverAsync = new Set(["filter", "forEach", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "sort"]);
const arrayTransformMethods = new Set(["map", "flatMap", "reduce"]);
const reactEffectHooks = new Set(["useEffect", "useLayoutEffect"]);
const zodParseMethods = new Set(["parse", "parseAsync"]);
const collectionMetadataMemberNames = new Set(["length", "size"]);
const defaultObviousTriggerWords = ["set", "assign", "increase", "increment", "decrease", "decrement", "counter", "return", "create", "update", "delete", "get", "call", "initialize", "define", "loop", "iterate", "check", "store", "save"];
const exportedLocalNamesByProgram = new WeakMap();
const structuralDerivationUtilities = new Set(["Omit", "Partial", "Pick", "Readonly", "Required"]);

const memberNodeTypes = new Set(["MethodDefinition", "PropertyDefinition", "Property"]);

function getFunctionName(node) {
  if (node.type === "FunctionDeclaration") return node.id?.name ?? "";
  if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return node.id?.name ?? "";
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") return node.id.name;
  if (memberNodeTypes.has(node.type)) {
    const key = node.key;
    if (key?.type === "Identifier" || key?.type === "PrivateIdentifier") return key.name;
    if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  }
  return "";
}

function declarationName(node) {
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") return node.id.name;
  if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id?.type === "Identifier") return node.id.name;
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
    if (statement.type !== "ExportNamedDeclaration") continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.type === "Identifier") names.add(specifier.local.name);
    }
  }
  exportedLocalNamesByProgram.set(program, names);
  return names;
}

function isExported(node) {
  if (node.parent?.type === "ExportNamedDeclaration" || node.parent?.type === "ExportDefaultDeclaration") return true;
  const name = declarationName(node);
  return Boolean(name && exportedLocalNames(programNode(node)).has(name));
}

function getFunctionNode(node) {
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return node;
  if (node.type === "VariableDeclarator") return node.init;
  // Class methods/fields and object members hold the function in `value`; ignore non-function fields.
  if (memberNodeTypes.has(node.type)) {
    const value = node.value;
    return value?.type === "FunctionExpression" || value?.type === "ArrowFunctionExpression" ? value : null;
  }
  return null;
}

function enclosingClassExported(memberNode) {
  const classNode = memberNode.parent?.parent; // member → ClassBody → Class
  if (classNode?.type !== "ClassDeclaration" && classNode?.type !== "ClassExpression") return false;
  if (classNode.parent?.type === "ExportNamedDeclaration" || classNode.parent?.type === "ExportDefaultDeclaration") return true;
  // export const X = class { ... }
  return classNode.parent?.type === "VariableDeclarator" && classNode.parent.parent?.parent?.type === "ExportNamedDeclaration";
}

function enclosingObjectExported(memberNode) {
  const objectNode = memberNode.parent;
  if (objectNode?.type !== "ObjectExpression") return false;
  if (objectNode.parent?.type === "ExportDefaultDeclaration") return true;
  return objectNode.parent?.type === "VariableDeclarator" && objectNode.parent.parent?.parent?.type === "ExportNamedDeclaration";
}

function enclosingReturnedObjectFromBoundary(memberNode) {
  const objectNode = memberNode.parent;
  if (objectNode?.type !== "ObjectExpression") return false;
  if (objectNode.parent?.type === "ArrowFunctionExpression" && objectNode.parent.body === objectNode) {
    const arrowParent = objectNode.parent.parent;
    if (arrowParent?.type === "VariableDeclarator") return isBoundary(arrowParent);
    return isBoundary(objectNode.parent);
  }
  if (objectNode.parent?.type !== "ReturnStatement") return false;
  let cur = objectNode.parent.parent;
  while (cur) {
    if (cur.type === "FunctionDeclaration") return isBoundary(cur);
    if ((cur.type === "FunctionExpression" || cur.type === "ArrowFunctionExpression") && cur.parent?.type === "VariableDeclarator") return isBoundary(cur.parent);
    if (memberNodeTypes.has(cur.type)) return isBoundary(cur);
    cur = cur.parent;
  }
  return false;
}

function functionBoundaryNode(fn) {
  if (fn?.type === "FunctionDeclaration") return fn;
  if ((fn?.type === "FunctionExpression" || fn?.type === "ArrowFunctionExpression") && fn.parent?.type === "VariableDeclarator") return fn.parent;
  if (fn && memberNodeTypes.has(fn.parent?.type)) return fn.parent;
  return fn;
}

function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "FunctionDeclaration" || cur.type === "FunctionExpression" || cur.type === "ArrowFunctionExpression") return cur;
    cur = cur.parent;
  }
  return null;
}

function objectExpressionExposesIdentifier(objectNode, name) {
  return objectNode?.type === "ObjectExpression" && objectNode.properties.some((property) => {
    if (property.type !== "Property") return false;
    if (property.value?.type === "Identifier" && property.value.name === name) return true;
    return property.shorthand && property.key?.type === "Identifier" && property.key.name === name;
  });
}

function returnedObjectExposesIdentifier(fn, name) {
  if (fn?.body?.type === "ObjectExpression") return objectExpressionExposesIdentifier(fn.body, name);
  if (fn?.body?.type !== "BlockStatement") return false;
  return fn.body.body.some((statement) =>
    statement.type === "ReturnStatement" && objectExpressionExposesIdentifier(unwrapExpression(statement.argument), name)
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

// A definition is a "boundary" (public contract, exempt from inference-appeasement rules) when it is
// an exported function/const, or a public method of an exported class. Private/protected/# members,
// and any member of a non-exported class, are internal. Getters/setters/constructors are never
// appeasement helpers. Abstract and interface signatures are different node types and never visited.
function isBoundary(node) {
  if (!memberNodeTypes.has(node.type)) {
    if (isExported(node)) return true;
    if ((node.type === "VariableDeclarator" || node.type === "FunctionDeclaration") && callableReturnedFromBoundaryFactory(node)) return true;
    return node.type === "VariableDeclarator" && node.parent?.parent?.type === "ExportNamedDeclaration";
  }
  if (node.kind === "get" || node.kind === "set" || node.kind === "constructor") return true;
  if (node.type === "Property") return enclosingObjectExported(node) || enclosingReturnedObjectFromBoundary(node);
  if (node.key?.type === "PrivateIdentifier" || node.accessibility === "private" || node.accessibility === "protected") return false;
  return enclosingClassExported(node);
}

function hasExplicitReturnType(fn) {
  return Boolean(fn?.returnType);
}

function unwrapExpression(expression) {
  if (expression?.type === "ChainExpression") return expression.expression;
  if (expression?.type === "TSAsExpression") return unwrapExpression(expression.expression);
  if (expression?.type === "TSNonNullExpression") return unwrapExpression(expression.expression);
  if (expression?.type === "TSSatisfiesExpression") return unwrapExpression(expression.expression);
  return expression;
}

function isMemberExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  return unwrapped?.type === "MemberExpression";
}

function isSingleReturnMemberExpression(fn) {
  if (!fn?.body) return false;
  if (isMemberExpression(fn.body)) return true;
  if (fn.body.type !== "BlockStatement") return false;
  const statements = fn.body.body;
  return statements.length === 1 && statements[0]?.type === "ReturnStatement" && isMemberExpression(statements[0].argument);
}

function returnedExpression(fn) {
  if (!fn?.body) return null;
  if (fn.body.type !== "BlockStatement") return unwrapExpression(fn.body);
  const statements = fn.body.body;
  if (statements.length !== 1 || statements[0]?.type !== "ReturnStatement") return null;
  return unwrapExpression(statements[0].argument);
}

function parameterName(param) {
  if (param?.type === "Identifier") return param.name;
  if (param?.type === "AssignmentPattern" && param.left?.type === "Identifier") return param.left.name;
  if (param?.type === "RestElement" && param.argument?.type === "Identifier") return param.argument.name;
  return null;
}

function assignmentTarget(node) {
  return node?.type === "AssignmentPattern" ? node.left : node;
}

function collectBindingNames(node, names) {
  const target = assignmentTarget(node);
  if (!target) return;
  if (target.type === "Identifier") {
    names.add(target.name);
    return;
  }
  if (target.type === "RestElement") {
    collectBindingNames(target.argument, names);
    return;
  }
  if (target.type === "ArrayPattern") {
    for (const element of target.elements ?? []) collectBindingNames(element, names);
    return;
  }
  if (target.type === "ObjectPattern") {
    collectObjectPatternBindingNames(target, names);
  }
}

function bindingIdentifierName(node) {
  const target = assignmentTarget(node);
  return target?.type === "Identifier" ? target.name : null;
}

function nestedObjectPattern(node) {
  const target = assignmentTarget(node);
  return target?.type === "ObjectPattern" ? target : null;
}

function collectObjectPatternBindingNames(pattern, names) {
  for (const property of pattern.properties ?? []) {
    const name = property.type === "RestElement" ? bindingIdentifierName(property.argument) : bindingIdentifierName(property.value);
    if (name) names.add(name);
    const nested = property.type === "Property" ? nestedObjectPattern(property.value) : null;
    if (nested) collectObjectPatternBindingNames(nested, names);
  }
}

function destructuredParameterBindingNames(fn) {
  const names = new Set();
  for (const param of fn.params ?? []) {
    const pattern = nestedObjectPattern(param);
    if (pattern) collectObjectPatternBindingNames(pattern, names);
  }
  return names;
}

function returnedIdentifierName(fn) {
  const expression = returnedExpression(fn);
  return expression?.type === "Identifier" ? expression.name : null;
}

function memberExpressionRootName(expression) {
  let cur = unwrapExpression(expression);
  while (cur?.type === "MemberExpression") cur = unwrapExpression(cur.object);
  return cur?.type === "Identifier" ? cur.name : null;
}

function terminalMemberName(expression) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped?.type !== "MemberExpression" || unwrapped.computed || unwrapped.property?.type !== "Identifier") return null;
  return unwrapped.property.name;
}

function returnsMemberOfOwnParameter(fn) {
  const params = new Set(fn.params.map(parameterName).filter(Boolean));
  const expression = returnedExpression(fn);
  if (expression?.type !== "MemberExpression") return false;
  const terminalName = terminalMemberName(expression);
  if (terminalName && collectionMetadataMemberNames.has(terminalName)) return false;
  const rootName = memberExpressionRootName(expression);
  return Boolean(rootName && params.has(rootName));
}

function returnsDestructuredOwnParameterBinding(fn) {
  const name = returnedIdentifierName(fn);
  return Boolean(name && destructuredParameterBindingNames(fn).has(name));
}

function isTrivialSelectorWrapper(fn) {
  return (isSingleReturnMemberExpression(fn) && returnsMemberOfOwnParameter(fn))
    || returnsDestructuredOwnParameterBinding(fn);
}

function isReactComponentName(name) {
  return /^[A-Z]/u.test(name);
}

function isFunctionLike(node) {
  return node?.type === "FunctionDeclaration"
    || node?.type === "FunctionExpression"
    || node?.type === "ArrowFunctionExpression";
}

function functionNodeName(fn) {
  if (fn?.type === "FunctionDeclaration") return fn.id?.name ?? "";
  if ((fn?.type === "FunctionExpression" || fn?.type === "ArrowFunctionExpression") && fn.parent?.type === "VariableDeclarator" && fn.parent.id?.type === "Identifier") return fn.parent.id.name;
  if ((fn?.type === "FunctionExpression" || fn?.type === "ArrowFunctionExpression") && fn.parent?.type === "Property") {
    const key = fn.parent.key;
    if (key?.type === "Identifier" || key?.type === "PrivateIdentifier") return key.name;
    if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  }
  return "";
}

function functionForImplementationParameter(param) {
  const maybeFunction = param?.parent;
  return isFunctionLike(maybeFunction) && maybeFunction.body ? maybeFunction : null;
}

function isBoundaryObjectMethod(fn) {
  const property = fn?.parent;
  return property?.type === "Property"
    && property.value === fn
    && (enclosingObjectExported(property) || enclosingReturnedObjectFromBoundary(property));
}

function isExportedLowercaseFunction(fn) {
  const owner = fn?.type === "FunctionDeclaration" ? fn : fn?.parent;
  const name = functionNodeName(fn);
  return Boolean(name && !isReactComponentName(name) && owner && isBoundary(owner));
}

function inlineStructuralTypeAtBoundary(node) {
  const parent = node.parent;
  const param = parent?.parent;
  if (parent?.type !== "TSTypeAnnotation" || param?.type !== "Identifier") return false;

  const fn = functionForImplementationParameter(param);
  if (!fn) return false;

  const name = functionNodeName(fn);
  if (name && isReactComponentName(name)) return false;

  return isBoundaryObjectMethod(fn) || isExportedLowercaseFunction(fn);
}

function collectTemplateLiteralString(node, parts) {
  if (node.expressions.length === 0) parts.push(node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(""));
}

function collectConditionalStringParts(node, parts) {
  staticStringParts(node.consequent, parts);
  staticStringParts(node.alternate, parts);
}

function collectLogicalStringParts(node, parts) {
  staticStringParts(node.left, parts);
  staticStringParts(node.right, parts);
}

function collectArrayStringParts(node, parts) {
  for (const element of node.elements ?? []) staticStringParts(element, parts);
}

function collectCallStringParts(node, parts) {
  for (const arg of node.arguments ?? []) {
    if (arg.type !== "SpreadElement") staticStringParts(arg, parts);
  }
}

function collectObjectKeyStringParts(node, parts) {
  for (const property of node.properties ?? []) {
    if (property.type === "Property") staticStringParts(property.key, parts);
  }
}

function staticStringParts(node, parts = []) {
  if (!node) return parts;
  if (node.type === "Literal" && typeof node.value === "string") {
    parts.push(node.value);
    return parts;
  }
  const collectors = {
    ArrayExpression: collectArrayStringParts,
    CallExpression: collectCallStringParts,
    ConditionalExpression: collectConditionalStringParts,
    LogicalExpression: collectLogicalStringParts,
    ObjectExpression: collectObjectKeyStringParts,
    TemplateLiteral: collectTemplateLiteralString,
  };
  collectors[node.type]?.(node, parts);
  return parts;
}

function getJsxClassNameLiterals(node) {
  if (node.name?.name !== "className") return [];
  if (node.value?.type === "Literal") return staticStringParts(node.value);
  if (node.value?.type === "JSXExpressionContainer") return staticStringParts(node.value.expression);
  return [];
}

// Visit free functions, arrow consts, and class methods/fields uniformly — agents hide the same
// inference-appeasement patterns in any of these forms.
const callableVisitors = (check) => ({
  FunctionDeclaration: check,
  VariableDeclarator: check,
  MethodDefinition: check,
  PropertyDefinition: check,
  Property: check,
});

function ruleNoTrivialSelectorWrapper() {
  function check(node, context) {
    if (isBoundary(node)) return;
    const fn = getFunctionNode(node);
    if (!fn || !hasExplicitReturnType(fn)) return;
    if (isTrivialSelectorWrapper(fn)) {
      context.report({
        node,
        message: "Do not create a typed selector wrapper that only returns a property of its own parameter. Use inference directly or move the contract to the owned boundary.",
      });
    }
  }

  return {
    meta: { type: "problem", docs: { description: "Disallow typed selector wrappers that only restate property access." }, schema: [] },
    create(context) {
      return callableVisitors((node) => check(node, context));
    },
  };
}

function ruleNoInlineStructuralTypeAtUseSite() {
  return {
    meta: { type: "problem", docs: { description: "Disallow inline object type literals at use sites." }, schema: [] },
    create(context) {
      return {
        TSTypeLiteral(node) {
          if (inlineStructuralTypeAtBoundary(node)) {
            context.report({ node, message: "Do not define structural contracts at use sites. Import or create the owned named type." });
          }
        },
      };
    },
  };
}

function ruleNoUnsafeCastChain() {
  function isUnknownCast(node) {
    return node?.type === "TSAsExpression" && node.typeAnnotation?.type === "TSUnknownKeyword";
  }

  return {
    meta: { type: "problem", docs: { description: "Disallow as unknown as T cast tunnels." }, schema: [] },
    create(context) {
      return {
        TSAsExpression(node) {
          if (isUnknownCast(node.expression)) {
            context.report({ node, message: "Do not tunnel through unknown with `as unknown as T`. Validate, narrow, or fix the source type." });
          }
        },
      };
    },
  };
}

function ruleNoSilentCatch() {
  return {
    meta: { type: "problem", docs: { description: "Disallow silent catch blocks and console-only handling." }, schema: [] },
    create(context) {
      return {
        CatchClause(node) {
          const statements = node.body?.body ?? [];
          if (statements.length === 0) {
            context.report({ node, message: "Do not silently catch errors. Re-throw, return a typed failure, or log with structured context." });
            return;
          }
          const onlyConsole = statements.length === 1
            && statements[0].type === "ExpressionStatement"
            && statements[0].expression?.type === "CallExpression"
            && statements[0].expression.callee?.type === "MemberExpression"
            && statements[0].expression.callee.object?.name === "console";
          if (onlyConsole) {
            context.report({ node: statements[0], message: "Console logging alone is not error handling. Propagate or return a typed failure." });
          }
        },
      };
    },
  };
}

function ruleNoCoupledStateSetters() {
  return {
    meta: { type: "problem", docs: { description: "Disallow functions that mutate many useState setters." }, schema: [{ type: "object", properties: { threshold: { type: "number" } }, additionalProperties: false }] },
    create(context) {
      const threshold = context.options[0]?.threshold ?? 3;
      // ownedSetters: setters declared by each frame (the component that owns them).
      // calledSetters: setters called within each frame.
      // On exit, a handler frame reports if it calls >= threshold setters that belong to an ancestor.
      // This scopes correctly: setters from ComponentA don't appear as ancestors when checking ComponentB.
      const functionStack = [];

      function enterFunction(node) { functionStack.push({ node, ownedSetters: new Set(), calledSetters: new Set() }); }
      function exitFunction() {
        const frame = functionStack.pop();
        if (!frame) return;
        const ancestorSetters = new Set();
        for (const f of functionStack) {
          for (const s of f.ownedSetters) ancestorSetters.add(s);
        }
        const calledAncestor = [...frame.calledSetters].filter((name) => ancestorSetters.has(name));
        if (calledAncestor.length >= threshold) {
          context.report({ node: frame.node, message: `This function updates ${calledAncestor.length} state cells. Model one transition with a reducer/resource instead.` });
        }
      }

      return {
        VariableDeclarator(node) {
          if (node.init?.type !== "CallExpression" || node.init.callee?.name !== "useState") return;
          if (node.id?.type !== "ArrayPattern") return;
          const setter = node.id.elements?.[1];
          if (setter?.type === "Identifier" && functionStack.length > 0) {
            functionStack[functionStack.length - 1].ownedSetters.add(setter.name);
          }
        },
        FunctionDeclaration: enterFunction,
        "FunctionDeclaration:exit": exitFunction,
        FunctionExpression: enterFunction,
        "FunctionExpression:exit": exitFunction,
        ArrowFunctionExpression: enterFunction,
        "ArrowFunctionExpression:exit": exitFunction,
        CallExpression(node) {
          const calleeName = node.callee?.type === "Identifier" ? node.callee.name : null;
          if (calleeName && functionStack.length > 0) {
            functionStack[functionStack.length - 1].calledSetters.add(calleeName);
          }
        },
      };
    },
  };
}

function ruleNoStatusTripletState() {
  return {
    meta: {
      type: "problem",
      docs: { description: "Disallow data/loading/error state triplets." },
      schema: [{
        type: "object",
        properties: {
          dataNames: { type: "array", items: { type: "string" } },
          loadingNames: { type: "array", items: { type: "string" } },
          errorNames: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      }],
    },
    create(context) {
      const opts = context.options[0] ?? {};
      const lowerSet = (values) => new Set(values.map((value) => value.toLowerCase()));
      const dataNames = lowerSet(opts.dataNames ?? ["data", "result", "user", "items"]);
      const loadingNames = lowerSet(opts.loadingNames ?? ["loading", "isLoading", "pending", "isPending"]);
      const errorNames = lowerSet(opts.errorNames ?? ["error", "loadError", "failure"]);
      const functionStack = [];
      function enterFunction(node) { functionStack.push({ node, names: new Set() }); }
      function exitFunction() {
        const frame = functionStack.pop();
        if (!frame) return;
        const names = [...frame.names].map((name) => name.toLowerCase());
        const hasData = names.some((name) => dataNames.has(name));
        const hasLoading = names.some((name) => loadingNames.has(name));
        const hasError = names.some((name) => errorNames.has(name));
        if (hasData && hasLoading && hasError) {
          context.report({ node: frame.node, message: "Do not model async lifecycle as separate data/loading/error state cells. Use one reducer/resource value." });
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
          if (functionStack.length === 0) return;
          const init = node.init;
          if (init?.type !== "CallExpression" || init.callee?.name !== "useState") return;
          if (node.id?.type !== "ArrayPattern") return;
          const name = node.id.elements?.[0];
          if (name?.type === "Identifier") functionStack[functionStack.length - 1].names.add(name.name);
        },
      };
    },
  };
}

function ruleRequireEffectDeps() {
  return {
    meta: { type: "problem", docs: { description: "Require a dependency array for React effect hooks. A missing array runs the effect on every render — usually an agent oversight, and one exhaustive-deps does not flag (it only validates an array that already exists)." }, schema: [] },
    create(context) {
      // Local names that resolve to a React effect hook: imported/aliased bare names, plus default
      // and namespace import names accessed as `React.useEffect`. Only react imports are tracked.
      const directNames = new Set();
      const namespaceNames = new Set();
      return {
        ImportDeclaration(node) {
          if (node.source.value !== "react") return;
          for (const spec of node.specifiers) {
            if (spec.type === "ImportSpecifier" && reactEffectHooks.has(spec.imported.name)) {
              directNames.add(spec.local.name);
            } else if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
              namespaceNames.add(spec.local.name);
            }
          }
        },
        CallExpression(node) {
          const callee = node.callee;
          let hookName = null;
          if (callee.type === "Identifier" && directNames.has(callee.name)) {
            hookName = callee.name;
          } else if (
            callee.type === "MemberExpression" && !callee.computed &&
            callee.object.type === "Identifier" && callee.property.type === "Identifier" &&
            namespaceNames.has(callee.object.name) && reactEffectHooks.has(callee.property.name)
          ) {
            hookName = callee.property.name;
          }
          if (hookName && node.arguments.length < 2) {
            context.report({ node, message: `${hookName} must be called with a dependency array. Without it the effect runs on every render — pass [] or the real dependencies.` });
          }
        },
      };
    },
  };
}

function ruleClassNamePattern(name, pattern, message) {
  return {
    meta: { type: "problem", docs: { description: message }, schema: [] },
    create(context) {
      return {
        JSXAttribute(node) {
          if (getJsxClassNameLiterals(node).some((className) => pattern.test(className))) {
            context.report({ node, message });
          }
        },
      };
    },
  };
}

function ruleNoRawFetchInComponent() {
  return {
    meta: { type: "problem", docs: { description: "Disallow raw fetch calls inside React components." }, schema: [] },
    create(context) {
      const filename = context.filename ?? context.getFilename();
      const isComponentModule = /\.(?:jsx|tsx)$/u.test(filename);
      const stack = [];
      const moduleFetches = [];
      const reportedFetches = new WeakSet();
      let sawJsxInFile = false;
      function enterFunction(node) { stack.push({ node, name: getFunctionName(node), sawJsx: false, sawFetch: null }); }
      function reportFetch(node, message) {
        if (reportedFetches.has(node)) return;
        reportedFetches.add(node);
        context.report({ node, message });
      }
      function exitFunction() {
        const frame = stack.pop();
        if (frame?.sawFetch && (frame.sawJsx || isReactComponentName(frame.name))) {
          reportFetch(frame.sawFetch, "Do not call raw fetch inside React components. Use an API client, loader, or query resource.");
        }
      }

      return {
        FunctionDeclaration: enterFunction,
        "FunctionDeclaration:exit": exitFunction,
        FunctionExpression: enterFunction,
        "FunctionExpression:exit": exitFunction,
        ArrowFunctionExpression: enterFunction,
        "ArrowFunctionExpression:exit": exitFunction,
        JSXElement() {
          sawJsxInFile = true;
          if (stack.length > 0) stack[stack.length - 1].sawJsx = true;
        },
        CallExpression(node) {
          if (node.callee?.type === "Identifier" && node.callee.name === "fetch" && stack.length > 0) {
            const frame = stack[stack.length - 1];
            frame.sawFetch = node;
            if (!isReactComponentName(frame.name)) moduleFetches.push(node);
          }
        },
        "Program:exit"() {
          if (!isComponentModule || !sawJsxInFile) return;
          for (const node of moduleFetches) {
            reportFetch(node, "Do not call raw fetch inside React component modules. Move transport logic to an API client, loader, or query resource.");
          }
        },
      };
    },
  };
}

function isPromiseCombinator(callee) {
  return callee?.type === "MemberExpression"
    && callee.object?.type === "Identifier"
    && callee.object.name === "Promise"
    && callee.property?.type === "Identifier"
    && (callee.property.name === "all" || callee.property.name === "allSettled" || callee.property.name === "race");
}

function getDeclaredVariable(sourceCode, declarator) {
  if (declarator.id?.type !== "Identifier") return null;
  return sourceCode.scopeManager?.getDeclaredVariables(declarator).find((variable) => variable.name === declarator.id.name) ?? null;
}

function findVariable(sourceCode, identifier) {
  if (identifier?.type !== "Identifier" || typeof sourceCode.getScope !== "function") return null;
  let scope = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set?.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

function promiseCombinatorVariables(sourceCode, node) {
  if (!isPromiseCombinator(node.callee)) return [];
  return node.arguments.flatMap((arg) => {
    if (arg.type === "Identifier") {
      const variable = findVariable(sourceCode, arg);
      return variable ? [variable] : [];
    }
    if (arg.type === "SpreadElement" && arg.argument.type === "Identifier") {
      const variable = findVariable(sourceCode, arg.argument);
      return variable ? [variable] : [];
    }
    return [];
  });
}

function asyncCallbackArgument(node) {
  const cb = node.arguments?.[0];
  return (cb?.type === "ArrowFunctionExpression" || cb?.type === "FunctionExpression") && cb.async === true ? cb : null;
}

function markAwaitedPendingMaps(sourceCode, node, pendingAsyncMaps) {
  const variables = promiseCombinatorVariables(sourceCode, node);
  for (const variable of variables) {
    for (const pending of pendingAsyncMaps) {
      if (pending.variable === variable) pending.awaited = true;
    }
  }
}

function isDirectlyWrappedInPromiseCombinator(node) {
  const parent = node.parent;
  return parent?.type === "CallExpression" && isPromiseCombinator(parent.callee) && parent.arguments.includes(node);
}

function queuePendingAsyncMap(sourceCode, node, cb, method, pendingAsyncMaps) {
  const parent = node.parent;
  if (parent?.type !== "VariableDeclarator") return false;
  const variable = getDeclaredVariable(sourceCode, parent);
  if (!variable) return false;
  pendingAsyncMaps.push({ variable, node: cb, method, awaited: false });
  return true;
}

function asyncMapMessage(method) {
  return `Wrap .${method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited.`;
}

function ruleNoAsyncArrayMethod() {
  return {
    meta: { type: "problem", docs: { description: "Disallow async callbacks passed to array iteration methods that silently drop or mishandle the returned promises." }, schema: [] },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const pendingAsyncMaps = [];
      return {
        "Program:exit"() {
          for (const pending of pendingAsyncMaps) {
            if (!pending.awaited) {
              context.report({ node: pending.node, message: asyncMapMessage(pending.method) });
            }
          }
        },
        CallExpression(node) {
          markAwaitedPendingMaps(sourceCode, node, pendingAsyncMaps);
          const callee = node.callee;
          if (callee?.type !== "MemberExpression" || callee.property?.type !== "Identifier") return;
          const method = callee.property.name;
          const cb = asyncCallbackArgument(node);
          if (!cb) return;
          if (arrayMethodsNeverAsync.has(method)) {
            context.report({ node: cb, message: `.${method}() does not await its callback, so an async callback here runs unhandled. Use a for...of loop.` });
            return;
          }
          if (arrayMethodsNeedingPromiseAll.has(method)) {
            if (isDirectlyWrappedInPromiseCombinator(node)) return;
            if (queuePendingAsyncMap(sourceCode, node, cb, method, pendingAsyncMaps)) return;
            context.report({ node: cb, message: asyncMapMessage(method) });
          }
        },
      };
    },
  };
}

function extractCommentWords(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, " ").split(/\s+/u).filter(Boolean);
}

function collectNodeTokens(node, out) {
  if (!node || typeof node.type !== "string") return;
  // Identifier-only: string literals (e.g. rule-name keys in config) cause false positives on explanatory comments.
  if (node.type === "Identifier" && typeof node.name === "string") out.add(node.name.toLowerCase());
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const child of value) collectNodeTokens(child, out);
    } else if (value && typeof value.type === "string") {
      collectNodeTokens(value, out);
    }
  }
}

function findEnclosingStatement(node) {
  let cur = node;
  while (cur?.parent) {
    // Stop at Property/PropertyDefinition too: a comment before an object member is adjacent to that
    // member, not the whole enclosing statement — otherwise large config objects over-collect tokens.
    if (cur.type.endsWith("Statement") || cur.type === "VariableDeclaration" || cur.type === "Property" || cur.type === "PropertyDefinition") return cur;
    cur = cur.parent;
  }
  return node;
}

const obviousCommentSkipPattern = /^\s*(eslint|ts-|@ts-|prettier|global|c8|istanbul|biome|v8)/u;

function statementAfterComment(sourceCode, comment) {
  const nextToken = sourceCode.getTokenAfter(comment, { includeComments: false });
  if (!nextToken || nextToken.loc.start.line - comment.loc.end.line > 1) return null;
  const node = sourceCode.getNodeByRangeIndex(nextToken.range[0]);
  return node ? findEnclosingStatement(node) : null;
}

function countOverlap(commentWords, statement) {
  const tokens = new Set();
  collectNodeTokens(statement, tokens);
  let overlap = 0;
  for (const word of commentWords) if (tokens.has(word)) overlap += 1;
  return overlap;
}

function ruleNoObviousComment() {
  return {
    meta: {
      type: "suggestion",
      docs: { description: "Disallow comments that restate what the adjacent statement already expresses." },
      schema: [{ type: "object", properties: { triggerWords: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const opts = context.options[0] ?? {};
      const triggerWords = new Set((opts.triggerWords ?? defaultObviousTriggerWords).map((word) => word.toLowerCase()));

      function isObvious(comment) {
        if (comment.type !== "Line") return false;
        if (obviousCommentSkipPattern.test(comment.value)) return false;
        const statement = statementAfterComment(sourceCode, comment);
        if (!statement) return false;
        const commentWords = new Set(extractCommentWords(comment.value));
        if (commentWords.size === 0) return false;
        const overlap = countOverlap(commentWords, statement);
        if (overlap === 0) return false;
        const hasTrigger = [...commentWords].some((word) => triggerWords.has(word));
        return hasTrigger;
      }

      return {
        "Program:exit"() {
          for (const comment of sourceCode.getAllComments()) {
            if (isObvious(comment)) {
              context.report({ loc: comment.loc, message: "Comment restates the adjacent code. Explain why, not what — or remove it." });
            }
          }
        },
      };
    },
  };
}


const sqlPattern = /\b(?:SELECT\b[\s\S]{0,200}?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w."`]+\s+SET\b|DELETE\s+FROM\b|DROP\s+TABLE\b)/iu;

function templateText(node) {
  return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw ?? "").join(" ");
}

function ruleNoSqlStringConcat() {
  return {
    meta: { type: "problem", docs: { description: "Disallow SQL assembled via string interpolation or concatenation." }, schema: [] },
    create(context) {
      return {
        TemplateLiteral(node) {
          if (node.expressions.length > 0 && sqlPattern.test(templateText(node))) {
            context.report({ node, message: "Do not interpolate values into SQL strings. Use parameterized queries / bound parameters." });
          }
        },
        BinaryExpression(node) {
          if (node.operator !== "+") return;
          const sides = [node.left, node.right];
          const hasSqlLiteral = sides.some((side) => side?.type === "Literal" && typeof side.value === "string" && sqlPattern.test(side.value));
          const hasNonLiteral = sides.some((side) => side && side.type !== "Literal");
          if (hasSqlLiteral && hasNonLiteral) {
            context.report({ node, message: "Do not concatenate values into SQL strings. Use parameterized queries / bound parameters." });
          }
        },
      };
    },
  };
}

function ruleNoUnsafeDeserialize() {
  return {
    meta: { type: "problem", docs: { description: "Disallow JSON.parse on any/unknown values without validation." }, schema: [] },
    create(context) {
      const services = context.sourceCode?.parserServices ?? context.parserServices;
      if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
      const checker = services.program.getTypeChecker();

      return {
        CallExpression(node) {
          const callee = node.callee;
          const isJsonParse = callee?.type === "MemberExpression"
            && callee.object?.type === "Identifier" && callee.object.name === "JSON"
            && callee.property?.type === "Identifier" && callee.property.name === "parse";
          if (!isJsonParse) return;
          const tsArg = node.arguments[0] && services.esTreeNodeToTSNodeMap.get(node.arguments[0]);
          if (!tsArg) return;
          if (isAnyOrUnknownType(checker.getTypeAtLocation(tsArg))) {
            context.report({ node, message: "Do not JSON.parse any/unknown input directly. Validate through a schema boundary instead." });
          }
        },
      };
    },
  };
}

const defaultAuthzFunctions = ["requireUser", "authorize", "requireTenant", "can", "assertCan", "checkAccess", "requireRole", "ensureCan"];
const requestParamRoots = new Set(["req", "request", "ctx", "context", "event"]);

function callExpressionName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier") return callee.property.name;
  return null;
}

function ruleRequireAuthzCheck() {
  return {
    meta: { type: "problem", docs: { description: "Require an authorization/ownership check when a handler reads request params." }, schema: [{ type: "object", properties: { authzFunctions: { type: "array", items: { type: "string" } } }, additionalProperties: false }] },
    create(context) {
      const authz = new Set(context.options[0]?.authzFunctions ?? defaultAuthzFunctions);
      const stack = [];
      function enter(node) { stack.push({ node, paramsAccess: null, sawAuthz: false }); }
      function exit() {
        const frame = stack.pop();
        if (frame?.paramsAccess && !frame.sawAuthz) {
          context.report({ node: frame.paramsAccess, message: "Handler reads request params without an authorization/ownership check. Call requireUser/authorize (boundaries registry)." });
        }
      }
      return {
        FunctionDeclaration: enter,
        "FunctionDeclaration:exit": exit,
        FunctionExpression: enter,
        "FunctionExpression:exit": exit,
        ArrowFunctionExpression: enter,
        "ArrowFunctionExpression:exit": exit,
        MemberExpression(node) {
          if (node.property?.type === "Identifier" && node.property.name === "params"
            && node.object?.type === "Identifier" && requestParamRoots.has(node.object.name)
            && stack.length > 0) {
            stack[stack.length - 1].paramsAccess = node;
          }
        },
        CallExpression(node) {
          const name = callExpressionName(node.callee);
          if (name && authz.has(name) && stack.length > 0) {
            stack[stack.length - 1].sawAuthz = true;
          }
        },
      };
    },
  };
}

// Local type is a structural fork of a canonical type when every one of its resolved properties
// matches a canonical property by name AND type string (i.e. local ⊆ canonical). This fires on
// exact copies and subsets (drift) but never on supersets like `User & { tenantId }` — a real
// extension has extra properties not present in the canonical type, so it is not a subset.
function isStructuralFork(local, canonical) {
  for (const [name, typeStr] of local) {
    if (canonical.get(name) !== typeStr) return false;
  }
  return true;
}

// Canonical candidate list is cached per TypeScript Program (stable per ESLint process),
// so the node_modules enumeration runs once rather than per linted file.
const canonicalCache = new WeakMap();
const antidriftBrandMarkerName = "__antidriftBrand";
const TS_TYPE_FLAG_ANY = 1;
const TS_TYPE_FLAG_UNKNOWN = 1 << 1;
const TS_TYPE_FLAG_UNDEFINED = 1 << 15;
const TS_TYPE_FLAG_NULL = 1 << 16;

function typeReferenceName(typeNode) {
  if (typeNode?.typeName?.type === "Identifier") return typeNode.typeName.name;
  if (typeNode?.typeName?.type === "TSQualifiedName") return typeNode.typeName.right?.name ?? typeNode.typeName.left?.name ?? "";
  return "";
}

function typeReferenceArguments(typeNode) {
  return typeNode?.typeArguments?.params ?? typeNode?.typeParameters?.params ?? [];
}

function isDerivationSourceReference(typeNode) {
  return typeNode?.type === "TSTypeReference" || typeNode?.type === "TSImportType";
}

function isStructuralDerivationAlias(node) {
  if (node.type !== "TSTypeAliasDeclaration") return false;
  const annotation = node.typeAnnotation;
  if (annotation?.type === "TSTupleType") return true;
  if (annotation?.type !== "TSTypeReference") return false;
  if (!structuralDerivationUtilities.has(typeReferenceName(annotation))) return false;
  return isDerivationSourceReference(typeReferenceArguments(annotation)[0]);
}

function isAntidriftBrandMarkerProperty(prop) {
  for (const decl of prop.declarations ?? []) {
    const name = decl.name;
    const sourceFile = decl.getSourceFile?.().fileName.replace(/\\/gu, "/") ?? "";
    const isAntidriftDeclaration = sourceFile.endsWith("@joedeleeuw/antidrift/src/brand/index.d.mts")
      || sourceFile.endsWith("tooling/antidrift/src/brand/index.d.mts");
    if (!isAntidriftDeclaration) continue;
    if (name?.getText?.() === `[${antidriftBrandMarkerName}]`) return true;
  }
  return false;
}

function isAntidriftBrandedType(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if ((type.getProperties?.() ?? []).some(isAntidriftBrandMarkerProperty)) return true;
  const parts = type.types ?? [];
  return parts.some((part) => isAntidriftBrandedType(part, seen));
}

function isAnyOrUnknownType(type) {
  return Boolean(type && (type.flags & (TS_TYPE_FLAG_ANY | TS_TYPE_FLAG_UNKNOWN)));
}

function typeIncludesNullish(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (type.flags & (TS_TYPE_FLAG_NULL | TS_TYPE_FLAG_UNDEFINED)) return true;
  return (type.types ?? []).some((part) => typeIncludesNullish(part, seen));
}

function typeStringIncludesAnyOrUnknown(checker, type) {
  return /\b(?:any|unknown)\b/u.test(checker.typeToString(type));
}

function isNamedTypeReference(typeNode) {
  return typeNode?.type === "TSTypeReference";
}

function walkNode(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkNode(child, visit);
    } else if (value && typeof value.type === "string") {
      walkNode(value, visit);
    }
  }
}

function isNullishLiteral(node) {
  return node?.type === "Literal" && node.value === null
    || node?.type === "Identifier" && node.name === "undefined";
}

function hasParamRoot(expression, paramNames) {
  const root = memberExpressionRootName(expression);
  return Boolean(root && paramNames.has(root));
}

function isObjectLiteral(node) {
  return node?.type === "Literal" && node.value === "object";
}

function isTypeofObjectProbe(node, paramNames) {
  if (node.type !== "UnaryExpression" || node.operator !== "typeof" || !hasParamRoot(node.argument, paramNames)) return false;
  const parent = node.parent;
  if (parent?.type !== "BinaryExpression" || !["==", "===", "!=", "!=="].includes(parent.operator)) return false;
  return parent.left === node ? isObjectLiteral(parent.right) : isObjectLiteral(parent.left);
}

function isTypePredicateReturn(fn) {
  return fn?.returnType?.typeAnnotation?.type === "TSTypePredicate";
}

function countShapeProbesIn(node, paramNames) {
  let count = 0;
  walkNode(node, (node) => {
    if (isTypeofObjectProbe(node, paramNames)) {
      count += 1;
      return;
    }
    if (node.type === "BinaryExpression" && node.operator === "in" && hasParamRoot(node.right, paramNames)) {
      count += 1;
      return;
    }
    if (node.type === "BinaryExpression" && ["==", "===", "!=", "!=="].includes(node.operator)) {
      const leftIsProbe = hasParamRoot(node.left, paramNames) && isNullishLiteral(node.right);
      const rightIsProbe = hasParamRoot(node.right, paramNames) && isNullishLiteral(node.left);
      if (leftIsProbe || rightIsProbe) count += 1;
      return;
    }
    if (
      node.type === "CallExpression"
      && node.callee?.type === "MemberExpression"
      && node.callee.object?.type === "Identifier"
      && node.callee.object.name === "Array"
      && node.callee.property?.type === "Identifier"
      && node.callee.property.name === "isArray"
      && hasParamRoot(node.arguments?.[0], paramNames)
    ) {
      count += 1;
    }
  });
  return count;
}

function isObjectEntriesCall(node) {
  return node?.type === "CallExpression"
    && node.callee?.type === "MemberExpression"
    && node.callee.object?.type === "Identifier"
    && node.callee.object.name === "Object"
    && node.callee.property?.type === "Identifier"
    && node.callee.property.name === "entries";
}

function objectEntriesCallbackProbe(node) {
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" || callee.property?.type !== "Identifier") return null;
  if (!arrayTransformMethods.has(callee.property.name)) return null;
  if (!isObjectEntriesCall(callee.object)) return null;
  const cb = node.arguments?.[0];
  if (cb?.type !== "ArrowFunctionExpression" && cb?.type !== "FunctionExpression") return null;
  const names = new Set();
  for (const param of cb.params ?? []) collectBindingNames(param, names);
  if (names.size === 0) return null;
  return { callback: cb, paramNames: names };
}

function ruleNoStructuralTypeFork() {
  return {
    meta: {
      type: "problem",
      docs: { description: "Detect hand-written types structurally equivalent to (or a subset of) an installed package or configured generated source exported type." },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            generatedSources: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: true,
                properties: {
                  generated: { type: "string" },
                },
              },
            },
          },
        },
      ],
    },
    create(context) {
      const services = context.sourceCode?.parserServices ?? context.parserServices;
      if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
      const program = services.program;
      const checker = program.getTypeChecker();
      const generatedSources = context.options[0]?.generatedSources ?? {};

      let candidates = canonicalCache.get(program);
      if (!candidates) {
        candidates = collectCanonicalTypes(program, checker);
        canonicalCache.set(program, candidates);
      }
      if (Object.keys(generatedSources).length > 0) {
        candidates = [...candidates, ...collectGeneratedCanonicalTypes(program, checker, generatedSources)];
      }
      if (!candidates.length) return {};

      function check(node) {
        if (isStructuralDerivationAlias(node)) return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const sym = tsNode?.name && checker.getSymbolAtLocation(tsNode.name);
        if (!sym) return;
        const declared = checker.getDeclaredTypeOfSymbol(sym);
        if (!isObjectType(declared)) return;
        // `type AppUser = firebase.User` resolves to the package's own type — a reference, not a
        // fork. Only hand-written shapes (resolved symbol declared in the user's code) are flagged.
        if (resolvesToInstalledType(declared)) return;
        if (resolvesToGeneratedType(declared, generatedSources)) return;
        const local = typeProps(checker, declared);
        if (local.size < MIN_PROPS) return;
        for (const { label, props } of candidates) {
          if (isStructuralFork(local, props)) {
            context.report({ node, message: `Type matches ${label} — import or derive from the owner instead of redeclaring.` });
            return;
          }
        }
      }

      return {
        TSTypeAliasDeclaration: check,
        TSInterfaceDeclaration: check,
      };
    },
  };
}

function ruleNoCanonicalModelFork() {
  return {
    meta: {
      type: "problem",
      docs: { description: "Detect hand-written copies of configured repo-owned canonical domain models." },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            canonicalEntities: {
              type: "object",
              additionalProperties: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      owner: { type: "string" },
                      exportName: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
    create(context) {
      const services = context.sourceCode?.parserServices ?? context.parserServices;
      if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
      const program = services.program;
      const checker = program.getTypeChecker();
      const canonicalEntities = context.options[0]?.canonicalEntities ?? {};
      const candidates = collectDomainCanonicalTypes(program, checker, canonicalEntities);
      if (!candidates.length) return {};

      function check(node) {
        if (node.type === "TSTypeAliasDeclaration" && node.typeAnnotation?.type !== "TSTypeLiteral") return;
        if (isStructuralDerivationAlias(node)) return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const sym = tsNode?.name && checker.getSymbolAtLocation(tsNode.name);
        if (!sym) return;
        const declared = checker.getDeclaredTypeOfSymbol(sym);
        if (!isObjectType(declared)) return;
        if (resolvesToDomainCanonicalType(declared, canonicalEntities)) return;
        const local = typeProps(checker, declared);
        if (local.size < MIN_PROPS) return;
        for (const { label, props } of candidates) {
          if (isStructuralFork(local, props)) {
            context.report({ node, message: `Type matches ${label} — import or derive from the canonical model owner instead of redeclaring.` });
            return;
          }
        }
      }

      return {
        TSTypeAliasDeclaration: check,
        TSInterfaceDeclaration: check,
      };
    },
  };
}

function ruleNoCastToBranded() {
  return {
    meta: { type: "problem", docs: { description: "Disallow casting values into antidrift branded types." }, schema: [] },
    create(context) {
      const services = context.sourceCode?.parserServices ?? context.parserServices;
      if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
      const checker = services.program.getTypeChecker();

      return {
        TSAsExpression(node) {
          const tsTypeNode = services.esTreeNodeToTSNodeMap.get(node.typeAnnotation);
          if (!tsTypeNode) return;
          const targetType = checker.getTypeFromTypeNode(tsTypeNode);
          if (!isAntidriftBrandedType(targetType)) return;
          context.report({ node, message: "Do not cast to a branded type. Create branded values through the brand validation boundary." });
        },
      };
    },
  };
}

function ruleNoAppeasementCast() {
  return {
    meta: { type: "problem", docs: { description: "Disallow casting any/unknown values into named object contracts." }, schema: [] },
    create(context) {
      const services = context.sourceCode?.parserServices ?? context.parserServices;
      if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
      const checker = services.program.getTypeChecker();

      return {
        TSAsExpression(node) {
          if (!isNamedTypeReference(node.typeAnnotation)) return;
          if (node.expression?.type === "TSAsExpression" && node.expression.typeAnnotation?.type === "TSUnknownKeyword") return;

          const tsExpression = services.esTreeNodeToTSNodeMap.get(node.expression);
          const tsTypeNode = services.esTreeNodeToTSNodeMap.get(node.typeAnnotation);
          if (!tsExpression || !tsTypeNode) return;
          const sourceType = checker.getTypeAtLocation(tsExpression);
          if (!isAnyOrUnknownType(sourceType)) return;

          const targetType = checker.getTypeFromTypeNode(tsTypeNode);
          if (isAntidriftBrandedType(targetType)) return;
          if ((targetType.getProperties?.() ?? []).length === 0) return;

          context.report({ node, message: "Do not cast any/unknown into a named contract. Validate or narrow the value before assigning the type." });
        },
      };
    },
  };
}

function tupleElementTypeNode(element) {
  if (element?.type === "TSNamedTupleMember") return element.elementType;
  if (element?.type === "TSOptionalType") return element.typeAnnotation;
  if (element?.type === "TSRestType") return element.typeAnnotation;
  return element;
}

function tupleElementIsOptional(element) {
  return element?.optional === true
    || element?.type === "TSOptionalType"
    || (element?.type === "TSNamedTupleMember" && element.elementType?.type === "TSOptionalType");
}

function typeNodeIncludesDirectNullish(typeNode) {
  const node = tupleElementTypeNode(typeNode);
  if (node?.type === "TSNullKeyword" || node?.type === "TSUndefinedKeyword" || node?.type === "TSVoidKeyword") return true;
  if (node?.type === "TSUnionType") return node.types.some(typeNodeIncludesDirectNullish);
  if (node?.type === "TSParenthesizedType") return typeNodeIncludesDirectNullish(node.typeAnnotation);
  return false;
}

function tupleElementResolvesToNullish(element, services, checker) {
  const typeNode = tupleElementTypeNode(element);
  const tsTypeNode = typeNode && services?.esTreeNodeToTSNodeMap?.get(typeNode);
  if (!tsTypeNode || !checker) return false;
  return typeIncludesNullish(checker.getTypeFromTypeNode(tsTypeNode));
}

function tupleElementIsNullishSlot(element, services, checker) {
  return tupleElementIsOptional(element)
    || typeNodeIncludesDirectNullish(element)
    || tupleElementResolvesToNullish(element, services, checker);
}

function ruleNoNullablePositionalTuple() {
  return {
    meta: {
      type: "problem",
      docs: { description: "Disallow tuple types that model multiple nullable positional slots." },
      schema: [],
    },
    create(context) {
      const services = context.sourceCode?.parserServices ?? context.parserServices;
      const checker = services?.program?.getTypeChecker?.();

      return {
        TSTupleType(node) {
          const nullishSlots = node.elementTypes.filter((element) => tupleElementIsNullishSlot(element, services, checker));
          if (nullishSlots.length < 2) return;
          context.report({
            node,
            message: "Do not model multi-field nullable state as a positional tuple. Use a named object or explicit state union.",
          });
        },
      };
    },
  };
}

function typePredicateParts(fn) {
  const predicate = fn?.returnType?.typeAnnotation;
  if (predicate?.type !== "TSTypePredicate") return null;
  if (predicate.parameterName?.type !== "Identifier") return null;
  const targetTypeNode = predicate.typeAnnotation?.typeAnnotation;
  if (!targetTypeNode) return null;
  return { paramName: predicate.parameterName.name, targetTypeNode };
}

function functionParameterByName(fn, name) {
  return (fn.params ?? []).find((param) => param?.type === "Identifier" && param.name === name) ?? null;
}

function isBroadPredicateInputType(checker, type) {
  if (isAnyOrUnknownType(type)) return true;
  const typeName = checker.typeToString(type);
  if (typeName === "object" || typeName === "{}") return true;
  if (/^Record<\s*string\s*,\s*(?:unknown|any)\s*>$/u.test(typeName)) return true;
  return typeName === "Object" && (type.getProperties?.() ?? []).length === 0;
}

function staticPropertyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "PrivateIdentifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function memberExpressionPropertyName(node) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped?.type !== "MemberExpression") return null;
  return staticPropertyName(unwrapped.property);
}

function objectHasOwnPropertyName(node, paramNames) {
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression") return null;
  const method = staticPropertyName(callee.property);
  if (method !== "hasOwn" && method !== "hasOwnProperty") return null;
  if (callee.object?.type === "Identifier" && callee.object.name === "Object") {
    return hasParamRoot(node.arguments?.[0], paramNames) ? staticPropertyName(node.arguments?.[1]) : null;
  }
  return hasParamRoot(callee.object, paramNames) ? staticPropertyName(node.arguments?.[0]) : null;
}

function directAliasName(node, paramNames) {
  if (node?.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return null;
  const init = unwrapExpression(node.init);
  return init?.type === "Identifier" && paramNames.has(init.name) ? node.id.name : null;
}

function predicateValueNames(node, paramName) {
  const names = new Set([paramName]);
  let changed = true;
  while (changed) {
    changed = false;
    walkNode(node, (current) => {
      const alias = directAliasName(current, names);
      if (alias && !names.has(alias)) {
        names.add(alias);
        changed = true;
      }
    });
  }
  return names;
}

function checkedTargetProperties(node, paramName, targetProps) {
  const checked = new Set();
  const paramNames = predicateValueNames(node, paramName);
  walkNode(node, (current) => {
    if (current.type === "BinaryExpression" && current.operator === "in" && hasParamRoot(current.right, paramNames)) {
      const prop = staticPropertyName(current.left);
      if (targetProps.has(prop)) checked.add(prop);
      return;
    }
    const hasOwnProp = objectHasOwnPropertyName(current, paramNames);
    if (targetProps.has(hasOwnProp)) {
      checked.add(hasOwnProp);
      return;
    }
    if (current.type === "MemberExpression" && hasParamRoot(current, paramNames)) {
      const prop = memberExpressionPropertyName(current);
      if (targetProps.has(prop)) checked.add(prop);
    }
  });
  return checked;
}

function callUsesPredicateParam(node, paramName) {
  const paramNames = new Set([paramName]);
  return (node.arguments ?? []).some((arg) => arg.type !== "SpreadElement" && hasParamRoot(arg, paramNames));
}

function hasValidatorDelegation(node, paramName) {
  let sawDelegation = false;
  walkNode(node, (current) => {
    if (sawDelegation || current.type !== "CallExpression" || !callUsesPredicateParam(current, paramName)) return;
    const name = callExpressionName(current.callee);
    if (name && /^(?:safeParse|parse|parseAsync|validate|assert|check|is[A-Z]|has[A-Z])/u.test(name)) {
      sawDelegation = true;
    }
  });
  return sawDelegation;
}

function ruleNoUndercheckedTypePredicate() {
  return {
    meta: {
      type: "problem",
      docs: { description: "Disallow broad-input type predicates that assert object contracts without decisive runtime checks." },
      schema: [],
    },
    create(context) {
      const services = context.sourceCode?.parserServices ?? context.parserServices;
      if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
      const checker = services.program.getTypeChecker();

      function check(fn) {
        const parts = typePredicateParts(fn);
        if (!parts) return;
        const param = functionParameterByName(fn, parts.paramName);
        const tsParam = param && services.esTreeNodeToTSNodeMap.get(param);
        const tsTargetTypeNode = services.esTreeNodeToTSNodeMap.get(parts.targetTypeNode);
        if (!tsParam || !tsTargetTypeNode) return;

        const paramType = checker.getTypeAtLocation(tsParam);
        if (!isBroadPredicateInputType(checker, paramType)) return;

        const targetType = checker.getTypeFromTypeNode(tsTargetTypeNode);
        if (!isObjectType(targetType)) return;
        const targetProps = typeProps(checker, targetType);
        if (targetProps.size < 2) return;
        if (hasValidatorDelegation(fn.body, parts.paramName)) return;

        const checked = checkedTargetProperties(fn.body, parts.paramName, targetProps);
        if (checked.size >= Math.min(2, targetProps.size)) return;

        context.report({
          node: fn.returnType,
          message: "Do not narrow broad input with an under-checked type predicate. Check the asserted fields or delegate to an owned schema/validator.",
        });
      }

      return {
        FunctionDeclaration: check,
        FunctionExpression: check,
        ArrowFunctionExpression: check,
      };
    },
  };
}

function ruleNoDefensiveShapeProbing() {
  return {
    meta: { type: "problem", docs: { description: "Disallow Object.entries normalizers that repeatedly probe broad object shape." }, schema: [{ type: "object", properties: { threshold: { type: "number" } }, additionalProperties: false }] },
    create(context) {
      const threshold = context.options[0]?.threshold ?? 4;

      return {
        CallExpression(node) {
          const probe = objectEntriesCallbackProbe(node);
          if (!probe || isTypePredicateReturn(probe.callback)) return;
          if (countShapeProbesIn(probe.callback.body, probe.paramNames) < threshold) return;
          context.report({ node: probe.callback, message: "Do not unpack broad object shapes by probing property names inside Object.entries(...). Move the normalization to an owned schema or converter." });
        },
      };
    },
  };
}

function fileMatchesPath(filename, filePath) {
  return filename.replace(/\\/gu, "/").endsWith(filePath.replace(/\\/gu, "/"));
}

function ruleNoStatusLiteralInType() {
  return {
    meta: { type: "problem", docs: { description: "Disallow re-declaring canonical domain status values as type literals outside the owning module (domain registry)." }, schema: [{ type: "object", properties: { statuses: { type: "object" } }, additionalProperties: false }] },
    create(context) {
      const statuses = context.options[0]?.statuses ?? {};
      const entries = Object.entries(statuses);
      if (entries.length === 0) return {};
      const filename = context.filename ?? context.getFilename();
      return {
        TSLiteralType(node) {
          const value = node.literal?.value;
          if (typeof value !== "string") return;
          for (const [name, entry] of entries) {
            if (!(entry.values ?? []).includes(value)) continue;
            if (fileMatchesPath(filename, entry.owner)) continue;
            if (!isStatusLiteralContext(node, name)) continue;
            context.report({ node, message: `String literal '${value}' duplicates a canonical status from ${entry.owner}. Import the type instead.` });
          }
        },
      };
    },
  };
}

function normalizedContextName(value) {
  return String(value ?? "").replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isStatusContextName(contextName, statusName) {
  const normalized = normalizedContextName(contextName);
  if (!normalized) return false;
  return normalized.includes("status") || normalized === normalizedContextName(statusName);
}

function nodeKeyName(node) {
  if (node?.type === "Identifier" || node?.type === "PrivateIdentifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return "";
}

function isStatusLiteralContext(node, statusName) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "TSTypeAliasDeclaration") return isStatusContextName(cur.id?.name, statusName);
    if (cur.type === "TSInterfaceDeclaration") return isStatusContextName(cur.id?.name, statusName);
    if (cur.type === "TSPropertySignature") return isStatusContextName(nodeKeyName(cur.key), statusName);
    if (cur.type === "Identifier") return isStatusContextName(cur.name, statusName);
    if (cur.type === "VariableDeclarator" && cur.id?.type === "Identifier") return isStatusContextName(cur.id.name, statusName);
    cur = cur.parent;
  }
  return false;
}

function ruleNoRoleLiteralInType() {
  return {
    meta: { type: "problem", docs: { description: "Disallow re-declaring canonical role values as type literals outside the owning module (domain registry)." }, schema: [{ type: "object", properties: { roles: { type: "object" } }, additionalProperties: false }] },
    create(context) {
      const roles = context.options[0]?.roles ?? {};
      const values = roles.values ?? [];
      if (values.length === 0) return {};
      const filename = context.filename ?? context.getFilename();
      return {
        TSLiteralType(node) {
          const value = node.literal?.value;
          if (typeof value !== "string" || !values.includes(value)) return;
          if (fileMatchesPath(filename, roles.owner)) return;
          if (!isRoleLiteralContext(node)) return;
          context.report({ node, message: `String literal '${value}' duplicates a canonical role from ${roles.owner}. Import the Role type instead.` });
        },
      };
    },
  };
}

function isRoleContextName(contextName) {
  return normalizedContextName(contextName).includes("role");
}

function isRoleLiteralContext(node) {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "TSTypeAliasDeclaration") return isRoleContextName(cur.id?.name);
    if (cur.type === "TSInterfaceDeclaration") return isRoleContextName(cur.id?.name);
    if (cur.type === "TSPropertySignature") return isRoleContextName(nodeKeyName(cur.key));
    if (cur.type === "Identifier") return isRoleContextName(cur.name);
    if (cur.type === "VariableDeclarator" && cur.id?.type === "Identifier") return isRoleContextName(cur.id.name);
    cur = cur.parent;
  }
  return false;
}

// True when an identifier's symbol (e.g. the `parse` method being called) is declared inside the
// installed `zod` / `@zod/*` package — the type-aware way to confirm a `.parse()` is Zod's, with no
// name-matching (a bare `x.parse()` could be JSON, Date, a custom parser, anything).
function isZodMethod(checker, tsNameNode) {
  const sym = tsNameNode && checker.getSymbolAtLocation(tsNameNode);
  for (const decl of sym?.declarations ?? []) {
    const file = decl.getSourceFile().fileName.replace(/\\/gu, "/");
    const idx = file.lastIndexOf("/node_modules/");
    if (idx === -1) continue;
    const rest = file.slice(idx + "/node_modules/".length);
    if (rest === "zod" || rest.startsWith("zod/") || rest.startsWith("@zod/")) return true;
  }
  return false;
}

function zodParseCallParts(node, services, checker) {
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  if (callee.property.type !== "Identifier" || !zodParseMethods.has(callee.property.name)) return null;
  if (node.arguments.length === 0) return null;
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  if (!isZodMethod(checker, tsCall?.expression?.name)) return null;
  return { callee, tsCall, arg: node.arguments[0] };
}

function isAwaitedCallInitializer(node) {
  return node?.type === "AwaitExpression" && node.argument?.type === "CallExpression";
}

function parsedCallResultMatchesSchemaOutput(checker, services, tsCall, arg) {
  const tsArg = services.esTreeNodeToTSNodeMap.get(arg);
  const argType = tsArg ? checker.getTypeAtLocation(tsArg) : null;
  const parseReturnType = checker.getTypeAtLocation(tsCall);
  return Boolean(
    argType
    && !isAnyOrUnknownType(argType)
    && !isAnyOrUnknownType(parseReturnType)
    && !typeStringIncludesAnyOrUnknown(checker, parseReturnType)
    && checker.isTypeAssignableTo(argType, parseReturnType)
    && checker.isTypeAssignableTo(parseReturnType, argType)
  );
}

function recordParsedConst(node, schemaSym, symbolOf, validatedBy) {
  let decl = node.parent;
  if (decl?.type === "AwaitExpression") decl = decl.parent;
  if (!schemaSym || decl?.type !== "VariableDeclarator" || decl.id.type !== "Identifier") return;
  if (decl.parent?.type !== "VariableDeclaration" || decl.parent.kind !== "const") return;
  const declSym = symbolOf(decl.id);
  if (declSym) validatedBy.set(declSym, schemaSym);
}

function ruleNoRedundantZodParse() {
  return {
    meta: { type: "problem", docs: { description: "Detect re-parsing a value with the same Zod schema that already produced it. Validate once at the boundary and pass the parsed value inward instead of re-validating in every layer." }, schema: [] },
    create(context) {
      const services = context.sourceCode?.parserServices ?? context.parserServices;
      if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
      const checker = services.program.getTypeChecker();
      // Symbol of a value already validated → symbol of the schema that validated it.
      const validatedBy = new Map();
      const symbolOf = (node) => {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        return tsNode ? checker.getSymbolAtLocation(tsNode) : undefined;
      };
      const callResultSymbols = new Set();
      return {
        VariableDeclarator(node) {
          if (node.id.type !== "Identifier" || !isAwaitedCallInitializer(node.init)) return;
          const sym = symbolOf(node.id);
          if (sym) callResultSymbols.add(sym);
        },
        CallExpression(node) {
          const parts = zodParseCallParts(node, services, checker);
          if (!parts) return;
          const { callee, tsCall, arg } = parts;
          const schemaSym = callee.object.type === "Identifier" ? symbolOf(callee.object) : undefined;

          // Re-parse: the argument is a value already validated by this exact schema (same binding).
          if (arg.type === "Identifier" && schemaSym && validatedBy.get(symbolOf(arg)) === schemaSym) {
            context.report({ node, message: "Redundant Zod parse: this value was already validated by the same schema. Validate once at the boundary and pass the parsed value inward instead of re-parsing." });
            return;
          }

          // Service-to-boundary re-parse: a called helper/service already returned the schema's
          // output type, and the caller immediately validates that typed contract again.
          if (arg.type === "Identifier" && callResultSymbols.has(symbolOf(arg)) && parsedCallResultMatchesSchemaOutput(checker, services, tsCall, arg)) {
            context.report({ node, message: "Redundant Zod parse: this call result is already typed as the schema output. Validate once at the boundary and pass the parsed value inward instead of re-parsing." });
            return;
          }

          // Provenance: record `const v = Schema.parse(...)` / `const v = await Schema.parseAsync(...)`.
          recordParsedConst(node, schemaSym, symbolOf, validatedBy);
        },
      };
    },
  };
}

const rules = {
  "no-trivial-selector-wrapper": ruleNoTrivialSelectorWrapper(),
  "no-inline-structural-type-at-use-site": ruleNoInlineStructuralTypeAtUseSite(),
  "no-unsafe-cast-chain": ruleNoUnsafeCastChain(),
  "no-cast-to-branded": ruleNoCastToBranded(),
  "no-appeasement-cast": ruleNoAppeasementCast(),
  "no-nullable-positional-tuple": ruleNoNullablePositionalTuple(),
  "no-underchecked-type-predicate": ruleNoUndercheckedTypePredicate(),
  "no-defensive-shape-probing": ruleNoDefensiveShapeProbing(),
  "no-silent-catch": ruleNoSilentCatch(),
  "no-coupled-state-setters": ruleNoCoupledStateSetters(),
  "no-status-triplet-state": ruleNoStatusTripletState(),
  "require-effect-deps": ruleRequireEffectDeps(),
  "no-raw-tailwind-color": ruleClassNamePattern("no-raw-tailwind-color", rawTailwindColorPattern, "Use semantic design tokens instead of raw Tailwind color utilities."),
  "no-hover-translate-card": ruleClassNamePattern("no-hover-translate-card", hoverTranslatePattern, "Do not move pointer targets on hover. Use shadow, border, color, or inner transforms."),
  "no-raw-fetch-in-component": ruleNoRawFetchInComponent(),
  "no-async-array-method": ruleNoAsyncArrayMethod(),
  "no-obvious-comment": ruleNoObviousComment(),
  "no-sql-string-concat": ruleNoSqlStringConcat(),
  "no-unsafe-deserialize": ruleNoUnsafeDeserialize(),
  "require-authz-check": ruleRequireAuthzCheck(),
  "no-structural-type-fork": ruleNoStructuralTypeFork(),
  "no-canonical-model-fork": ruleNoCanonicalModelFork(),
  "no-redundant-zod-parse": ruleNoRedundantZodParse(),
  "no-status-literal-in-type": ruleNoStatusLiteralInType(),
  "no-role-literal-in-type": ruleNoRoleLiteralInType(),
};

export default {
  meta: { name: "@joedeleeuw/antidrift/eslint-plugin", version: "0.1.0" },
  rules,
};
