import { isRuleFile, scopeProperties } from "./scope.js";
import { getImportedName } from "./ast.js";

const HOTKEY_MODULES = new Set([
  "@tanstack/hotkeys",
  "@tanstack/react-hotkeys",
]);
const AMBIENT_EXPORTS = new Set(["detectPlatform", "formatForDisplay"]);
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      ambientHotkeyFormat:
        "Ambient hotkey platform reads can differ between SSR and hydration. Use useHydrationSafeHotkeyPlatform() with formatHotkeyForPlatform().",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return {
      ImportDeclaration(node) {
        if (!HOTKEY_MODULES.has(node.source?.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            context.report({
              node: specifier,
              messageId: "ambientHotkeyFormat",
            });
            continue;
          }
          if (specifier.type !== "ImportSpecifier") {
            continue;
          }
          const importedName = getImportedName(specifier);
          if (importedName !== null && AMBIENT_EXPORTS.has(importedName)) {
            context.report({
              node: specifier,
              messageId: "ambientHotkeyFormat",
            });
          }
        }
      },
    };
  },
};
