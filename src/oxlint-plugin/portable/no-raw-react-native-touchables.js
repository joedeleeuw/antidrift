import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";

const RAW_TOUCHABLES = new Set([
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
  "TouchableNativeFeedback",
]);

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing raw React Native `Touchable*` components directly from `react-native`; use `Pressable` or the design-system interaction primitive.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...scopeProperties,
          forbidPressable: { type: "boolean" },
          replacementImport: { type: "string" },
        },
      },
    ],
    messages: {
      rawTouchable:
        "Do not import '{{name}}' directly from 'react-native'; use {{replacement}} instead.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const option = context.options?.[0];
    const forbidPressable = option?.forbidPressable === true;
    const replacement =
      typeof option?.replacementImport === "string" &&
      option.replacementImport.length > 0
        ? `'${option.replacementImport}'`
        : "`Pressable` or your design-system Pressable wrapper";

    return {
      ImportDeclaration(node) {
        if (
          node.importKind === "type" ||
          node.source?.value !== "react-native"
        ) {
          return;
        }
        for (const spec of node.specifiers ?? []) {
          if (spec.type !== "ImportSpecifier" || spec.importKind === "type") {
            continue;
          }
          const importedName =
            spec.imported?.type === "Identifier"
              ? spec.imported.name
              : spec.imported?.value;
          if (typeof importedName !== "string") continue;
          if (
            RAW_TOUCHABLES.has(importedName) ||
            (forbidPressable && importedName === "Pressable")
          ) {
            context.report({
              node: spec,
              messageId: "rawTouchable",
              data: { name: importedName, replacement },
            });
          }
        }
      },
    };
  },
};
