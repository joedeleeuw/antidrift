import { isRuleFile, scopeProperties } from "./scope.js";
import { isTestFilename } from "./syntax.js";

const HOST_PATH = /^\/(?:Users|home)\/(?!linuxbrew\/)[^/]+\//;

function staticPrefix(node) {
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }
  if (node.type === "TemplateLiteral") return node.quasis[0].value.cooked;
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow host-absolute /home/<user>/ and /Users/<user>/ path literals.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      hostPath:
        "Host-absolute path literal. Resolve the path from the home directory, the repository root, or configuration.",
    },
  },
  create(context) {
    if (!isRuleFile(context) || isTestFilename(context.filename)) return {};

    function check(node) {
      const text = staticPrefix(node);
      if (text !== null && HOST_PATH.test(text)) {
        context.report({ node, messageId: "hostPath" });
      }
    }

    return { Literal: check, TemplateLiteral: check };
  },
};
