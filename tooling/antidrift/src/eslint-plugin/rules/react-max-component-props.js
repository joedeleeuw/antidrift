import {
  functionReturnsJsx,
  isFunctionLike,
  memberNodeTypes,
} from "../../semantic-adapters/local-ast-rules.mjs";
import ts from "typescript";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const reactComponentFactoryWrappers = new Set(["forwardRef", "memo"]);
const reactComponentTypeNames = new Set(["FC", "FunctionComponent"]);
const DEFAULT_REACT_COMPONENT_PROPS_MAX = 12;
function staticPropertyName(node) {
  if (!node) {
    return "";
  }
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return "";
}
function callExpressionName(node) {
  if (node?.type === "Identifier") {
    return node.name;
  }
  if (node?.type !== "MemberExpression" || node.computed) {
    return "";
  }
  return staticPropertyName(node.property);
}
function unwrapReactComponentFunction(node) {
  let current = node;
  for (let depth = 0; depth < 4; depth += 1) {
    if (isFunctionLike(current)) {
      return current;
    }
    if (current?.type !== "CallExpression") {
      return null;
    }
    const name = callExpressionName(current.callee);
    if (!reactComponentFactoryWrappers.has(name)) {
      return null;
    }
    current = current.arguments[0];
  }
  return isFunctionLike(current) ? current : null;
}
function componentFunctionForNode(node) {
  if (isFunctionLike(node)) {
    return node;
  }
  if (node.type === "VariableDeclarator") {
    return unwrapReactComponentFunction(node.init);
  }
  if (memberNodeTypes.has(node.type)) {
    return unwrapReactComponentFunction(node.value);
  }
  return null;
}
function implementationParam(node) {
  let current = node;
  while (current?.type === "AssignmentPattern") {
    current = current.left;
  }
  return current;
}
function objectPatternPropCount(node) {
  if (node?.type !== "ObjectPattern") {
    return 0;
  }
  return node.properties.filter((prop) => prop.type === "Property").length;
}
function sourceFileIsExternal(fileName) {
  const normalized = fileName.replace(/\\/gu, "/");
  return (
    normalized.includes("/node_modules/") ||
    normalized.includes("/node_modules/typescript/lib/")
  );
}
function symbolHasProjectDeclaration(sym) {
  const name = sym?.getName?.() ?? sym?.name ?? "";
  if (!name || name.startsWith("__")) {
    return false;
  }
  const declarations = sym.getDeclarations?.() ?? sym.declarations ?? [];
  return declarations.some((declaration) => {
    const fileName = declaration.getSourceFile?.()?.fileName;
    return Boolean(fileName && !sourceFileIsExternal(fileName));
  });
}
function localPropNamesForType(checker, type) {
  if (!type) {
    return new Set();
  }
  if (typeof type.isUnion === "function" && type.isUnion()) {
    const largest = type.types
      .map((part) => localPropNamesForType(checker, part))
      .sort((left, right) => right.size - left.size)[0];
    return largest ?? new Set();
  }
  const apparent = checker.getApparentType(type);
  const names = new Set();
  for (const sym of checker.getPropertiesOfType(apparent)) {
    if (symbolHasProjectDeclaration(sym)) {
      names.add(sym.getName());
    }
  }
  return names;
}
function typedPropCountForParam(param, services, checker) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(param);
  if (!tsNode) {
    return 0;
  }
  return localPropNamesForType(checker, checker.getTypeAtLocation(tsNode)).size;
}
function typeNameParts(node) {
  if (node?.type === "Identifier") {
    return [node.name];
  }
  if (node?.type === "TSQualifiedName") {
    return [...typeNameParts(node.left), node.right.name];
  }
  return [];
}
function reactComponentPropsTypeArgument(node) {
  if (node?.type !== "TSTypeReference") {
    return null;
  }
  const parts = typeNameParts(node.typeName);
  const name = parts.at(-1);
  if (!reactComponentTypeNames.has(name)) {
    return null;
  }
  if (parts.length > 1 && parts[0] !== "React") {
    return null;
  }
  return node.typeArguments?.params?.[0] ?? null;
}
function typedPropCountForReactTypeAnnotation(node, services, checker) {
  const typeAnnotation = node.id?.typeAnnotation?.typeAnnotation;
  const propsTypeNode = reactComponentPropsTypeArgument(typeAnnotation);
  if (!propsTypeNode) {
    return 0;
  }
  const tsNode = services.esTreeNodeToTSNodeMap.get(propsTypeNode);
  if (!tsNode) {
    return 0;
  }
  return localPropNamesForType(checker, checker.getTypeAtLocation(tsNode)).size;
}
function typedPropCountForCallableNode(node, services, checker) {
  if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") {
    return 0;
  }
  const annotationCount = typedPropCountForReactTypeAnnotation(
    node,
    services,
    checker,
  );
  if (annotationCount > 0) {
    return annotationCount;
  }
  const tsNode = services.esTreeNodeToTSNodeMap.get(node.id);
  if (!tsNode) {
    return 0;
  }
  const type = checker.getTypeAtLocation(tsNode);
  const [signature] = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const [param] = signature?.parameters ?? [];
  if (!param) {
    return 0;
  }
  const paramType = checker.getTypeOfSymbolAtLocation(param, tsNode);
  return localPropNamesForType(checker, paramType).size;
}
function propSpreadNamesForParam(param) {
  const names = new Set();
  if (param?.type === "Identifier") {
    names.add(param.name);
    return names;
  }
  if (param?.type !== "ObjectPattern") {
    return names;
  }
  for (const prop of param.properties) {
    if (prop.type !== "RestElement") {
      continue;
    }
    const argument = implementationParam(prop.argument);
    if (argument?.type === "Identifier") {
      names.add(argument.name);
    }
  }
  return names;
}
function containsJsxSpreadOf(node, names) {
  if (!node || typeof node !== "object" || names.size === 0) {
    return false;
  }
  if (
    node.type === "JSXSpreadAttribute" &&
    node.argument?.type === "Identifier"
  ) {
    return names.has(node.argument.name);
  }
  if (isFunctionLike(node)) {
    return false;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (
      Array.isArray(value) &&
      value.some((item) => containsJsxSpreadOf(item, names))
    ) {
      return true;
    }
    if (value?.type && containsJsxSpreadOf(value, names)) {
      return true;
    }
  }
  return false;
}
function forwardsPropsAsSpread(fn, param, max) {
  const names = propSpreadNamesForParam(param);
  if (!containsJsxSpreadOf(fn.body, names)) {
    return false;
  }
  if (param?.type !== "ObjectPattern") {
    return true;
  }
  return objectPatternPropCount(param) <= max;
}
function componentAcceptedPropCount(param, services, checker) {
  const implementation = implementationParam(param);
  return Math.max(
    objectPatternPropCount(implementation),
    typedPropCountForParam(implementation, services, checker),
  );
}
function reportLargeComponentProps(node, context, services, checker, max) {
  const fn = componentFunctionForNode(node);
  if (!fn || !functionReturnsJsx(fn)) {
    return;
  }
  const param = fn.params[0];
  if (!param) {
    return;
  }
  const implementation = implementationParam(param);
  const count = Math.max(
    componentAcceptedPropCount(implementation, services, checker),
    typedPropCountForCallableNode(node, services, checker),
  );
  if (count <= max || forwardsPropsAsSpread(fn, implementation, max)) {
    return;
  }
  context.report({
    node: implementation,
    message:
      "React component accepts too many locally-owned props ({{count}} > {{max}}). Split cohesive props into an owned object, resource, or smaller component boundary.",
    data: { count: String(count), max: String(max) },
  });
}
// Visit free functions, arrow consts, and class methods/fields uniformly — agents hide the same
// contract-appeasement patterns in any of these forms.
const callableVisitors = (check) => ({
  FunctionDeclaration: check,
  VariableDeclarator: check,
  MethodDefinition: check,
  PropertyDefinition: check,
  Property: check,
});
export function ruleReactMaxComponentProps() {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Limit locally-owned props accepted by JSX-returning React components.",
      },
      schema: [
        {
          type: "object",
          properties: { max: { type: "number", minimum: 1 } },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "react-max-component-props",
        );
      }
      const checker = services.program.getTypeChecker();
      const max = context.options[0]?.max ?? DEFAULT_REACT_COMPONENT_PROPS_MAX;
      return callableVisitors((node) =>
        reportLargeComponentProps(node, context, services, checker, max),
      );
    },
  };
}
