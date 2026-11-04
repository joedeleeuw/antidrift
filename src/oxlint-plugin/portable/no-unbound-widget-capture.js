import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { hasWidgetDirective } from "../shared/scope.js";

const DEFAULT_INJECTED_MODULES = new Set([
  "@expo/ui/swift-ui",
  "@expo/ui/swift-ui/modifiers",
  "@expo/ui/jetpack-compose",
  "@expo/ui/jetpack-compose/modifiers",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);

const REACT_NATIVE_WIDGET_GLOBALS = new Set([
  "PlatformColor",
  "Image",
  "useColorScheme",
]);

function isTypeReferenceNode(ident) {
  for (let cur = ident?.parent; cur; cur = cur.parent) {
    if (
      cur.type === "TSTypeAnnotation" ||
      cur.type === "TSTypeReference" ||
      cur.type === "TSTypeQuery" ||
      cur.type === "TSTypeParameterDeclaration" ||
      cur.type === "TSTypeParameterInstantiation" ||
      cur.type === "TSInterfaceDeclaration" ||
      cur.type === "TSTypeAliasDeclaration" ||
      cur.type === "TSAsExpression" ||
      cur.type === "TSSatisfiesExpression"
    ) {
      if (
        (cur.type === "TSAsExpression" ||
          cur.type === "TSSatisfiesExpression") &&
        cur.expression === ident
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function isScopeWithin(innerScope, rootScope) {
  for (let cur = innerScope; cur; cur = cur.upper) {
    if (cur === rootScope) return true;
  }
  return false;
}

function collectScopes(scope, out) {
  if (!scope || out.has(scope)) return;
  out.add(scope);
  for (const child of scope.childScopes ?? []) {
    collectScopes(child, out);
  }
}

class WidgetCaptures {
  constructor(context) {
    this.context = context;
    this.sourceCode = this.context.sourceCode;
    this.option = this.context.options?.[0];
    this.allowedModules = this.option?.allowedInjectedModules
      ? new Set(this.option.allowedInjectedModules)
      : DEFAULT_INJECTED_MODULES;
    this.widgetFunctions = [];
  }
  recordIfWidget = (node) => {
    if (hasWidgetDirective(node)) {
      this.widgetFunctions.push(node);
    }
  };

  classifySpecifierAlias = (spec) => {
    const importedName =
      spec.imported?.type === "Identifier"
        ? spec.imported.name
        : spec.imported?.value;
    if (importedName && importedName !== spec.local?.name) {
      return {
        kind: "aliased",
        imported: importedName,
        local: spec.local.name,
      };
    }
    return { kind: "injected", imported: importedName };
  };

  classifyImportDef = (def) => {
    if (def?.type !== "ImportBinding") return null;
    const source = def.parent?.source?.value;
    if (typeof source !== "string") return { kind: "forbidden" };
    const spec = def.node;
    if (source === "react-native" && spec?.type === "ImportSpecifier") {
      const classification = this.classifySpecifierAlias(spec);
      return REACT_NATIVE_WIDGET_GLOBALS.has(classification.imported)
        ? classification
        : { kind: "forbidden" };
    }
    if (!this.allowedModules.has(source)) return { kind: "forbidden" };
    if (spec?.type === "ImportSpecifier") {
      return this.classifySpecifierAlias(spec);
    }
    const isReactNamespace =
      source === "react" &&
      (spec?.type === "ImportDefaultSpecifier" ||
        spec?.type === "ImportNamespaceSpecifier") &&
      spec.local?.name === "React";
    return isReactNamespace ? { kind: "injected" } : { kind: "forbidden" };
  };

  checkWidgetFunction = (fnNode) => {
    const rootScope = this.sourceCode.getScope?.(fnNode);
    if (!rootScope) return;
    const scopes = new Set();
    collectScopes(rootScope, scopes);
    const reportedNodes = new Set();

    for (const scope of scopes) {
      for (const ref of scope.references ?? []) {
        const ident = ref.identifier;
        if (!ident || reportedNodes.has(ident) || isTypeReferenceNode(ident)) {
          continue;
        }
        const resolved = ref.resolved;
        if (!resolved || resolved.defs.length === 0) continue;
        if (isScopeWithin(resolved.scope, rootScope)) continue;

        const def = resolved.defs[0];
        const importClassification = this.classifyImportDef(def);
        if (importClassification?.kind === "injected") continue;
        reportedNodes.add(ident);
        if (importClassification?.kind === "aliased") {
          this.context.report({
            node: ident,
            messageId: "aliasedInjectedImport",
            data: {
              local: importClassification.local,
              imported: importClassification.imported,
            },
          });
        } else {
          this.context.report({
            node: ident,
            messageId: "capturedBinding",
            data: { name: ident.name },
          });
        }
      }
    }
  };

  visitProgramExit = () => {
    for (const fnNode of this.widgetFunctions) {
      this.checkWidgetFunction(fnNode);
    }
  };
  listeners() {
    return {
      FunctionDeclaration: this.recordIfWidget,
      FunctionExpression: this.recordIfWidget,
      ArrowFunctionExpression: this.recordIfWidget,
      "Program:exit": this.visitProgramExit,
    };
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow capturing outer lexical bindings or aliased imports inside Expo `'widget'` directive functions, which serialize only the function body into a standalone JS context.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...scopeProperties,
          allowedInjectedModules: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    ],
    messages: {
      capturedBinding:
        "Expo `'widget'` function captures outer binding '{{name}}', which is not present in the isolated widget runtime. Move the value inside the `'widget'` function or pass it via widget props.",
      aliasedInjectedImport:
        "Expo `'widget'` function references '{{local}}' (aliased from '{{imported}}'); the widget runtime injects canonical export names only, so remove the import alias.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new WidgetCaptures(context).listeners();
  },
};
