const forbiddenImports = new Map([
  [
    "react-native",
    new Set([
      "Pressable",
      "TouchableHighlight",
      "TouchableNativeFeedback",
      "TouchableOpacity",
      "TouchableWithoutFeedback",
    ]),
  ],
  [
    "react-native-gesture-handler",
    new Set([
      "LegacyBaseButton",
      "LegacyBorderlessButton",
      "LegacyPressable",
      "LegacyRawButton",
      "LegacyRectButton",
      "Pressable",
      "Touchable",
      "TouchableHighlight",
      "TouchableNativeFeedback",
      "TouchableOpacity",
      "TouchableWithoutFeedback",
    ]),
  ],
]);

function normalizedPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function contextFilename(context) {
  return typeof context.getFilename === "function"
    ? context.getFilename()
    : (context.filename ?? "");
}

function normalizedOwnerPath(value) {
  const normalized = normalizedPath(value);
  if (
    !normalized.includes("/") ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    /[!*?{}()[\]]/u.test(normalized)
  ) {
    throw new TypeError(
      "allowedFiles entries must be exact repository-relative owner paths containing at least one directory",
    );
  }
  return normalized;
}

function normalizedOptions(value) {
  return {
    allowedFiles: Array.isArray(value?.allowedFiles)
      ? value.allowedFiles.map(normalizedOwnerPath)
      : [],
    replacementImport:
      typeof value?.replacementImport === "string"
        ? value.replacementImport
        : "the app-owned interaction module",
  };
}

function isAllowedFile(filename, allowedFiles) {
  const normalized = normalizedPath(filename);
  return allowedFiles.some(
    (allowed) => normalized === allowed || normalized.endsWith(`/${allowed}`),
  );
}

function sourceName(node) {
  return typeof node.source?.value === "string" ? node.source.value : null;
}

function importedName(specifier) {
  if (specifier.type === "ImportNamespaceSpecifier") return "namespace import";
  if (specifier.type === "ImportDefaultSpecifier") return "default import";
  if (
    specifier.type !== "ImportSpecifier" &&
    specifier.type !== "ExportSpecifier"
  ) {
    return null;
  }
  if (specifier.imported?.type === "Identifier") return specifier.imported.name;
  if (typeof specifier.imported?.value === "string") {
    return specifier.imported.value;
  }
  if (specifier.local?.type === "Identifier") return specifier.local.name;
  if (typeof specifier.local?.value === "string") return specifier.local.value;
  return null;
}

function isTypeOnly(node, specifier) {
  return (
    node.importKind === "type" ||
    node.exportKind === "type" ||
    specifier?.importKind === "type" ||
    specifier?.exportKind === "type"
  );
}

function shouldReportSpecifier(specifier, forbidden) {
  const name = importedName(specifier);
  return {
    broad: name === "namespace import" || name === "default import",
    imported: name,
    report:
      name === "namespace import" ||
      name === "default import" ||
      (name !== null && forbidden.has(name)),
  };
}

function report(
  context,
  node,
  source,
  imported,
  replacementImport,
  broad = false,
) {
  context.report({
    node,
    messageId: broad ? "rawTouchableNamespace" : "rawTouchableImport",
    data: {
      imported,
      replacementImport,
      source,
    },
  });
}

export default function ruleNoRawReactNativeTouchables() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require React Native touch interactions to use one app-owned Touchable policy",
      },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            allowedFiles: {
              type: "array",
              items: { type: "string", minLength: 1 },
              uniqueItems: true,
            },
            replacementImport: { type: "string", minLength: 1 },
          },
        },
      ],
      messages: {
        rawTouchableImport:
          'Raw {{imported}} access from "{{source}}" bypasses the app-owned interaction policy. Import the shared Touchable from {{replacementImport}} and choose a named feedback preset. If this needs router-link or custom gesture semantics, add a narrow app-owned adapter and register only its owner file in allowedFiles.',
        rawTouchableNamespace:
          'Raw {{imported}} access from "{{source}}" can bypass the app-owned interaction policy. Import non-interaction APIs by name. For a touch target, import the shared Touchable from {{replacementImport}} and choose a named feedback preset; custom semantics belong in a narrow registered adapter.',
      },
    },
    create(context) {
      const options = normalizedOptions(context.options?.[0]);
      if (isAllowedFile(contextFilename(context), options.allowedFiles)) {
        return {};
      }

      return {
        ImportDeclaration(node) {
          if (isTypeOnly(node)) return;
          const source = sourceName(node);
          const forbidden = source ? forbiddenImports.get(source) : null;
          if (!source || !forbidden) return;
          for (const specifier of node.specifiers) {
            if (isTypeOnly(node, specifier)) continue;
            const result = shouldReportSpecifier(specifier, forbidden);
            if (result.report) {
              report(
                context,
                specifier,
                source,
                result.imported,
                options.replacementImport,
                result.broad,
              );
            }
          }
        },
        ExportAllDeclaration(node) {
          if (isTypeOnly(node)) return;
          const source = sourceName(node);
          if (!source || !forbiddenImports.has(source)) return;
          report(
            context,
            node,
            source,
            "namespace re-export",
            options.replacementImport,
            true,
          );
        },
        ExportNamedDeclaration(node) {
          if (isTypeOnly(node)) return;
          const source = sourceName(node);
          const forbidden = source ? forbiddenImports.get(source) : null;
          if (!source || !forbidden) return;
          for (const specifier of node.specifiers) {
            if (isTypeOnly(node, specifier)) continue;
            const result = shouldReportSpecifier(specifier, forbidden);
            if (result.report) {
              report(
                context,
                specifier,
                source,
                result.imported,
                options.replacementImport,
                result.broad,
              );
            }
          }
        },
      };
    },
  };
}
