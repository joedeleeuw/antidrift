// Rule ported from getsentry/sentry static/eslint/eslintPluginSentry
// (no-calling-components-as-functions). See that repo's LICENSE.
import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import {
  functionReturnsJsx,
  isFunctionLike,
  unwrapExpression,
} from "../../semantic-adapters/local-ast-rules.mjs";

const IGNORED_NAMES = new Set(["OverrideOrDefault"]);
const NOT_PASCAL_CASE_RE = /^[A-Z][A-Z\d]*_|^[A-Z][A-Z\d_]*$/u;

function shouldSkip(name) {
  return (
    IGNORED_NAMES.has(name) ||
    name.endsWith("Fixture") ||
    NOT_PASCAL_CASE_RE.test(name)
  );
}

function propertyKeyName(key) {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  return null;
}

function propertyToAttr(prop, sourceCode) {
  if (prop.type === "SpreadElement") {
    return `{...${sourceCode.getText(prop.argument)}}`;
  }
  if (prop.type !== "Property" || prop.computed) return null;
  const keyName = propertyKeyName(prop.key);
  if (keyName === null) return null;
  if (prop.shorthand) return `${keyName}={${keyName}}`;
  return `${keyName}={${sourceCode.getText(prop.value)}}`;
}

function buildJsxFix(fixer, node, name, arg, sourceCode) {
  if (!arg) return fixer.replaceText(node, `<${name} />`);
  if (arg.type === "Identifier") {
    return fixer.replaceText(node, `<${name} {...${arg.name}} />`);
  }
  if (arg.type !== "ObjectExpression") return null;
  if (arg.properties.length === 0) {
    return fixer.replaceText(node, `<${name} />`);
  }
  const attrs = [];
  for (const prop of arg.properties) {
    const attr = propertyToAttr(prop, sourceCode);
    if (attr === null) return null;
    attrs.push(attr);
  }
  return fixer.replaceText(node, `<${name} ${attrs.join(" ")} />`);
}

const COMPONENT_WRAPPERS = new Set(["forwardRef", "memo"]);

// JSX in these files belongs to another framework, where calling a
// JSX-returning function is ordinary. JSX with no framework import stays in
// scope because React's automatic runtime needs no import.
const NON_REACT_JSX_SOURCE = /^(?:solid-js|@builder\.io\/qwik|vue)(?:\/|$)/u;

function isNonReactJsxFile(program) {
  let importsPreact = false;
  let importsPreactCompat = false;
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = statement.source.value;
    if (NON_REACT_JSX_SOURCE.test(source)) return true;
    if (/^preact\/compat(?:\/|$)/u.test(source)) importsPreactCompat = true;
    else if (/^preact(?:\/|$)/u.test(source)) importsPreact = true;
  }
  return importsPreact && !importsPreactCompat;
}

function moduleExportName(node) {
  if (node?.type === "Identifier") return node.name;
  return typeof node?.value === "string" ? node.value : null;
}

function reactImportSpecifier(sourceCode, identifier) {
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  if (definition?.type !== "ImportBinding") return null;
  return definition.parent?.source?.value === "react" ? definition.node : null;
}

function isReactNamespace(sourceCode, node) {
  const specifier = reactImportSpecifier(sourceCode, node);
  return (
    specifier?.type === "ImportDefaultSpecifier" ||
    specifier?.type === "ImportNamespaceSpecifier" ||
    (specifier?.type === "ImportSpecifier" &&
      moduleExportName(specifier.imported) === "default")
  );
}

// Only React's own forwardRef/memo (named, aliased, default or namespace
// import) prove a component; a local helper spelled `memo` does not.
function isComponentWrapperCall(sourceCode, node) {
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier") {
    const specifier = reactImportSpecifier(sourceCode, callee);
    return (
      specifier?.type === "ImportSpecifier" &&
      COMPONENT_WRAPPERS.has(moduleExportName(specifier.imported))
    );
  }
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    COMPONENT_WRAPPERS.has(callee.property.name) &&
    isReactNamespace(sourceCode, callee.object)
  );
}

// A callee is a component only when its binding resolves in scope, through
// local aliases, to a function that lexically returns JSX, or to a React
// forwardRef/memo wrapper. Imported and otherwise unresolvable callees are not
// reported.
function resolvesToComponent(sourceCode, identifier, seen = new Set()) {
  const variable = findVariable(sourceCode, identifier);
  if (!variable || seen.has(variable)) return false;
  seen.add(variable);
  const definition = variable.defs?.[0];
  if (definition?.type === "FunctionName") {
    return functionReturnsJsx(definition.node);
  }
  if (
    definition?.type !== "Variable" ||
    definition.node.id?.type !== "Identifier"
  ) {
    return false;
  }
  const init = unwrapExpression(definition.node.init);
  if (init?.type === "Identifier") {
    return resolvesToComponent(sourceCode, init, seen);
  }
  if (isFunctionLike(init)) return functionReturnsJsx(init);
  return isComponentWrapperCall(sourceCode, init);
}

export default function ruleNoCallingComponentsAsFunctions() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow calling React components as functions. Use JSX syntax instead",
      },
      fixable: "code",
      schema: [],
      messages: {
        noCallingComponentAsFunction:
          '"{{name}}" appears to be a React component. Use <{{name}} /> instead of calling it as a function.',
      },
    },
    create(context) {
      let nonReactJsx = false;
      return {
        Program(node) {
          nonReactJsx = isNonReactJsxFile(node);
        },
        CallExpression(node) {
          if (nonReactJsx || node.callee.type !== "Identifier") return;
          const name = node.callee.name;
          if (!/^[A-Z]/u.test(name) || shouldSkip(name)) return;
          if (!resolvesToComponent(context.sourceCode, node.callee)) return;
          if (node.arguments.length > 1) return;
          const arg = node.arguments[0];
          if (
            arg &&
            arg.type !== "ObjectExpression" &&
            arg.type !== "Identifier"
          ) {
            return;
          }
          context.report({
            node,
            messageId: "noCallingComponentAsFunction",
            data: { name },
            fix(fixer) {
              return buildJsxFix(fixer, node, name, arg, context.sourceCode);
            },
          });
        },
      };
    },
  };
}
