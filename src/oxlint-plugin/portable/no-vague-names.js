import {
  isRuleFile,
  scopeProperties,
} from "../../oxlint-plugin/shared/rule-scope.js";
import { splitIdentifierWords } from "../../oxlint-plugin/shared/scope.js";
import { patternIdentifiers } from "./static-resolution.js";

const VAGUE_NOUN =
  /^(?:data|info|value|values|val|vals|obj|objects|objs|thing|things|stuff|temp|tmp|foo|bar|baz|res|ret|retval|misc|result|results|item|items|var|vars|variable|content|contents|param|params|parameters|arr|spam|ham|toto|tutu|tata)\d*$/i;
const FILLER_SUFFIX = /^\w+(?:Value|Data|Info|Obj|Object|Thing|Stuff)$/;
const SNAKE_FILLER_SUFFIX = /^\w+_(?:value|data|info|obj|object|thing|stuff)$/;
const FILLER_PREFIX = /^(?:my|the|some|temp|tmp)[A-Z_]/;
const ABBREVIATION = /^([a-z]+)\d*$/;
const SINGLE_LETTER = /^[a-hl-mo-wzA-HL-MO-WZ]$/;
const EXEMPT_NAME =
  /^(?:te?mp_?(?:dir|directory|file|path|root|base|home)s?|formData|imageData|loaderData|actionData|routeData|staticData|metaData)$/i;
const QUERY_BUILDER_METHODS = new Set([
  "withIndex",
  "withSearchIndex",
  "filter",
]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

function isJsx(node) {
  if (!node) return false;
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true;
  if (node.type === "ConditionalExpression") {
    return isJsx(node.consequent) || isJsx(node.alternate);
  }
  return node.type === "LogicalExpression" && isJsx(node.right);
}

const ABBREVIATIONS = new Map(
  Object.entries({
    cb: "callback",
    ctx: "context",
    el: "element",
    err: "error",
    evt: "event",
    fn: "function",
    msg: "message",
    opts: "options",
    props: "properties",
    req: "request",
    str: "string",
  })
);

function vagueReason(name) {
  if (EXEMPT_NAME.test(name)) return null;
  if (VAGUE_NOUN.test(name)) return "a vague noun";
  const abbreviation = ABBREVIATION.exec(name)?.[1];
  if (ABBREVIATIONS.has(abbreviation)) {
    return `an abbreviation of '${ABBREVIATIONS.get(abbreviation)}'`;
  }
  if (SINGLE_LETTER.test(name)) return "a single letter";
  if (FILLER_SUFFIX.test(name) || SNAKE_FILLER_SUFFIX.test(name)) {
    return "a filler suffix";
  }
  if (FILLER_PREFIX.test(name)) return "a filler prefix";
  return null;
}

function duplicateContextWord(name) {
  const words = splitIdentifierWords(name);
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const current = words[index];
    if (previous && current && previous === current) return current;
  }
  return null;
}

class BindingNames {
  constructor(context) {
    this.context = context;
  }
  isParameterIdentifier = (identifier) => {
    let cur = identifier;
    while (cur?.parent) {
      const parent = cur.parent;
      if (FUNCTION_TYPES.has(parent.type)) {
        return parent.params.includes(cur);
      }
      if (
        parent.type === "AssignmentPattern" ||
        parent.type === "RestElement" ||
        parent.type === "ArrayPattern" ||
        parent.type === "ObjectPattern" ||
        parent.type === "Property" ||
        parent.type === "TSParameterProperty"
      ) {
        cur = parent;
        continue;
      }
      return false;
    }
    return false;
  };

  isQueryBuilderParam = (identifier) => {
    if (identifier.name !== "q") return false;
    const fnNode = identifier.parent;
    if (!FUNCTION_TYPES.has(fnNode?.type) || fnNode.params[0] !== identifier) {
      return false;
    }
    const callNode = fnNode.parent;
    return (
      callNode?.type === "CallExpression" &&
      callNode.callee?.type === "MemberExpression" &&
      !callNode.callee.computed &&
      callNode.callee.property?.type === "Identifier" &&
      QUERY_BUILDER_METHODS.has(callNode.callee.property.name)
    );
  };

  isUnknownCandidateParam = (identifier) => {
    if (identifier.name !== "value") return false;
    if (
      identifier.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword"
    ) {
      return true;
    }
    const fnNode = identifier.parent;
    return (
      FUNCTION_TYPES.has(fnNode?.type) &&
      fnNode.returnType?.typeAnnotation?.type === "TSTypePredicate"
    );
  };

  isTestHarnessVariable = (identifier) => {
    if (identifier.name !== "t") return false;
    const decl = identifier.parent;
    if (decl?.type !== "VariableDeclarator" || decl.id !== identifier) {
      return false;
    }
    const init = decl.init;
    return (
      init?.type === "CallExpression" &&
      init.callee?.type === "Identifier" &&
      (init.callee.name === "convexTest" ||
        init.callee.name === "useTranslation")
    );
  };

  check = (identifier) => {
    if (identifier?.type !== "Identifier") return;
    if (identifier.name === "ctx" && this.isParameterIdentifier(identifier)) {
      const ctxAnnType = identifier.typeAnnotation?.typeAnnotation?.type ?? "";
      if (ctxAnnType !== "TSTypeLiteral" && !ctxAnnType.endsWith("Keyword")) {
        return;
      }
    }
    if (this.isQueryBuilderParam(identifier)) return;
    if (this.isUnknownCandidateParam(identifier)) return;
    if (this.isTestHarnessVariable(identifier)) return;
    const reason = vagueReason(identifier.name);
    if (reason) {
      this.context.report({
        node: identifier,
        messageId: "vague",
        data: { name: identifier.name, reason },
      });
    }
  };

  visitImportSpecifier = (node) => {
    const importedName = node.imported?.name;
    const localName = node.local?.name;
    if (
      typeof importedName === "string" &&
      typeof localName === "string" &&
      localName === `${importedName}Type`
    ) {
      this.context.report({
        node: node.local,
        messageId: "vague",
        data: { name: localName, reason: "a filler 'Type' alias suffix" },
      });
    }
  };

  checkDuplicateContext = (nameNode, reportNode) => {
    let name = null;
    if (nameNode?.type === "Identifier") name = nameNode.name;
    if (nameNode?.type === "Literal" && typeof nameNode.value === "string") {
      name = nameNode.value;
    }
    if (!name) return;
    const word = duplicateContextWord(name);
    if (word) {
      this.context.report({
        node: reportNode,
        messageId: "duplicate",
        data: { name, word },
      });
    }
  };

  checkPattern = (pattern) => {
    for (const identifier of patternIdentifiers(pattern, {
      skipShorthand: true,
    })) {
      this.check(identifier);
    }
  };

  returnsJsx = (node) => {
    if (node.body.type !== "BlockStatement") return isJsx(node.body);
    const pending = [node.body];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current.type === "ReturnStatement" && isJsx(current.argument)) {
        return true;
      }
      for (const key of this.context.sourceCode.visitorKeys[current.type] ??
        []) {
        for (const child of [current[key]].flat()) {
          if (child?.type && !FUNCTION_TYPES.has(child.type)) {
            pending.push(child);
          }
        }
      }
    }
    return false;
  };

  isComponent = (node) => {
    const declName =
      node.parent.type === "VariableDeclarator" &&
      node.parent.id?.type === "Identifier"
        ? node.parent.id.name
        : "";
    const name = node.id?.name ?? declName;
    return /^[A-Z]/.test(name) || this.returnsJsx(node);
  };

  checkFunction = (node) => {
    if (node.type !== "ArrowFunctionExpression") this.check(node.id);
    if (node.type === "FunctionDeclaration") {
      this.checkDuplicateContext(node.id, node);
    }
    for (const [index, parameter] of node.params.entries()) {
      if (
        index === 0 &&
        parameter.type === "Identifier" &&
        parameter.name === "props" &&
        this.isComponent(node)
      ) {
        continue;
      }
      this.checkPattern(parameter);
    }
  };

  visitVariableDeclarator = (node) => {
    this.checkPattern(node.id);
    if (
      node.init?.type === "ArrowFunctionExpression" ||
      node.init?.type === "FunctionExpression"
    ) {
      this.checkDuplicateContext(node.id, node);
    }
  };

  visitMethodDefinition = (node) => {
    this.checkDuplicateContext(node.key, node);
  };

  visitCatchClause = (node) => {
    this.checkPattern(node.param);
  };

  visitClassDeclaration = (node) => {
    this.check(node.id);
  };
  listeners() {
    return {
      ImportSpecifier: this.visitImportSpecifier,
      VariableDeclarator: this.visitVariableDeclarator,
      FunctionDeclaration: this.checkFunction,
      FunctionExpression: this.checkFunction,
      ArrowFunctionExpression: this.checkFunction,
      MethodDefinition: this.visitMethodDefinition,
      CatchClause: this.visitCatchClause,
      ClassDeclaration: this.visitClassDeclaration,
    };
  }
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow vague names, filler affixes, abbreviations, and repeated adjacent context words.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      vague:
        "'{{name}}' is {{reason}}. Name the binding for what it holds in this domain.",
      duplicate:
        "Function '{{name}}' repeats '{{word}}'. Remove duplicate context from the identifier.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new BindingNames(context).listeners();
  },
};
