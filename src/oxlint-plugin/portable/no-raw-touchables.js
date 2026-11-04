import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";

const RAW_TOUCHABLE_NAMES = new Set([
  "LegacyBaseButton",
  "LegacyBorderlessButton",
  "LegacyPressable",
  "LegacyRawButton",
  "LegacyRectButton",
  "TouchableHighlight",
  "TouchableNativeFeedback",
  "TouchableOpacity",
  "TouchableWithoutFeedback",
]);

const DESIGN_SYSTEM_GATED_NAMES = new Set(["Button", "Pressable", "Touchable"]);

const TOUCHABLE_MODULES = new Set([
  "react-native",
  "react-native-gesture-handler",
]);

function isForbiddenTouchable(importedName, forbidPressable) {
  return (
    RAW_TOUCHABLE_NAMES.has(importedName) ||
    (forbidPressable && DESIGN_SYSTEM_GATED_NAMES.has(importedName))
  );
}

function specifierName(node) {
  return node?.type === "Identifier" ? node.name : node?.value;
}

function checkSpecifiers(node, forbidPressable, replacement, context) {
  const source = node.source?.value;
  if (!TOUCHABLE_MODULES.has(source)) return;
  for (const spec of node.specifiers ?? []) {
    if (spec.importKind === "type" || spec.exportKind === "type") continue;
    if (
      forbidPressable &&
      (spec.type === "ImportNamespaceSpecifier" ||
        spec.type === "ImportDefaultSpecifier")
    ) {
      context.report({
        node: spec,
        messageId: "rawTouchableModule",
        data: { source, replacement },
      });
      continue;
    }
    const importedName = specifierName(spec.imported ?? spec.local);
    if (
      typeof importedName === "string" &&
      isForbiddenTouchable(importedName, forbidPressable)
    ) {
      context.report({
        node: spec,
        messageId: "rawTouchable",
        data: { name: importedName, source, replacement },
      });
    }
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing legacy touchable primitives (`Touchable*`, `Legacy*Button`) from `react-native` or `react-native-gesture-handler`, or bypassing the shared interaction wrapper when `forbidPressable: true`.",
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
        "Do not import '{{name}}' directly from '{{source}}'; use {{replacement}} instead.",
      rawTouchableModule:
        "Do not import or re-export the '{{source}}' module namespace directly; use {{replacement}} instead.",
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
        : "`Pressable` / RNGH `Touchable` or your design-system interaction primitive";

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        checkSpecifiers(node, forbidPressable, replacement, context);
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === "type") return;
        checkSpecifiers(node, forbidPressable, replacement, context);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === "type" || !forbidPressable) return;
        const source = node.source?.value;
        if (TOUCHABLE_MODULES.has(source)) {
          context.report({
            node,
            messageId: "rawTouchableModule",
            data: { source, replacement },
          });
        }
      },
    };
  },
};
