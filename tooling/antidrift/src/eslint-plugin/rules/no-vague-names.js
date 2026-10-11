import { isRuleFile, scopeProperties } from "../../oxlint-plugin/portable/scope.js";

const VAGUE_NOUN =
  /^(?:data|info|value|val|obj|thing|stuff|temp|tmp|foo|bar|baz|res|ret|retval|misc)\d*$/;
const FILLER_SUFFIX = /^\w+(?:Value|Data|Info|Obj|Object|Thing|Stuff)$/;
const FILLER_PREFIX = /^(?:my|the|some|temp|tmp)[A-Z]/;
const ALLOWED_SINGLE_LETTERS = new Set(["i", "j", "k", "n", "x", "y", "_"]);
const PLATFORM_INSTANCE_NAMES = new Set(["formData", "imageData"]);
const TEMPORARY_PATH =
  /^(?:temp|tmp)(?:Dir|Directory|File|Path|Root|Base|Home)s?$/;
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
    acc: "accumulator",
    arg: "argument",
    args: "arguments",
    arr: "array",
    attr: "attribute",
    attrs: "attributes",
    btn: "button",
    buf: "buffer",
    cb: "callback",
    cfg: "config",
    cmd: "command",
    conf: "config",
    ctx: "context",
    cur: "current",
    curr: "current",
    db: "database",
    decl: "declaration",
    decls: "declarations",
    def: "definition",
    dep: "dependency",
    deps: "dependencies",
    dest: "destination",
    dev: "development",
    dir: "directory",
    dirs: "directories",
    dist: "distribution",
    doc: "document",
    docs: "documents",
    dst: "destination",
    e: "error or event",
    el: "element",
    elem: "element",
    elems: "elements",
    env: "environment",
    envs: "environments",
    err: "error",
    ev: "event",
    evt: "event",
    expr: "expression",
    exprs: "expressions",
    ext: "extension",
    exts: "extensions",
    fn: "function",
    func: "function",
    ident: "identifier",
    idents: "identifiers",
    idx: "index",
    len: "length",
    lib: "library",
    mod: "module",
    msg: "message",
    num: "number",
    obj: "object",
    opts: "options",
    param: "parameter",
    params: "parameters",
    perf: "performance",
    pkg: "package",
    prev: "previous",
    prod: "production",
    prop: "property",
    props: "properties",
    proto: "prototype",
    ref: "reference",
    refs: "references",
    rel: "relative",
    repo: "repository",
    req: "request",
    res: "response or result",
    ret: "returnValue",
    retval: "returnValue",
    sep: "separator",
    src: "source",
    stdDev: "standardDeviation",
    stmt: "statement",
    stmts: "statements",
    str: "string",
    tbl: "table",
    temp: "temporary",
    tit: "title",
    tmp: "temporary",
    util: "utility",
    utils: "utilities",
    val: "value",
    var: "variable",
    vars: "variables",
    ver: "version",
  }),
);

function vagueReason(name) {
  if (VAGUE_NOUN.test(name)) return "a vague noun";
  if (ABBREVIATIONS.has(name)) {
    return `an abbreviation of '${ABBREVIATIONS.get(name)}'`;
  }
  if (name.length === 1 && !ALLOWED_SINGLE_LETTERS.has(name)) {
    return "a single letter";
  }
  if (FILLER_SUFFIX.test(name) && !PLATFORM_INSTANCE_NAMES.has(name)) {
    return "a filler suffix";
  }
  if (FILLER_PREFIX.test(name) && !TEMPORARY_PATH.test(name)) {
    return "a filler prefix";
  }
  return null;
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
          property.type === "RestElement" ? property : property.value,
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

    function check(identifier) {
      if (identifier?.type !== "Identifier") return;
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
