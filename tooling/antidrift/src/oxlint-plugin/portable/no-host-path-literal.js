import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";
import { isTestFilename } from "./syntax.js";

const HOST_PATH = /^\/(?:Users|home)\/(?!linuxbrew\/)[^/]+\//;
// Stories, module mocks and end-to-end guests hold sample data and paths
// inside provisioned machines, not the developer's host.
const SAMPLE_DATA_PATH = /\.stories\.[cm]?[jt]sx?$|(?:^|\/)(?:__mocks__|e2e)\//;

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
    const filename = (context.filename ?? "").replaceAll("\\", "/");
    if (
      !isRuleFile(context) ||
      isTestFilename(filename) ||
      SAMPLE_DATA_PATH.test(filename)
    ) {
      return {};
    }

    function check(node) {
      const text = staticPrefix(node);
      if (text !== null && HOST_PATH.test(text)) {
        context.report({ node, messageId: "hostPath" });
      }
    }

    return { Literal: check, TemplateLiteral: check };
  },
};
