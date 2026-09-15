import { isRuleFile, scopeProperties } from "./scope.js";
import { getPropertyName, isIdentifier } from "./ast.js";

const OMIT_TYPE = "Omit";
const MODIFIER_UTILITIES = new Set(["Partial", "Readonly", "Required"]);
const EMPTY_SPREAD_KEYWORDS = new Set([
  "TSNeverKeyword",
  "TSNullKeyword",
  "TSUndefinedKeyword",
  "TSVoidKeyword",
]);
const typeArgumentsOf = (typeNode) =>
  typeNode?.typeArguments?.params ?? typeNode?.typeParameters?.params ?? [];
const typeReferenceName = (typeName) => {
  if (isIdentifier(typeName)) {
    return typeName.name;
  }
  if (typeName?.type !== "TSQualifiedName") {
    return null;
  }
  const left = typeReferenceName(typeName.left);
  const right = getPropertyName(typeName.right);
  return left === null || right === null ? null : `${left}.${right}`;
};
const expandAlias = (name, localTypes, open) => {
  if (name === null || open.has(name)) {
    return null;
  }
  return localTypes.get(name)?.typeNode ?? null;
};
const intersectAll = (keySets) => {
  const first = keySets.at(0);
  return first === undefined
    ? []
    : [...first].filter((key) => keySets.every((keys) => keys.has(key)));
};
const typeSignature = (typeNode) => {
  if (typeNode === null || typeNode === undefined) {
    return "?";
  }
  if (typeNode.type === "TSParenthesizedType") {
    return typeSignature(typeNode.typeAnnotation);
  }
  if (typeNode.type === "TSTypeReference") {
    const args = typeArgumentsOf(typeNode);
    const name = typeReferenceName(typeNode.typeName) ?? "?";
    return args.length === 0
      ? name
      : `${name}<${args.map(typeSignature).join(",")}>`;
  }
  if (typeNode.type === "TSLiteralType") {
    return JSON.stringify(typeNode.literal?.value ?? null);
  }
  if (typeNode.type === "TSTypeLiteral") {
    const names = (typeNode.members ?? [])
      .map((member) => getPropertyName(member.key) ?? "?")
      .sort();
    return `{${names.join(",")}}`;
  }
  if (
    typeNode.type === "TSUnionType" ||
    typeNode.type === "TSIntersectionType"
  ) {
    const separator = typeNode.type === "TSUnionType" ? "|" : "&";
    return `(${typeNode.types.map(typeSignature).join(separator)})`;
  }
  return typeNode.type;
};
const suppliersOf = (typeNode, localTypes, open = new Set()) => {
  if (typeNode === null || typeNode === undefined) {
    return [];
  }
  if (typeNode.type === "TSParenthesizedType") {
    return suppliersOf(typeNode.typeAnnotation, localTypes, open);
  }
  if (typeNode.type !== "TSTypeReference") {
    return [];
  }
  const name = typeReferenceName(typeNode.typeName);
  const args = typeArgumentsOf(typeNode);
  if (name === OMIT_TYPE) {
    const source = args.at(0);
    const removed = new Set(literalKeysOf(args.at(1)));
    return [
      { source: typeSignature(source), removed },
      ...suppliersOf(source, localTypes, open).map((supplier) => ({
        source: supplier.source,
        removed: new Set([...supplier.removed, ...removed]),
      })),
    ];
  }
  if (MODIFIER_UTILITIES.has(name)) {
    return suppliersOf(args.at(0), localTypes, open);
  }
  const alias = expandAlias(name, localTypes, open);
  if (alias === null) {
    return [{ source: typeSignature(typeNode), removed: new Set() }];
  }
  open.add(name);
  const suppliers = suppliersOf(alias, localTypes, open);
  open.delete(name);
  return suppliers;
};
const literalKeysOf = (keyTypeNode) => {
  if (keyTypeNode?.type === "TSLiteralType") {
    const literal = keyTypeNode.literal;
    return typeof literal?.value === "string" ? [literal.value] : [];
  }
  if (keyTypeNode?.type === "TSUnionType") {
    return keyTypeNode.types.flatMap(literalKeysOf);
  }
  return [];
};
const omittedKeysOf = (typeNode, localTypes, open = new Set()) => {
  if (typeNode === null || typeNode === undefined) {
    return [];
  }
  if (typeNode.type === "TSParenthesizedType") {
    return omittedKeysOf(typeNode.typeAnnotation, localTypes, open);
  }
  if (typeNode.type === "TSIntersectionType") {
    const members = typeNode.types.map((member) => ({
      keys: omittedKeysOf(member, localTypes, open),
      suppliers: suppliersOf(member, localTypes, open),
    }));
    return members.flatMap(({ keys }, index) =>
      keys.filter(
        (key) =>
          !members.some(
            (sibling, siblingIndex) =>
              siblingIndex !== index &&
              sibling.suppliers.some(
                (supplier) =>
                  !supplier.removed.has(key) &&
                  members[index]?.suppliers.some(
                    (own) =>
                      own.removed.has(key) && own.source === supplier.source,
                  ),
              ),
          ),
      ),
    );
  }
  if (typeNode.type === "TSUnionType") {
    return intersectAll(
      typeNode.types
        .filter((member) => !EMPTY_SPREAD_KEYWORDS.has(member.type))
        .map((member) => new Set(omittedKeysOf(member, localTypes, open))),
    );
  }
  if (typeNode.type === "TSTypeReference") {
    const name = typeReferenceName(typeNode.typeName);
    const args = typeArgumentsOf(typeNode);
    if (name === OMIT_TYPE) {
      return [
        ...literalKeysOf(args.at(1)),
        ...omittedKeysOf(args.at(0), localTypes, open),
      ];
    }
    if (MODIFIER_UTILITIES.has(name)) {
      return omittedKeysOf(args.at(0), localTypes, open);
    }
    const alias = expandAlias(name, localTypes, open);
    if (alias === null) {
      return [];
    }
    open.add(name);
    const keys = omittedKeysOf(alias, localTypes, open);
    open.delete(name);
    return keys;
  }
  return [];
};
const reintroducedKeysOf = (typeNode, localTypes, open = new Set()) => {
  if (typeNode === null || typeNode === undefined) {
    return [];
  }
  if (typeNode.type === "TSParenthesizedType") {
    return reintroducedKeysOf(typeNode.typeAnnotation, localTypes, open);
  }
  if (
    typeNode.type === "TSIntersectionType" ||
    typeNode.type === "TSUnionType"
  ) {
    return typeNode.types.flatMap((member) =>
      reintroducedKeysOf(member, localTypes, open),
    );
  }
  if (typeNode.type === "TSTypeLiteral") {
    return (typeNode.members ?? [])
      .filter((member) => member.type === "TSPropertySignature")
      .map((member) =>
        member.computed === true ? null : getPropertyName(member.key),
      )
      .filter((name) => name !== null);
  }
  if (typeNode.type === "TSTypeReference") {
    const name = typeReferenceName(typeNode.typeName);
    const args = typeArgumentsOf(typeNode);
    if (name === OMIT_TYPE) {
      const removed = new Set(literalKeysOf(args.at(1)));
      return reintroducedKeysOf(args.at(0), localTypes, open).filter(
        (key) => !removed.has(key),
      );
    }
    if (MODIFIER_UTILITIES.has(name)) {
      return reintroducedKeysOf(args.at(0), localTypes, open);
    }
    const alias = expandAlias(name, localTypes, open);
    if (alias === null) {
      return [];
    }
    open.add(name);
    const keys = reintroducedKeysOf(alias, localTypes, open);
    open.delete(name);
    return keys;
  }
  return [];
};
const patternOf = (param) =>
  param?.type === "AssignmentPattern" ? param.left : param;
const propsParamOf = (params = []) => {
  const first = params.at(0);
  return isIdentifier(first, "this") ? params.at(1) : first;
};
const propsBindingOf = (param) => {
  if (isIdentifier(param)) {
    return param;
  }
  if (param?.type !== "ObjectPattern") {
    return null;
  }
  const rest = param.properties?.find(
    (property) => property.type === "RestElement",
  );
  return isIdentifier(rest?.argument) ? rest.argument : null;
};
const destructuredKeysOf = (param) => {
  if (param?.type !== "ObjectPattern") {
    return [];
  }
  return (param.properties ?? [])
    .filter((property) => property.type === "Property" && !property.computed)
    .map((property) => getPropertyName(property.key))
    .filter((name) => name !== null);
};
const attributeName = (attribute) =>
  attribute?.type === "JSXAttribute" && attribute.name?.type === "JSXIdentifier"
    ? attribute.name.name
    : null;
const isRenderedChild = (child) => {
  if (child.type === "JSXText") {
    return child.value.trim() !== "" || !child.value.includes("\n");
  }
  return (
    child.type !== "JSXExpressionContainer" ||
    child.expression.type !== "JSXEmptyExpression"
  );
};

const unwrapSpread = (node) =>
  node?.type === "TSAsExpression" ||
  node?.type === "TSSatisfiesExpression" ||
  node?.type === "TSNonNullExpression" ||
  node?.type === "TSInstantiationExpression" ||
  node?.type === "ParenthesizedExpression"
    ? unwrapSpread(node.expression)
    : node;
const spreadCanDeliver = (attribute, key) => {
  const argument = unwrapSpread(attribute.argument);
  if (argument.type !== "ObjectExpression") {
    return true;
  }
  return argument.properties.some(
    (property) =>
      property.type !== "Property" ||
      property.computed === true ||
      getPropertyName(property.key) === key,
  );
};
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
      pinnedBeforeSpread:
        "`{{key}}` is omitted from this component's props but written before the props spread, so the spread overwrites it. A value typed wider than the omitting parameter still carries `{{key}}` at runtime — `Omit` narrows what callers may write, not what a spread can deliver. Move the attribute after the last spread.",
      suppliedBySpread:
        "`{{key}}` is omitted from this component's props but the props spread can still deliver it: `Omit` narrows what callers may write literally, while a value typed wider stays assignable and keeps the key at runtime. Pin `{{key}}` after the last spread, or suppress with a reason if it is meant to pass through.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const localTypes = new Map();
    const omittedByBinding = new Map();
    const propsParams = [];
    const spreadElements = [];
    const declareLocalType = (declaration) => {
      if (declaration?.type !== "TSTypeAliasDeclaration") {
        return;
      }
      const name = declaration.id?.name;
      if (typeof name !== "string") {
        return;
      }
      if ((declaration.typeParameters?.params?.length ?? 0) > 0) {
        localTypes.set(name, null);
        return;
      }
      const start = declaration.range[0];
      const existing = localTypes.get(name);
      if (existing === undefined) {
        localTypes.set(name, {
          start,
          typeNode: declaration.typeAnnotation,
        });
        return;
      }
      if (existing !== null && existing.start !== start) {
        localTypes.set(name, null);
      }
    };
    const collectPropsParam = (node) => {
      const param = patternOf(propsParamOf(node.params));
      const binding = propsBindingOf(param);
      if (binding !== null) {
        propsParams.push({ binding, param });
      }
    };
    const indexOmittedKeys = () => {
      for (const { binding, param } of propsParams) {
        const propsType = param.typeAnnotation?.typeAnnotation;
        const carried = new Set([
          ...destructuredKeysOf(param),
          ...reintroducedKeysOf(propsType, localTypes),
        ]);
        const keys = omittedKeysOf(propsType, localTypes).filter(
          (key) => !carried.has(key),
        );
        if (keys.length > 0) {
          omittedByBinding.set(binding.range[0], new Set(keys));
        }
      }
    };
    const omittedKeysForSpread = (identifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (scope !== null) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          return variable.defs
            .map((definition) => omittedByBinding.get(definition.name.range[0]))
            .find((keys) => keys !== undefined);
        }
        scope = scope.upper;
      }
      return undefined;
    };
    const reportElement = (node) => {
      const attributes = node.openingElement.attributes;
      const omitted = new Set();
      for (const attribute of attributes) {
        if (attribute.type !== "JSXSpreadAttribute") {
          continue;
        }
        const argument = unwrapSpread(attribute.argument);
        if (!isIdentifier(argument)) {
          continue;
        }
        for (const key of omittedKeysForSpread(argument) ?? []) {
          omitted.add(key);
        }
      }
      for (const key of omitted) {
        if (key === "children" && node.children.some(isRenderedChild)) {
          continue;
        }
        const lastOverrideIndex = attributes.findLastIndex(
          (attribute) =>
            attribute.type === "JSXSpreadAttribute" &&
            spreadCanDeliver(attribute, key),
        );
        if (lastOverrideIndex === -1) {
          continue;
        }
        const pin = attributes.find(
          (attribute) => attributeName(attribute) === key,
        );
        if (pin !== undefined && attributes.indexOf(pin) > lastOverrideIndex) {
          continue;
        }
        context.report({
          node: pin ?? node.openingElement,
          messageId:
            pin === undefined ? "suppliedBySpread" : "pinnedBeforeSpread",
          data: { key },
        });
      }
    };
    return {
      Program() {
        localTypes.clear();
        omittedByBinding.clear();
        propsParams.length = 0;
        spreadElements.length = 0;
      },
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (typeof specifier.local?.name === "string") {
            localTypes.set(specifier.local.name, null);
          }
        }
      },
      TSTypeParameter(node) {
        if (typeof node.name?.name === "string") {
          localTypes.set(node.name.name, null);
        }
      },
      TSTypeAliasDeclaration: declareLocalType,
      ArrowFunctionExpression: collectPropsParam,
      FunctionDeclaration: collectPropsParam,
      FunctionExpression: collectPropsParam,
      JSXElement(node) {
        if (
          node.openingElement.attributes.some(
            (attribute) => attribute.type === "JSXSpreadAttribute",
          )
        ) {
          spreadElements.push(node);
        }
      },
      "Program:exit"() {
        indexOmittedKeys();
        for (const element of spreadElements) {
          reportElement(element);
        }
      },
    };
  },
};
