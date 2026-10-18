import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";
import { isTestFilename } from "./syntax.js";

const HASH = /^[0-9a-fA-F]{64}$/;
const HASH_NAME = /hash|sha\d*|digest|checksum|integrity/i;

function staticText(node) {
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function nameOf(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  if (node.type === "MemberExpression" && !node.computed) {
    return node.property.name;
  }
  return "";
}

const TYPE_WRAPPERS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function bindingName(node) {
  let literal = node;
  while (TYPE_WRAPPERS.has(literal.parent?.type)) literal = literal.parent;
  const { parent } = literal;
  switch (parent.type) {
    case "VariableDeclarator":
      return nameOf(parent.id);
    case "Property":
    case "PropertyDefinition":
      return parent.value === literal ? nameOf(parent.key) : "";
    case "AssignmentExpression":
      return nameOf(parent.left);
    case "BinaryExpression":
      return nameOf(parent.left === literal ? parent.right : parent.left);
    default:
      return "";
  }
}

const DOWNLOAD_KEY = /^(?:url|href|downloadUrl|download_url)$/i;

// A digest beside the URL it was fetched from is the integrity of a remote
// artifact the record describes, not a pin of a tracked file.
function describesDownload(literal) {
  let node = literal;
  while (TYPE_WRAPPERS.has(node.parent?.type)) node = node.parent;
  const property = node.parent;
  if (property?.type !== "Property" || property.value !== node) return false;
  return property.parent.properties.some(
    (sibling) =>
      sibling.type === "Property" && DOWNLOAD_KEY.test(nameOf(sibling.key))
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow 64-hex hash literals that pin the content of a file or artifact.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      hashLiteral:
        "'{{name}}' pins content with a 64-hex hash literal. Repo content does not get pinned; third-party artifact pins belong in lockfiles.",
    },
  },
  create(context) {
    // A test's expected digest is an oracle, not a pin of repository content.
    if (!isRuleFile(context) || isTestFilename(context.filename)) return {};

    function check(node) {
      const text = staticText(node);
      if (text === null || !HASH.test(text)) return;
      const name = bindingName(node);
      if (HASH_NAME.test(name) && !describesDownload(node)) {
        context.report({ node, messageId: "hashLiteral", data: { name } });
      }
    }

    return { Literal: check, TemplateLiteral: check };
  },
};
