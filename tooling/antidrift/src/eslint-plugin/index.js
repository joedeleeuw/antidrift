import { typeProps, collectCanonicalTypes, isObjectType, resolvesToInstalledType, MIN_PROPS } from "../policy/lib/type-index.mjs";

const mechanicalGetterPattern = /^(get|select|extract)[A-Z].*From[A-Z]/u;
const rawTailwindColorPattern = /\b(?:text|bg|border|ring)-(?:red|blue|green|yellow|gray|slate|zinc|neutral)-\d{2,3}\b/u;
const hoverTranslatePattern = /hover:-?translate-[xy]/u;
// eslint-disable-next-line sonarjs/slow-regex -- reason: controlled plugin source string, not user input; [A-Z0-9]+-\d+ terminates on hyphen so backtracking is bounded
const ticketPattern = /(?:[A-Z][A-Z0-9]+-\d+|https?:\/\/|because|reason:)/iu;

const arrayMethodsNeedingPromiseAll = new Set(["map", "flatMap"]);
const arrayMethodsNeverAsync = new Set(["filter", "forEach", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "sort"]);
const reactEffectHooks = new Set(["useEffect", "useLayoutEffect"]);
const defaultObviousTriggerWords = ["set", "assign", "increase", "increment", "decrease", "decrement", "counter", "return", "create", "update", "delete", "get", "call", "initialize", "define", "loop", "iterate", "check", "store", "save"];

function isExported(node) {
  return node.parent?.type === "ExportNamedDeclaration" || node.parent?.type === "ExportDefaultDeclaration";
}

function getFunctionName(node) {
  if (node.type === "FunctionDeclaration") return node.id?.name ?? "";
  if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return node.id?.name ?? "";
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") return node.id.name;
  return "";
}

function getFunctionNode(node) {
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return node;
  if (node.type === "VariableDeclarator") return node.init;
  return null;
}

function hasExplicitReturnType(fn) {
  return Boolean(fn?.returnType);
}

function unwrapExpression(expression) {
  if (expression?.type === "ChainExpression") return expression.expression;
  if (expression?.type === "TSAsExpression") return unwrapExpression(expression.expression);
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

function isReactComponentName(name) {
  return /^[A-Z]/u.test(name);
}

function getJsxClassNameLiteral(node) {
  if (node.name?.name !== "className") return null;
  if (node.value?.type === "Literal" && typeof node.value.value === "string") return node.value.value;
  if (node.value?.type === "JSXExpressionContainer" && node.value.expression?.type === "Literal" && typeof node.value.expression.value === "string") {
    return node.value.expression.value;
  }
  return null;
}

function ruleNoTrivialSelectorWrapper() {
  function check(context, node) {
    if (isExported(node)) return;
    const fn = getFunctionNode(node);
    const name = getFunctionName(node);
    if (!fn || !mechanicalGetterPattern.test(name)) return;
    if (hasExplicitReturnType(fn) && isSingleReturnMemberExpression(fn)) {
      context.report({
        node,
        message: "Do not create a typed getXFromY/selectXFromY wrapper that only returns a property. Use inference directly or move the contract to the owned boundary.",
      });
    }
  }

  return {
    meta: { type: "problem", docs: { description: "Disallow typed selector wrappers that only restate property access." }, schema: [] },
    create(context) {
      return {
        FunctionDeclaration(node) { check(context, node); },
        VariableDeclarator(node) { check(context, node); },
      };
    },
  };
}

function ruleNoExplicitReturnTypePrivateHelper() {
  function check(context, node) {
    if (isExported(node)) return;
    const fn = getFunctionNode(node);
    const name = getFunctionName(node);
    if (!fn || !hasExplicitReturnType(fn)) return;
    if (name.startsWith("use") || name.endsWith("Reducer")) return;
    context.report({
      node: fn.returnType ?? node,
      message: "Private helpers should rely on inference unless they are public boundaries, recursive, overloaded, or explicitly allowlisted.",
    });
  }

  return {
    meta: { type: "suggestion", docs: { description: "Disallow explicit return types on private helpers." }, schema: [] },
    create(context) {
      return {
        FunctionDeclaration(node) { check(context, node); },
        VariableDeclarator(node) { check(context, node); },
      };
    },
  };
}

function ruleNoInlineStructuralTypeAtUseSite() {
  return {
    meta: { type: "problem", docs: { description: "Disallow inline object type literals at use sites." }, schema: [] },
    create(context) {
      return {
        TSTypeLiteral(node) {
          const parent = node.parent;
          const grandparent = parent?.parent;
          const isParameter = parent?.type === "TSTypeAnnotation" && grandparent?.type === "Identifier" && grandparent.parent?.type !== "TSTypeAliasDeclaration";
          if (isParameter) {
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

function ruleNoInlineDisableWithoutTicket() {
  return {
    meta: { type: "problem", docs: { description: "Require reason or ticket on lint and TypeScript disables." }, schema: [] },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      return {
        Program() {
          for (const comment of sourceCode.getAllComments()) {
            const value = comment.value;
            const isDisable = /(eslint-disable|oxlint-disable|@ts-ignore|@ts-expect-error)/u.test(value);
            if (isDisable && !ticketPattern.test(value)) {
              context.report({ loc: comment.loc, message: "Inline disables require a ticket, URL, or explicit reason." });
            }
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
    meta: { type: "problem", docs: { description: "Disallow data/loading/error state triplets." }, schema: [] },
    create(context) {
      const functionStack = [];
      function enterFunction(node) { functionStack.push({ node, names: new Set() }); }
      function exitFunction() {
        const frame = functionStack.pop();
        if (!frame) return;
        const names = frame.names;
        const hasData = [...names].some((name) => /^(data|result|user|items)$/iu.test(name));
        const hasLoading = [...names].some((name) => /^(loading|isLoading|pending|isPending)$/u.test(name));
        const hasError = [...names].some((name) => /^(error|loadError|failure)$/iu.test(name));
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
          const className = getJsxClassNameLiteral(node);
          if (className && pattern.test(className)) {
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
      const stack = [];
      function enterFunction(node) { stack.push({ node, name: getFunctionName(node), sawJsx: false, sawFetch: null }); }
      function exitFunction() {
        const frame = stack.pop();
        if (frame?.sawFetch && (frame.sawJsx || isReactComponentName(frame.name))) {
          context.report({ node: frame.sawFetch, message: "Do not call raw fetch inside React components. Use an API client, loader, or query resource." });
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
          if (stack.length > 0) stack[stack.length - 1].sawJsx = true;
        },
        CallExpression(node) {
          if (node.callee?.type === "Identifier" && node.callee.name === "fetch" && stack.length > 0) {
            stack[stack.length - 1].sawFetch = node;
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

function ruleNoAsyncArrayMethod() {
  return {
    meta: { type: "problem", docs: { description: "Disallow async callbacks passed to array iteration methods that silently drop or mishandle the returned promises." }, schema: [] },
    create(context) {
      return {
        CallExpression(node) {
          const callee = node.callee;
          if (callee?.type !== "MemberExpression" || callee.property?.type !== "Identifier") return;
          const method = callee.property.name;
          const cb = node.arguments?.[0];
          const isAsyncCb = (cb?.type === "ArrowFunctionExpression" || cb?.type === "FunctionExpression") && cb.async === true;
          if (!isAsyncCb) return;
          if (arrayMethodsNeverAsync.has(method)) {
            context.report({ node: cb, message: `.${method}() does not await its callback, so an async callback here runs unhandled. Use a for...of loop.` });
            return;
          }
          if (arrayMethodsNeedingPromiseAll.has(method)) {
            const parent = node.parent;
            const wrapped = parent?.type === "CallExpression" && isPromiseCombinator(parent.callee) && parent.arguments.includes(node);
            if (!wrapped) {
              context.report({ node: cb, message: `Wrap .${method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited.` });
            }
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

const obviousCommentSkipPattern = /^\s*(eslint|oxlint|ts-|@ts-|prettier|global|c8|istanbul|biome|v8)/u;

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
      schema: [{ type: "object", properties: { triggerWords: { type: "array", items: { type: "string" } }, maxCommentWords: { type: "number" } }, additionalProperties: false }],
    },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const opts = context.options[0] ?? {};
      const triggerWords = new Set((opts.triggerWords ?? defaultObviousTriggerWords).map((word) => word.toLowerCase()));
      const maxCommentWords = opts.maxCommentWords ?? 6;

      function isObvious(comment) {
        if (obviousCommentSkipPattern.test(comment.value)) return false;
        const statement = statementAfterComment(sourceCode, comment);
        if (!statement) return false;
        const commentWords = new Set(extractCommentWords(comment.value));
        if (commentWords.size === 0) return false;
        const overlap = countOverlap(commentWords, statement);
        if (overlap === 0) return false;
        const hasTrigger = [...commentWords].some((word) => triggerWords.has(word));
        const dense = commentWords.size <= maxCommentWords && overlap / commentWords.size >= 0.5;
        return hasTrigger || dense;
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

const defaultUntrustedRoots = ["req", "request", "ctx", "context", "event", "msg", "message"];

function rootIdentifierName(node) {
  let cur = node;
  while (cur) {
    if (cur.type === "Identifier") return cur.name;
    if (cur.type === "MemberExpression") { cur = cur.object; continue; }
    if (cur.type === "CallExpression") { cur = cur.callee; continue; }
    if (cur.type === "AwaitExpression") { cur = cur.argument; continue; }
    if (cur.type === "ChainExpression") { cur = cur.expression; continue; }
    return null;
  }
  return null;
}

function ruleNoUnsafeDeserialize() {
  return {
    meta: { type: "problem", docs: { description: "Disallow JSON.parse on untrusted request sources without validation." }, schema: [{ type: "object", properties: { sources: { type: "array", items: { type: "string" } } }, additionalProperties: false }] },
    create(context) {
      const sources = new Set(context.options[0]?.sources ?? defaultUntrustedRoots);
      return {
        CallExpression(node) {
          const callee = node.callee;
          const isJsonParse = callee?.type === "MemberExpression"
            && callee.object?.type === "Identifier" && callee.object.name === "JSON"
            && callee.property?.type === "Identifier" && callee.property.name === "parse";
          if (!isJsonParse) return;
          const root = rootIdentifierName(node.arguments?.[0]);
          if (root && sources.has(root)) {
            context.report({ node, message: "Do not JSON.parse untrusted request data without schema validation. Parse through a schema (e.g. Zod)." });
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

function ruleNoStructuralTypeFork() {
  return {
    meta: { type: "problem", docs: { description: "Detect hand-written types structurally equivalent to (or a subset of) an installed package's exported type." }, schema: [] },
    create(context) {
      const services = context.sourceCode?.parserServices ?? context.parserServices;
      if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
      const program = services.program;
      const checker = program.getTypeChecker();

      let candidates = canonicalCache.get(program);
      if (!candidates) {
        candidates = collectCanonicalTypes(program, checker);
        canonicalCache.set(program, candidates);
      }
      if (!candidates.length) return {};

      function check(node) {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const sym = tsNode?.name && checker.getSymbolAtLocation(tsNode.name);
        if (!sym) return;
        const declared = checker.getDeclaredTypeOfSymbol(sym);
        if (!isObjectType(declared)) return;
        // `type AppUser = firebase.User` resolves to the package's own type — a reference, not a
        // fork. Only hand-written shapes (resolved symbol declared in the user's code) are flagged.
        if (resolvesToInstalledType(declared)) return;
        const local = typeProps(checker, declared);
        if (local.size < MIN_PROPS) return;
        for (const { label, props } of candidates) {
          if (isStructuralFork(local, props)) {
            context.report({ node, message: `Type matches ${label} — import it instead of redeclaring.` });
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

function matchesImportPattern(importPath, pattern) {
  return pattern.endsWith("/**")
    ? importPath === pattern.slice(0, -3) || importPath.startsWith(pattern.slice(0, -3) + "/")
    : importPath === pattern;
}

function fileMatchesPath(filename, filePath) {
  return filename.replace(/\\/gu, "/").endsWith(filePath.replace(/\\/gu, "/"));
}

function ruleNoSdkDirectUse() {
  return {
    meta: { type: "problem", docs: { description: "Disallow direct SDK imports outside the declared gateway wrapper (gateways registry)." }, schema: [{ type: "object", properties: { gateways: { type: "object" } }, additionalProperties: false }] },
    create(context) {
      const gateways = Object.values(context.options[0]?.gateways ?? {});
      if (gateways.length === 0) return {};
      const filename = context.filename ?? context.getFilename();
      return {
        ImportDeclaration(node) {
          const src = node.source.value;
          for (const gw of gateways) {
            const banned = gw.bannedDirectImports ?? [];
            if (!banned.some((pattern) => matchesImportPattern(src, pattern))) continue;
            if (fileMatchesPath(filename, gw.wrapper)) continue;
            context.report({ node, message: `Import '${src}' must go through the approved gateway (${gw.wrapper}).` });
          }
        },
      };
    },
  };
}

function ruleNoStatusLiteralInType() {
  return {
    meta: { type: "problem", docs: { description: "Disallow re-declaring canonical domain status values as type literals outside the owning module (domain registry)." }, schema: [{ type: "object", properties: { statuses: { type: "object" } }, additionalProperties: false }] },
    create(context) {
      const statuses = context.options[0]?.statuses ?? {};
      const entries = Object.values(statuses);
      if (entries.length === 0) return {};
      const filename = context.filename ?? context.getFilename();
      return {
        TSLiteralType(node) {
          const value = node.literal?.value;
          if (typeof value !== "string") return;
          for (const entry of entries) {
            if (!(entry.values ?? []).includes(value)) continue;
            if (fileMatchesPath(filename, entry.owner)) continue;
            context.report({ node, message: `String literal '${value}' duplicates a canonical status from ${entry.owner}. Import the type instead.` });
          }
        },
      };
    },
  };
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
          context.report({ node, message: `String literal '${value}' duplicates a canonical role from ${roles.owner}. Import the Role type instead.` });
        },
      };
    },
  };
}

const rules = {
  "no-trivial-selector-wrapper": ruleNoTrivialSelectorWrapper(),
  "no-explicit-return-type-private-helper": ruleNoExplicitReturnTypePrivateHelper(),
  "no-inline-structural-type-at-use-site": ruleNoInlineStructuralTypeAtUseSite(),
  "no-unsafe-cast-chain": ruleNoUnsafeCastChain(),
  "no-silent-catch": ruleNoSilentCatch(),
  "no-inline-disable-without-ticket": ruleNoInlineDisableWithoutTicket(),
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
  "no-sdk-direct-use": ruleNoSdkDirectUse(),
  "no-status-literal-in-type": ruleNoStatusLiteralInType(),
  "no-role-literal-in-type": ruleNoRoleLiteralInType(),
};

export default {
  meta: { name: "@joedeleeuw/antidrift/eslint-plugin", version: "0.1.0" },
  rules,
};
