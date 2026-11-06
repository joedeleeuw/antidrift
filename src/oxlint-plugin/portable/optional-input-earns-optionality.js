import { isExposedOutsideProgram } from "../shared/module-exposure.js";
import {
  isMemberDispatchClosed,
  programReferences,
  rootSymbols,
} from "../shared/program-references.js";
import { isFunctionLike, unwrapExpression } from "../shared/scope.js";
import { getTypeServices } from "../shared/type-services.js";

const SYMBOL_FLAG_OPTIONAL = 16_777_216;
const TYPE_FLAG_ANY_OR_UNKNOWN = 3;
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"]);
const NEUTRAL_REFERENCE = "neutral";

function wrapperName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  return callee?.type === "MemberExpression" && !callee.computed
    ? callee.property.name
    : null;
}

function declaredFunction(init) {
  const expression = unwrapExpression(init);
  if (isFunctionLike(expression)) return { fn: expression, wrapped: false };
  const [first] = expression?.arguments ?? [];
  return expression?.type === "CallExpression" &&
    COMPONENT_WRAPPERS.has(wrapperName(expression.callee)) &&
    isFunctionLike(first)
    ? { fn: first, wrapped: true }
    : null;
}

function classMethodCandidates(classNode) {
  if (!classNode.id || classNode.superClass || classNode.implements?.length) {
    return [];
  }
  return classNode.body.body
    .filter(
      (member) =>
        member.type === "MethodDefinition" &&
        member.kind === "method" &&
        !member.computed &&
        member.key.type === "Identifier"
    )
    .map((member) => ({
      nameNode: member.key,
      exportNode: classNode.id,
      fn: member.value,
      wrapped: false,
    }));
}

function statementCandidates(statement) {
  const declaration =
    statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
  if (declaration?.type === "FunctionDeclaration" && declaration.id) {
    const nameNode = declaration.id;
    return [
      { nameNode, exportNode: nameNode, fn: declaration, wrapped: false },
    ];
  }
  if (declaration?.type === "ClassDeclaration") {
    return classMethodCandidates(declaration);
  }
  if (declaration?.type !== "VariableDeclaration") return [];
  return declaration.declarations.flatMap((declarator) => {
    const declared =
      declarator.id.type === "Identifier" && !declarator.id.typeAnnotation
        ? declaredFunction(declarator.init)
        : null;
    return declared
      ? [{ nameNode: declarator.id, exportNode: declarator.id, ...declared }]
      : [];
  });
}

function moduleExports(tsSourceFile, checker) {
  const moduleSymbol = checker.getSymbolAtLocation(tsSourceFile);
  const named = new Set();
  let defaultExport = null;
  for (const exported of moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol)
    : []) {
    for (const local of rootSymbols(exported, checker)) {
      if (exported.name === "default") defaultExport = local;
      else named.add(local);
    }
  }
  return { named, defaultExport };
}

function jsxSite(element) {
  const supplied = new Set();
  const attributeValues = new Map();
  for (const attribute of element.attributes.properties) {
    if (!attribute.name) return null;
    const name = attribute.name.getText();
    supplied.add(name);
    attributeValues.set(name, attribute.initializer?.expression ?? null);
  }
  const children =
    element.parent?.openingElement === element ? element.parent.children : [];
  if (children.some((child) => !child.containsOnlyTriviaWhiteSpaces)) {
    supplied.add("children");
  }
  return {
    jsx: true,
    supplied,
    attributeValues,
    callArguments: [],
    argumentCount: 0,
    objectArgument: null,
  };
}

function invocationSite(call) {
  const args = [...call.arguments];
  if (args.some((argument) => argument.getText().startsWith("..."))) {
    return null;
  }
  const [first] = args;
  let supplied = null;
  if (Array.isArray(first?.properties)) {
    supplied = new Set();
    for (const property of first.properties) {
      if (typeof property.name?.text !== "string") return null;
      supplied.add(property.name.text);
    }
  }
  return {
    jsx: false,
    supplied,
    callArguments: args,
    argumentCount: args.length,
    objectArgument: first ?? null,
  };
}

function referenceSite(identifier) {
  let expression = identifier;
  while (
    (expression.parent?.name === expression && expression.parent.expression) ||
    expression.parent?.argumentExpression === expression
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  if (parent?.tagName === expression) {
    return parent.attributes ? jsxSite(parent) : NEUTRAL_REFERENCE;
  }
  return parent?.expression === expression && Array.isArray(parent.arguments)
    ? invocationSite(parent)
    : null;
}

function callSites(references) {
  const sites = [];
  for (const identifier of references) {
    const site = referenceSite(identifier);
    if (site === null) return [];
    if (site !== NEUTRAL_REFERENCE) sites.push(site);
  }
  return sites;
}

function suppliedByType(argument, name, checker) {
  const type = checker.getTypeAtLocation(argument);
  if (type.isUnion() || (type.flags & TYPE_FLAG_ANY_OR_UNKNOWN) !== 0) {
    return undefined;
  }
  const property = checker.getPropertyOfType(type, name);
  return property && (property.flags & SYMBOL_FLAG_OPTIONAL) === 0
    ? true
    : undefined;
}

function suppliedExpression(expression, checker) {
  if (!expression) return true;
  const type = checker.getTypeAtLocation(expression);
  return (type.flags & TYPE_FLAG_ANY_OR_UNKNOWN) !== 0 ||
    (type.isUnion() &&
      type.types.some(
        (constituent) => constituent.intrinsicName === "undefined"
      ))
    ? undefined
    : true;
}

function memberSupplied(site, name, checker) {
  if (site.supplied) {
    return site.supplied.has(name) && site.jsx
      ? suppliedExpression(site.attributeValues.get(name), checker)
      : site.supplied.has(name);
  }
  return site.objectArgument
    ? suppliedByType(site.objectArgument, name, checker)
    : false;
}

function isInside(reference, container) {
  return (
    reference.getSourceFile() === container.getSourceFile() &&
    reference.pos >= container.pos &&
    reference.end <= container.end
  );
}

function ownedByParameter(member, parameter, services) {
  let owner = member.parent;
  while (owner && owner !== parameter && !owner.name?.escapedText) {
    owner = owner.parent;
  }
  if (owner === parameter) return true;
  if (!owner) return false;
  const references = programReferences(owner.name, services);
  return (
    references !== null &&
    references.every((reference) => isInside(reference, parameter))
  );
}

function isOptionalMember(property, parameter, services) {
  const declarations = property.declarations ?? [];
  return (
    (property.flags & SYMBOL_FLAG_OPTIONAL) !== 0 &&
    declarations.length > 0 &&
    declarations.every(
      (member) =>
        member.questionToken &&
        member.getSourceFile() === parameter.getSourceFile() &&
        ownedByParameter(member, parameter, services)
    )
  );
}

function memberInputs(parameter, services) {
  const { checker } = services;
  const type = checker.getNonNullableType(checker.getTypeAtLocation(parameter));
  if (type.isUnion()) return [];
  return checker
    .getPropertiesOfType(type)
    .filter((property) => isOptionalMember(property, parameter, services))
    .map((property) => ({
      label: property.name,
      node: property.declarations[0].name,
      supplied: (site) => memberSupplied(site, property.name, checker),
    }));
}

function optionalInputs(tsFunction, wrapped, services) {
  const { checker } = services;
  const callableParameters = tsFunction.parameters.filter(
    (parameter) => parameter.name.getText() !== "this"
  );
  const inputs = [];
  for (const [position, parameter] of callableParameters.entries()) {
    if (parameter.dotDotDotToken) break;
    if (!parameter.questionToken && !parameter.initializer) continue;
    inputs.push({
      label:
        typeof parameter.name.escapedText === "string"
          ? parameter.name.text
          : `parameter ${position + 1}`,
      node: parameter,
      supplied: (site) => {
        if (site.jsx) return undefined;
        return site.argumentCount > position
          ? suppliedExpression(site.callArguments[position], checker)
          : false;
      },
    });
  }
  const objectParameter =
    callableParameters.length === 1 ||
    (wrapped && callableParameters.length > 0)
      ? callableParameters[0]
      : null;
  return objectParameter
    ? [...inputs, ...memberInputs(objectParameter, services)]
    : inputs;
}

function verdict(input, sites) {
  let passed = 0;
  for (const site of sites) {
    const supplied = input.supplied(site);
    if (supplied === undefined) return null;
    if (supplied) passed += 1;
  }
  if (passed === 0) return "neverPassed";
  return passed === sites.length ? "alwaysPassed" : null;
}

function nodeLoc(tsNode, sourceCode) {
  return {
    start: sourceCode.getLocFromIndex(tsNode.getStart()),
    end: sourceCode.getLocFromIndex(tsNode.getEnd()),
  };
}

function exportState(candidate, services, exportsOfModule) {
  const { checker, nodeMap } = services;
  const symbol = checker.getSymbolAtLocation(nodeMap.get(candidate.nameNode));
  if (!symbol || (symbol.declarations?.length ?? 0) > 1) return null;
  const [exportRoot] = rootSymbols(
    checker.getSymbolAtLocation(nodeMap.get(candidate.exportNode)),
    checker
  );
  if (!exportRoot || exportRoot === exportsOfModule.defaultExport) return null;
  const exported = exportsOfModule.named.has(exportRoot);
  if (!exported && candidate.exportNode !== candidate.nameNode) return null;
  return { exported };
}

function provenSites(candidate, services, exportsOfModule) {
  const { nodeMap } = services;
  const state = exportState(candidate, services, exportsOfModule);
  const exportName = nodeMap.get(candidate.exportNode);
  if (!state || isExposedOutsideProgram(exportName, state.exported, services)) {
    return [];
  }
  const name = nodeMap.get(candidate.nameNode);
  if (
    candidate.exportNode !== candidate.nameNode &&
    !isMemberDispatchClosed(name, exportName, services)
  ) {
    return [];
  }
  const references = programReferences(name, services);
  const sites = references ? callSites(references) : [];
  return state.exported || sites.some((site) => site.jsx) ? sites : [];
}

function reportCandidate(context, candidate, services, sites) {
  const tsFunction = services.nodeMap.get(candidate.fn);
  for (const input of optionalInputs(tsFunction, candidate.wrapped, services)) {
    const messageId = verdict(input, sites);
    if (!messageId) continue;
    context.report({
      loc: nodeLoc(input.node, context.sourceCode),
      messageId,
      data: { name: input.label, count: String(sites.length) },
    });
  }
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "An optional component prop or exported-function input must be omitted by some caller and passed by another. Needs type information (typed ESLint exposing parserServices.program); without it the rule abstains entirely.",
    },
    messages: {
      neverPassed:
        "Optional input '{{name}}' is never passed by any of its {{count}} call sites; delete it.",
      alwaysPassed:
        "Optional input '{{name}}' is passed by all {{count}} call sites; make it required.",
    },
    schema: [],
  },
  create(context) {
    const services = getTypeServices(context.sourceCode);
    if (!services) return {};
    return {
      Program(program) {
        const tsSourceFile = services.nodeMap.get(program);
        const exportsOfModule = moduleExports(tsSourceFile, services.checker);
        for (const candidate of program.body.flatMap(statementCandidates)) {
          const sites = provenSites(candidate, services, exportsOfModule);
          if (sites.length > 0) {
            reportCandidate(context, candidate, services, sites);
          }
        }
      },
    };
  },
};
