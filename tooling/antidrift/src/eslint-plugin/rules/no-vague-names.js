import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";

const VAGUE_NOUN =
  /^(?:data|info|value|values|val|vals|obj|objects|objs|thing|things|stuff|temp|tmp|foo|bar|baz|res|ret|retval|misc|result|results|item|items|var|vars|variable|content|contents|param|params|parameters|arr|spam|ham|toto|tutu|tata)\d*$/i;
const FILLER_SUFFIX = /^\w+(?:Value|Data|Info|Obj|Object|Thing|Stuff)$/;
const SNAKE_FILLER_SUFFIX = /^\w+_(?:value|data|info|obj|object|thing|stuff)$/;
const FILLER_PREFIX = /^(?:my|the|some|temp|tmp)[A-Z_]/;
const ABBREVIATION = /^([a-z]+)\d*$/;
const SINGLE_LETTER = /^[a-hl-mo-wzA-HL-MO-WZ]$/;
const EXEMPT_NAME =
  /^(?:te?mp_?(?:dir|directory|file|path|root|base|home)s?|formData|imageData)$/i;
const CONTEXT_TYPE_NAME = /(?:Ctx|Context)$/;
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

function* typeReferenceNames(typeNode) {
  if (!typeNode) return;
  switch (typeNode.type) {
    case "TSTypeAnnotation":
      yield* typeReferenceNames(typeNode.typeAnnotation);
      return;
    case "TSTypeReference": {
      const { typeName } = typeNode;
      yield typeName.type === "TSQualifiedName"
        ? typeName.right.name
        : typeName.name;
      return;
    }
    case "TSUnionType":
    case "TSIntersectionType":
      for (const member of typeNode.types) yield* typeReferenceNames(member);
      return;
    default:
  }
}

function* typeSymbolNames(type) {
  if (!type) return;
  if (type.isUnionOrIntersection()) {
    for (const member of type.types) yield* typeSymbolNames(member);
  }
  if (type.aliasSymbol) yield type.aliasSymbol.name;
  if (type.symbol) yield type.symbol.name;
}

function* patternIdentifiers(node) {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      yield node;
      return;
    case "AssignmentPattern":
      yield* patternIdentifiers(node.left);
      return;
    case "RestElement":
      yield* patternIdentifiers(node.argument);
      return;
    case "ArrayPattern":
      for (const element of node.elements) yield* patternIdentifiers(element);
      return;
    case "ObjectPattern":
      for (const property of node.properties) {
        yield* patternIdentifiers(
          property.type === "RestElement" ? property : property.value
        );
      }
      return;
    case "TSParameterProperty":
      yield* patternIdentifiers(node.parameter);
      return;
    default:
  }
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow declared names that are vague nouns, abbreviations, single letters, or filler affixes.",
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
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const services =
      context.sourceCode?.parserServices ?? context.parserServices;
    const checker = services?.program?.getTypeChecker?.();

    // `ctx` is a framework's own vocabulary when the binding's type says so:
    // a declared `QueryCtx | MutationCtx`, a local alias such as `DatabaseCtx`,
    // or, with type services, the context type a handler slot infers.
    function isFrameworkContext(identifier) {
      if (identifier.name !== "ctx") return false;
      if (identifier.typeAnnotation) {
        return [...typeReferenceNames(identifier.typeAnnotation)].some((name) =>
          CONTEXT_TYPE_NAME.test(name)
        );
      }
      const tsNode = services?.esTreeNodeToTSNodeMap?.get(identifier);
      if (!checker || !tsNode) return false;
      return [...typeSymbolNames(checker.getTypeAtLocation(tsNode))].some(
        (name) => CONTEXT_TYPE_NAME.test(name)
      );
    }

    function check(identifier) {
      if (identifier?.type !== "Identifier") return;
      if (isFrameworkContext(identifier)) return;
      const reason = vagueReason(identifier.name);
      if (reason) {
        context.report({
          node: identifier,
          messageId: "vague",
          data: { name: identifier.name, reason },
        });
      }
    }
    function checkPattern(pattern) {
      for (const identifier of patternIdentifiers(pattern)) check(identifier);
    }
    function returnsJsx(node) {
      if (node.body.type !== "BlockStatement") return isJsx(node.body);
      const pending = [node.body];
      while (pending.length > 0) {
        const current = pending.pop();
        if (current.type === "ReturnStatement" && isJsx(current.argument)) {
          return true;
        }
        for (const key of context.sourceCode.visitorKeys[current.type] ?? []) {
          for (const child of [current[key]].flat()) {
            if (child?.type && !FUNCTION_TYPES.has(child.type)) {
              pending.push(child);
            }
          }
        }
      }
      return false;
    }
    function isComponent(node) {
      const name =
        node.id?.name ??
        (node.parent.type === "VariableDeclarator" ? node.parent.id.name : "");
      return /^[A-Z]/.test(name ?? "") || returnsJsx(node);
    }
    function checkFunction(node) {
      if (node.type !== "ArrowFunctionExpression") check(node.id);
      for (const [index, parameter] of node.params.entries()) {
        if (
          index === 0 &&
          parameter.type === "Identifier" &&
          parameter.name === "props" &&
          isComponent(node)
        ) {
          continue;
        }
        checkPattern(parameter);
      }
    }

    return {
      VariableDeclarator(node) {
        checkPattern(node.id);
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      CatchClause(node) {
        checkPattern(node.param);
      },
      ClassDeclaration(node) {
        check(node.id);
      },
    };
  },
};
