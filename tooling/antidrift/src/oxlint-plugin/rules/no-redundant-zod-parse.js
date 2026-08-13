import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import {
  canonicalPath,
  chainBaseIdentifier,
  importSourceOf,
  isStableRoot,
  nodeEnd,
  nodeStart,
  resolvePathValue,
  samePath,
  sharesPathPrefix,
  unwrapExpression,
} from "../../semantic-adapters/canonical-path.mjs";
import {
  isThrowAssertionCallbackParse,
  validationCallParts,
  ZOD_SAFE_PARSE_METHODS,
} from "../../semantic-adapters/schema-parse-shape.mjs";

// Detection is provenance-based, not type-based. The rule fires only when this
// file shows the value being produced by a validation call on the *same*
// canonical schema path, so no type-identity or assignability signal is
// consulted anywhere — that mechanism was retired in a093871 because Zod
// refinements are invisible to TypeScript.
//
// Exemptions re-derived against the provenance gate (dfine-io/dlint ships the
// first four; its detector is type-shape, so each one exists to suppress a
// failure mode that shape-matching creates and provenance does not):
//
// - safeParse is always a boundary. REJECTED. A shape detector cannot tell a
//   defensive check of untrusted input from a re-check of its own output, so it
//   must exempt the method wholesale. Provenance only closes the gate when this
//   file produced the value from this schema, and a defensive check of unknown
//   input never reaches that state. `S.safeParse(ownOutput)` cannot fail, so it
//   is dead code and gets its own message instead of an exemption.
// - `.catch()` / `.default()` in the chain. KEPT, but as a structural
//   consequence rather than an exemption: `S.catch(x).parse(v)` has a call in
//   the receiver chain, so `canonicalPath` bails on it. It is also a different
//   schema instance, so unifying it would have been wrong.
// - "use server" files. REJECTED. It exists because a server action's typed
//   parameters are untrusted at runtime, which only matters to a detector that
//   reads the parameter's type. A boundary parse of an argument never reaches
//   the gate; a file that parses the same value twice is drift wherever it runs.
// - Widely-typed veto (`any`/`unknown` suppresses the report). REJECTED as
//   written — it is a checker query this tier does not have — and unnecessary:
//   the failure mode it protects against is a declared type that lies about the
//   runtime value, and the gate requires the literal result of this schema's own
//   parse call rather than a declared type.
// - Throw-assertion callbacks (`expect(() => S.parse(v)).toThrow()`). KEPT from
//   the pre-migration rule. A test asserting that a schema rejects a value is a
//   contract check, not validation drift, and provenance cannot distinguish it.
//
// Residual known holes, documented rather than solved: a getter on a path that
// returns a fresh object each read, and cross-module mutation of an exported
// contract object. Both need module-graph facts this tier does not have.

const DEFAULT_SCHEMA_MODULES = ["zod"];
const DEFAULT_NON_SCHEMA_MODULES = [
  "@babel/parser",
  "@iarna/toml",
  "acorn",
  "chrono-node",
  "cookie",
  "csv-parse",
  "date-fns",
  "dotenv",
  "espree",
  "fast-xml-parser",
  "graphql",
  "ini",
  "js-yaml",
  "jsonc-parser",
  "marked",
  "mime",
  "node-html-parser",
  "papaparse",
  "parse5",
  "path",
  "qs",
  "querystring",
  "semver",
  "smol-toml",
  "superjson",
  "toml",
  "ua-parser-js",
  "url",
  "url-parse",
  "uuid",
  "xml2js",
  "yaml",
];

function matchesModule(specifier, patterns) {
  return patterns.some(
    (pattern) => specifier === pattern || specifier.startsWith(`${pattern}/`),
  );
}

function normalizeOptions(raw) {
  return {
    schemaModules: raw?.schemaModules ?? DEFAULT_SCHEMA_MODULES,
    contractModules: raw?.contractModules ?? [],
    nonSchemaModules: raw?.nonSchemaModules ?? DEFAULT_NON_SCHEMA_MODULES,
  };
}

function moduleOrigin(specifier, options) {
  if (specifier.startsWith("node:")) return null;
  if (matchesModule(specifier, options.schemaModules)) return "zod-rooted";
  if (matchesModule(specifier, options.contractModules)) {
    return "declared-container";
  }
  if (matchesModule(specifier, options.nonSchemaModules)) return null;
  return "opaque-container";
}

// Positive evidence that the receiver names a schema. Nothing here is a type
// query: either the path resolves in-file to an expression rooted at a schema
// import, or the root binding itself is an import whose module is not a known
// non-schema parser. Globals (`JSON`, `Date`) and `node:` builtins never pass.
function schemaOrigin(sourceCode, path, options) {
  const rootImport = importSourceOf(path.variable);
  if (rootImport !== null) return moduleOrigin(rootImport, options);
  const resolved = resolvePathValue(sourceCode, path);
  if (!resolved) return null;
  const resolvedImport = importSourceOf(resolved.variable);
  if (resolved.expression === null) {
    return resolvedImport === null
      ? null
      : moduleOrigin(resolvedImport, options);
  }
  const base = chainBaseIdentifier(resolved.expression);
  if (!base) return null;
  const baseVariable = findVariable(sourceCode, base);
  const baseImport = importSourceOf(baseVariable);
  if (baseImport !== null) return moduleOrigin(baseImport, options);
  if (baseVariable === resolved.variable) return null;
  const basePath = canonicalPath(sourceCode, base);
  return basePath ? schemaOrigin(sourceCode, basePath, options) : null;
}

function declaratorOf(node) {
  const parent =
    node.parent?.type === "AwaitExpression" ? node.parent.parent : node.parent;
  if (
    parent?.type !== "VariableDeclarator" ||
    parent.parent?.type !== "VariableDeclaration" ||
    parent.parent.kind !== "const"
  ) {
    return null;
  }
  return parent;
}

// `const { data } = S.safeParse(x)` and `const { data: user } = ...` bind the
// schema output directly; `const r = S.safeParse(x)` carries it on `r.data`.
function safeParseDataBinding(declarator) {
  if (declarator.id.type !== "ObjectPattern") return null;
  for (const property of declarator.id.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === "data" &&
      property.value.type === "Identifier"
    ) {
      return property.value;
    }
  }
  return null;
}

function reportedValueBinding(sourceCode, argument, safeResults) {
  const value = unwrapExpression(argument);
  if (value?.type === "Identifier") {
    return { variable: findVariable(sourceCode, value), viaSafeResult: false };
  }
  if (
    value?.type === "MemberExpression" &&
    !value.computed &&
    value.property.type === "Identifier" &&
    value.property.name === "data" &&
    unwrapExpression(value.object)?.type === "Identifier"
  ) {
    const holder = findVariable(sourceCode, unwrapExpression(value.object));
    if (holder && safeResults.has(holder)) {
      return { variable: holder, viaSafeResult: true };
    }
  }
  return { variable: null, viaSafeResult: false };
}

const FUNCTION_NODE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const WALK_SKIP_KEYS = new Set(["parent", "loc", "range", "start", "end", "type"]);
const MAX_ESCAPE_DEPTH = 24;

// Every identifier an expression hands to someone else. Member property names
// and non-computed object keys are not values, so they are skipped; everything
// else — nested literals, spreads, closures — is walked, because a callee that
// receives or captures the value can mutate it.
function collectEscapedIdentifiers(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > MAX_ESCAPE_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) collectEscapedIdentifiers(item, out, depth + 1);
    return;
  }
  if (typeof node.type !== "string") return;
  if (node.type === "Identifier") {
    out.push(node);
    return;
  }
  if (node.type === "MemberExpression") {
    collectEscapedIdentifiers(node.object, out, depth + 1);
    if (node.computed) collectEscapedIdentifiers(node.property, out, depth + 1);
    return;
  }
  if (node.type === "Property") {
    if (node.computed) collectEscapedIdentifiers(node.key, out, depth + 1);
    collectEscapedIdentifiers(node.value, out, depth + 1);
    return;
  }
  for (const key of Object.keys(node)) {
    if (WALK_SKIP_KEYS.has(key)) continue;
    collectEscapedIdentifiers(node[key], out, depth + 1);
  }
}

// The same-file function a bare-identifier callee names, if any. Function
// declarations hoist, so the body may sit after every call site.
function calledFunctionNode(variable) {
  const definition = variable?.defs?.[0];
  if (!definition) return null;
  if (definition.type === "FunctionName") return definition.node;
  if (definition.type === "Variable") {
    const initializer = unwrapExpression(definition.node?.init);
    return FUNCTION_NODE_TYPES.has(initializer?.type) ? initializer : null;
  }
  return null;
}

export default function ruleNoRedundantZodParse() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect re-running a Zod schema on a value that same schema already produced, including schemas reached through a contract object path. Validate once at the boundary and pass the parsed value inward.",
      },
      schema: [
        {
          type: "object",
          properties: {
            schemaModules: { type: "array", items: { type: "string" } },
            contractModules: { type: "array", items: { type: "string" } },
            nonSchemaModules: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      ],
      messages: {
        redundantParse:
          "Redundant Zod parse: `{{schema}}` already produced this value in this file. Validate once at the boundary and pass the parsed value inward instead of re-parsing.",
        alwaysSuccessfulSafeParse:
          "Dead defensive validation: `{{schema}}.{{method}}` cannot fail here because this value is that schema's own unmutated output. Drop the check, or move it to the raw input it was meant to guard.",
      },
    },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const options = normalizeOptions(context.options?.[0]);
      const calls = [];
      const writes = [];
      const hazards = new Map();
      // Hazards attributed to the function that contains them, so a call to a
      // function can stand in for what that function's body does. Function
      // declarations hoist, so a lexical source-order window cannot see a
      // mutator declared below the site it affects.
      const functionStack = [];
      const functionHazards = new Map();
      const functionCalls = new Map();
      const calleeCallSites = [];

      const currentFunction = () =>
        functionStack.length > 0
          ? functionStack[functionStack.length - 1]
          : null;

      const hazardSetFor = (map, key) => {
        const existing = map.get(key);
        if (existing) return existing;
        const created = new Set();
        map.set(key, created);
        return created;
      };

      const addHazard = (variable, node) => {
        if (!variable) return;
        const sites = hazards.get(variable) ?? [];
        sites.push(node);
        hazards.set(variable, sites);
        hazardSetFor(functionHazards, currentFunction()).add(variable);
      };

      const addEscape = (expression, node) => {
        const identifiers = [];
        collectEscapedIdentifiers(expression, identifiers);
        for (const identifier of identifiers) {
          addHazard(findVariable(sourceCode, identifier), node);
        }
      };

      const addWrite = (target, node) => {
        const path = canonicalPath(sourceCode, target);
        if (!path) return;
        writes.push(path);
        // A write anywhere under a value's own path spends its provenance.
        addHazard(path.variable, node);
      };

      const addCallHazards = (node) => {
        if (validationCallParts(node)) return;
        for (const argument of node.arguments ?? []) addEscape(argument, node);
        const callee = unwrapExpression(node.callee);
        if (callee?.type === "MemberExpression") {
          addEscape(callee.object, node);
          return;
        }
        if (callee?.type !== "Identifier") return;
        const target = calledFunctionNode(findVariable(sourceCode, callee));
        if (!target) return;
        calleeCallSites.push({ node, target });
        hazardSetFor(functionCalls, currentFunction()).add(target);
      };

      // A call to a same-file function hazards everything that function's body
      // writes or lets escape, transitively, positioned at the call site.
      const resolveCalleeHazards = () => {
        const resolved = new Map();
        const resolveFor = (fn, seen) => {
          if (resolved.has(fn)) return resolved.get(fn);
          if (seen.has(fn)) return new Set();
          seen.add(fn);
          const out = new Set(functionHazards.get(fn) ?? []);
          for (const callee of functionCalls.get(fn) ?? []) {
            for (const variable of resolveFor(callee, seen)) out.add(variable);
          }
          resolved.set(fn, out);
          return out;
        };
        for (const { node, target } of calleeCallSites) {
          for (const variable of resolveFor(target, new Set())) {
            const sites = hazards.get(variable) ?? [];
            sites.push(node);
            hazards.set(variable, sites);
          }
        }
      };

      const escapedBetween = (variable, after, before) =>
        (hazards.get(variable) ?? []).some(
          (site) => nodeStart(site) >= after && nodeEnd(site) <= before,
        );

      const analyze = () => {
        resolveCalleeHazards();
        const validatedBy = new Map();
        const safeResults = new Map();
        for (const call of [...calls].sort(
          (left, right) => nodeStart(left.node) - nodeStart(right.node),
        )) {
          const { node, parts, path } = call;
          const { variable, viaSafeResult } = reportedValueBinding(
            sourceCode,
            parts.argument,
            safeResults,
          );
          const record = viaSafeResult
            ? safeResults.get(variable)
            : validatedBy.get(variable);
          if (
            record &&
            samePath(record.path, path) &&
            !writes.some((write) => sharesPathPrefix(write, path)) &&
            !escapedBetween(variable, nodeEnd(record.node), nodeStart(node))
          ) {
            context.report({
              node,
              messageId: parts.safe
                ? "alwaysSuccessfulSafeParse"
                : "redundantParse",
              data: {
                schema: sourceCode.getText(parts.receiver),
                method: parts.method,
              },
            });
            continue;
          }
          const declarator = declaratorOf(node);
          if (!declarator) continue;
          if (declarator.id.type === "Identifier") {
            const bound = findVariable(sourceCode, declarator.id);
            if (!bound) continue;
            const target = ZOD_SAFE_PARSE_METHODS.has(parts.method)
              ? safeResults
              : validatedBy;
            target.set(bound, { path, node });
            continue;
          }
          const dataBinding = safeParseDataBinding(declarator);
          const bound = dataBinding && findVariable(sourceCode, dataBinding);
          if (bound) validatedBy.set(bound, { path, node });
        }
      };

      const enterFunction = (node) => functionStack.push(node);
      const exitFunction = () => functionStack.pop();

      return {
        ArrowFunctionExpression: enterFunction,
        "ArrowFunctionExpression:exit": exitFunction,
        FunctionDeclaration: enterFunction,
        "FunctionDeclaration:exit": exitFunction,
        FunctionExpression: enterFunction,
        "FunctionExpression:exit": exitFunction,
        AssignmentExpression(node) {
          addWrite(node.left, node);
          // Storing the value somewhere else hands it to a holder that can be
          // mutated through, so the right-hand side escapes too.
          addEscape(node.right, node);
        },
        UpdateExpression(node) {
          addWrite(node.argument, node);
        },
        UnaryExpression(node) {
          if (node.operator === "delete") addWrite(node.argument, node);
        },
        NewExpression(node) {
          addCallHazards(node);
        },
        CallExpression(node) {
          addCallHazards(node);
          const parts = validationCallParts(node);
          if (!parts || isThrowAssertionCallbackParse(node)) return;
          const path = canonicalPath(sourceCode, parts.receiver);
          if (!path || !isStableRoot(path.variable)) return;
          if (!schemaOrigin(sourceCode, path, options)) return;
          calls.push({ node, parts, path });
        },
        "Program:exit"() {
          analyze();
        },
      };
    },
  };
}
