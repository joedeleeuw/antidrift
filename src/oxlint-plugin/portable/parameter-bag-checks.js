import {
  isConstantCallArgument,
  isLocalFunctionBinding,
  wrapperCandidate,
} from "./function-boundary-helpers.js";
import { ruleFilename } from "../shared/rule-scope.js";
import {
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
  isTestFile,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";
import {
  getResolvedType,
  getTypeServices,
  resolvedDeclarationFiles,
  resolvedPropertyShape,
} from "../shared/type-services.js";

function collectMemberNames(members, names) {
  for (const member of members) {
    if (
      (member.type === "TSPropertySignature" ||
        member.type === "TSMethodSignature") &&
      member.key?.type === "Identifier"
    ) {
      names.add(member.key.name);
    }
  }
  return names;
}

function extractOmittedKeys(typeNode, keys = new Set()) {
  if (
    typeNode?.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    typeNode.typeName.name === "Omit"
  ) {
    const keyArg = typeNode.typeArguments?.params?.[1];
    let parts = [];
    if (keyArg?.type === "TSUnionType") {
      parts = keyArg.types;
    } else if (keyArg) {
      parts = [keyArg];
    }
    for (const part of parts) {
      if (
        part?.type === "TSLiteralType" &&
        part.literal?.type === "Literal" &&
        typeof part.literal.value === "string"
      ) {
        keys.add(part.literal.value);
      }
    }
  }
  return keys;
}

export function collectTypePropertyNames(
  typeNode,
  typeDeclarations,
  names = new Set(),
  seen = new Set()
) {
  if (!typeNode) return names;
  if (typeNode.type === "TSTypeLiteral") {
    return collectMemberNames(typeNode.members, names);
  }
  if (typeNode.type === "TSInterfaceBody") {
    return collectMemberNames(typeNode.body, names);
  }
  if (typeNode.type === "TSIntersectionType") {
    const omittedKeys = new Set();
    for (const part of typeNode.types) {
      extractOmittedKeys(part, omittedKeys);
      collectTypePropertyNames(part, typeDeclarations, names, seen);
    }
    for (const key of omittedKeys) {
      names.delete(key);
    }
    return names;
  }
  if (
    typeNode.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    !seen.has(typeNode.typeName.name)
  ) {
    seen.add(typeNode.typeName.name);
    collectTypePropertyNames(
      typeDeclarations.get(typeNode.typeName.name),
      typeDeclarations,
      names,
      seen
    );
  }
  return names;
}

export function recordProgramTypeDeclarations(programNode, typeDeclarations) {
  for (const stmt of programNode.body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type === "TSInterfaceDeclaration" && decl.id?.name) {
      typeDeclarations.set(decl.id.name, decl.body);
    } else if (decl?.type === "TSTypeAliasDeclaration" && decl.id?.name) {
      typeDeclarations.set(decl.id.name, decl.typeAnnotation);
    }
  }
}

const BAG_TYPE_NAME =
  /(?:Deps|Dependencies|Options|Opts|Params|Parameters|Args|Arguments|Input|Config|Bag|Callbacks|Handlers)$/u;
const SETTER_NAME = /^set([A-Z]\w*)$/u;

function localBagDeclaration(typeNode, typeDeclarations) {
  if (
    typeNode?.type !== "TSTypeReference" ||
    typeNode.typeName?.type !== "Identifier"
  ) {
    return null;
  }
  const name = typeNode.typeName.name;
  const declaration = typeDeclarations.get(name);
  return declaration && BAG_TYPE_NAME.test(name) ? declaration : null;
}

function objectPatternNames(pattern) {
  return pattern.properties
    .filter(
      (prop) => prop.type === "Property" && prop.key?.type === "Identifier"
    )
    .map((prop) => prop.key.name);
}

function firstStatementDestructure(node, parameter) {
  const first =
    node.body?.type === "BlockStatement" ? node.body.body[0] : undefined;
  if (
    parameter.type !== "Identifier" ||
    first?.type !== "VariableDeclaration"
  ) {
    return [];
  }
  const declarator = first.declarations.find(
    (candidate) =>
      candidate.id?.type === "ObjectPattern" &&
      candidate.init?.type === "Identifier" &&
      candidate.init.name === parameter.name
  );
  return declarator ? objectPatternNames(declarator.id) : [];
}

function isBagReference(typeNode, sourceCode) {
  if (
    typeNode?.type !== "TSTypeReference" ||
    typeNode.typeName?.type !== "Identifier" ||
    !BAG_TYPE_NAME.test(typeNode.typeName.name)
  ) {
    return false;
  }
  const files = sourceCode
    ? resolvedDeclarationFiles(typeNode, sourceCode)
    : [];
  return (
    files.length > 0 && files.every((file) => !file.includes("node_modules"))
  );
}

function shouldCollectAnnotatedNames(parameter, annotation, localDeclaration) {
  return (
    parameter.type === "ObjectPattern" ||
    annotation?.type === "TSTypeLiteral" ||
    annotation?.type === "TSIntersectionType" ||
    localDeclaration !== null
  );
}

function bagShape(parameter, typeDeclarations, sourceCode) {
  const annotation = parameter.typeAnnotation?.typeAnnotation;
  const localDeclaration = localBagDeclaration(annotation, typeDeclarations);
  const resolvedBag =
    !localDeclaration && isBagReference(annotation, sourceCode)
      ? resolvedPropertyShape(annotation, sourceCode)
      : null;
  const isUnresolvedRef =
    annotation?.type === "TSTypeReference" && !localDeclaration && !resolvedBag;
  const destructured = isUnresolvedRef
    ? []
    : firstStatementDestructure(parameter.parent, parameter);
  const names = new Set(
    parameter.type === "ObjectPattern" ? objectPatternNames(parameter) : []
  );
  const collectAnnotated = shouldCollectAnnotatedNames(
    parameter,
    annotation,
    localDeclaration
  );
  if (collectAnnotated) {
    collectTypePropertyNames(annotation, typeDeclarations, names);
  }
  for (const name of resolvedBag?.all ?? []) names.add(name);
  for (const name of destructured) names.add(name);
  const shaped =
    collectAnnotated || resolvedBag !== null || destructured.length > 0;
  return { shaped, size: names.size };
}

function memberList(typeNode) {
  if (typeNode?.type === "TSTypeLiteral") return typeNode.members;
  return typeNode?.type === "TSInterfaceBody" ? typeNode.body : null;
}

function callbackArity(member) {
  if (member.key?.type !== "Identifier") return null;
  if (member.type === "TSMethodSignature") return member.params?.length ?? 0;
  const signature = member.typeAnnotation?.typeAnnotation;
  return signature?.type === "TSFunctionType"
    ? (signature.params?.length ?? 0)
    : null;
}

function addResolvedCallbacks(annotation, sourceCode, callbacks) {
  const services = getTypeServices(sourceCode);
  const type = services && getResolvedType(annotation, sourceCode);
  if (!type) return;
  for (const prop of services.checker.getPropertiesOfType(type) ?? []) {
    if (typeof prop?.name !== "string" || prop.name.startsWith("__")) continue;
    const propType = services.checker.getTypeOfSymbol?.(prop);
    const sigs = propType?.getCallSignatures?.() ?? [];
    if (sigs.length > 0) {
      callbacks.set(prop.name, sigs[0].parameters?.length ?? 0);
    }
  }
}

function foreignCallbacks(parameter, typeDeclarations, sourceCode) {
  const annotation = parameter.typeAnnotation?.typeAnnotation;
  const members =
    memberList(annotation) ??
    memberList(localBagDeclaration(annotation, typeDeclarations));
  const callbacks = new Map();
  if (members) {
    for (const member of members) {
      const arity = callbackArity(member);
      if (arity !== null) callbacks.set(member.key.name, arity);
    }
  } else if (isBagReference(annotation, sourceCode)) {
    addResolvedCallbacks(annotation, sourceCode, callbacks);
  } else if (
    parameter.type === "ObjectPattern" &&
    annotation?.type !== "TSTypeReference"
  ) {
    for (const name of objectPatternNames(parameter)) callbacks.set(name, null);
  }
  return callbacks;
}

function getterSetterPair(callbacks) {
  for (const [name, arity] of callbacks) {
    const stem = SETTER_NAME.exec(name)?.[1];
    if (!stem || (arity !== null && arity !== 1)) continue;
    const getter = [
      `get${stem}`,
      `${stem[0].toLowerCase()}${stem.slice(1)}`,
    ].find(
      (candidate) =>
        callbacks.has(candidate) && (callbacks.get(candidate) ?? 0) === 0
    );
    if (getter) return [getter, name];
  }
  return null;
}

function reportForeignCallbacks(parameter, typeDeclarations, context) {
  const callbacks = foreignCallbacks(
    parameter,
    typeDeclarations,
    context.sourceCode
  );
  const names = [...callbacks.keys()];
  const setters = names.filter((name) => /^set[A-Z]/u.test(name));
  const getters = names.filter((name) => /^get[A-Z]/u.test(name));
  if (
    names.length >= 3 &&
    (setters.length >= 3 || (setters.length >= 2 && getters.length >= 1))
  ) {
    const sample = [...setters, ...getters].slice(0, 4).join(", ");
    context.report({
      node: parameter,
      message: `Parameter bag accepts multiple foreign state callbacks (${sample}); return a state transition value or move the logic into the state owner.`,
    });
    return;
  }
  const pair = getterSetterPair(callbacks);
  if (pair) {
    context.report({
      node: parameter,
      message: `Parameter bag passes a foreign getter/setter pair (${pair.join(", ")}); return a state transition value or move the logic into the state owner.`,
    });
  }
}

function isDirectlyForwarded(sourceCode, parameter, call) {
  if (parameter.type !== "Identifier") return false;
  const binding = findVariable(sourceCode, parameter);
  if (!binding || binding.references.length !== 1) return false;
  const identifier = binding.references[0].identifier;
  return identifier?.parent === call && call.arguments.includes(identifier);
}

function unwrapForwardingExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  return unwrapped?.type === "AwaitExpression"
    ? unwrapExpression(unwrapped.argument)
    : unwrapped;
}

function forwardingBodyExpression(body) {
  if (body.type !== "BlockStatement") return body;
  const [first, second] = body.body;
  if (body.body.length === 1) {
    if (first.type === "ReturnStatement") return first.argument;
    if (first.type === "ExpressionStatement") return first.expression;
  }
  if (
    body.body.length !== 2 ||
    first.type !== "VariableDeclaration" ||
    first.declarations.length !== 1 ||
    second.type !== "ReturnStatement"
  ) {
    return null;
  }
  const [binding] = first.declarations;
  const returned = unwrapForwardingExpression(second.argument);
  return binding.id.type === "Identifier" &&
    returned?.type === "Identifier" &&
    returned.name === binding.id.name
    ? binding.init
    : null;
}

function positionalForwardingCall(owner, sourceCode) {
  const call = unwrapForwardingExpression(forwardingBodyExpression(owner.body));
  if (
    call?.type !== "CallExpression" ||
    call.arguments.length < 2 ||
    call.callee.type !== "Identifier" ||
    !isLocalFunctionBinding(call.callee, sourceCode)
  ) {
    return null;
  }
  const parameterNames = new Set(
    owner.params.flatMap((parameter) => {
      let binding = parameter;
      if (parameter.type === "AssignmentPattern") binding = parameter.left;
      if (parameter.type === "RestElement") binding = parameter.argument;
      return binding.type === "Identifier" ? [binding.name] : [];
    })
  );
  const forwardsArguments = call.arguments.every((argument) => {
    const forwarded = unwrapExpression(
      argument.type === "SpreadElement" ? argument.argument : argument
    );
    return (
      (forwarded?.type === "Identifier" &&
        parameterNames.has(forwarded.name)) ||
      isConstantCallArgument(argument)
    );
  });
  return forwardsArguments ? call : null;
}

function isReturnedRootJsxElement(opening, owner) {
  if (opening?.type !== "JSXOpeningElement") return false;
  let expression = opening.parent;
  while (
    expression.parent?.type === "ConditionalExpression" ||
    expression.parent?.type === "LogicalExpression" ||
    unwrapExpression(expression.parent) === expression
  ) {
    expression = expression.parent;
  }
  if (expression.parent === owner && owner.body === expression) return true;
  if (expression.parent?.type !== "ReturnStatement") return false;
  for (
    let ancestor = expression.parent.parent;
    ancestor;
    ancestor = ancestor.parent
  ) {
    if (isFunctionLike(ancestor)) return ancestor === owner;
  }
  return false;
}

function ownsJsxChildren(opening, sourceCode) {
  return opening.parent.children.some((child) => {
    if (child.type === "JSXText") return child.value.trim().length > 0;
    if (child.type !== "JSXExpressionContainer") return true;
    let expression = unwrapExpression(child.expression);
    if (expression?.type === "JSXEmptyExpression") return false;
    if (expression?.type === "Literal") {
      return (
        typeof expression.value === "number" ||
        (typeof expression.value === "string" && expression.value.length > 0)
      );
    }
    while (expression?.type === "MemberExpression") {
      expression = unwrapExpression(expression.object);
    }
    return (
      expression?.type !== "Identifier" ||
      !findVariable(sourceCode, expression)?.defs.some(
        (definition) => definition.type === "Parameter"
      )
    );
  });
}

function forwardedJsxProp(sourceCode, prop, owner) {
  if (prop.type !== "Property" || prop.value?.type !== "Identifier") {
    return null;
  }
  const binding = findVariable(sourceCode, prop.value);
  if (!binding || binding.references.length !== 1) return null;
  const ref = binding.references[0].identifier;
  const container = ref?.parent;
  const attr = container?.parent;
  const opening = attr?.parent;
  const nameNode = opening?.name;
  return container?.type === "JSXExpressionContainer" &&
    attr?.type === "JSXAttribute" &&
    isReturnedRootJsxElement(opening, owner) &&
    !ownsJsxChildren(opening, sourceCode) &&
    nameNode?.type === "JSXIdentifier" &&
    isLocalFunctionBinding(nameNode, sourceCode)
    ? { node: prop.value, name: prop.value.name, callee: nameNode.name }
    : null;
}

function forwardedJsxProps(sourceCode, parameter, owner) {
  if (parameter.type !== "ObjectPattern") return [];
  const hits = [];
  for (const prop of parameter.properties) {
    const hit = forwardedJsxProp(sourceCode, prop, owner);
    if (hit) hits.push(hit);
  }
  return hits;
}

function memberExtraction(sourceCode, parameter, call) {
  if (parameter.type !== "Identifier" || call?.type !== "CallExpression") {
    return null;
  }
  const references = findVariable(sourceCode, parameter)?.references ?? [];
  if (references.length < 2) return null;
  const members = references.map((reference) => reference.identifier.parent);
  const extracted = members.every(
    (member, index) =>
      member?.type === "MemberExpression" &&
      !member.computed &&
      member.object === references[index].identifier &&
      member.parent === call &&
      call.arguments.includes(member)
  );
  if (
    !extracted ||
    call.callee?.type !== "Identifier" ||
    !isLocalFunctionBinding(call.callee, sourceCode) ||
    findVariable(sourceCode, call.callee)?.defs?.[0]?.type === "Parameter"
  ) {
    return null;
  }
  const properties = new Set(members.map((member) => member.property.name));
  return properties.size >= 2
    ? { callee: call.callee.name, members: [...properties].join(", ") }
    : null;
}

function mutatorClosureTarget(property, sourceCode) {
  const closure = unwrapExpression(property.value);
  if (
    property.type !== "Property" ||
    property.computed ||
    property.key?.type !== "Identifier" ||
    property.key.name === "set" ||
    !isFunctionLike(closure) ||
    closure.params[0]?.type !== "Identifier"
  ) {
    return null;
  }
  const statement =
    closure.body.type === "BlockStatement" && closure.body.body.length === 1
      ? closure.body.body[0]
      : null;
  const assignment = unwrapExpression(
    closure.body.type === "BlockStatement"
      ? statement?.type === "ExpressionStatement" && statement.expression
      : closure.body
  );
  const parameterName = closure.params[0].name;
  if (
    assignment?.type !== "AssignmentExpression" ||
    assignment.operator !== "=" ||
    unwrapExpression(assignment.right)?.type !== "Identifier" ||
    unwrapExpression(assignment.right).name !== parameterName ||
    staticPropertyName(assignment.left) === "current"
  ) {
    return null;
  }
  return isCapturedTarget(assignment.left, closure, sourceCode)
    ? sourceCode.getText(assignment.left)
    : null;
}

function isCapturedTarget(target, closure, sourceCode) {
  const parameterName = closure.params[0].name;
  let root = target;
  while (root?.type === "MemberExpression") root = root.object;
  if (root?.type === "ThisExpression") return target !== root;
  if (root?.type !== "Identifier" || root.name === parameterName) return false;
  const binding = findVariable(sourceCode, root);
  return Boolean(binding) && binding.scope.block !== closure;
}

function checkMutatorClosures(node, context) {
  for (const argument of node.arguments) {
    if (argument.type !== "ObjectExpression") continue;
    for (const property of argument.properties) {
      const target = mutatorClosureTarget(property, context.sourceCode);
      if (!target) continue;
      context.report({
        node: property,
        message: `Call-site closure '${property.key.name}' only writes its argument into captured '${target}'; return the value from the callee or let the state owner subscribe instead.`,
      });
    }
  }
}

function checkParameterBags(node, typeDeclarations, context) {
  if (functionReturnsJsx(node)) return;
  const max = context.options[0]?.max ?? 10;
  const parent = node.parent;
  const inlineCallback =
    parent?.type === "CallExpression" && parent.arguments.includes(node);
  const forwardingCall = inlineCallback
    ? null
    : unwrapForwardingExpression(forwardingBodyExpression(node.body));
  for (const parameter of node.params) {
    const bag = bagShape(parameter, typeDeclarations, context.sourceCode);
    if (bag.shaped && bag.size > max) {
      context.report({
        node: parameter,
        message: `Function parameter bag accepts ${bag.size} properties (max ${max}); group cohesive domain concepts or move behavior onto the owning object.`,
      });
    }
    reportForeignCallbacks(parameter, typeDeclarations, context);
    const extraction = memberExtraction(
      context.sourceCode,
      parameter,
      forwardingCall
    );
    if (extraction) {
      context.report({
        node: parameter,
        messageId: "memberExtraction",
        data: { name: parameter.name, ...extraction },
      });
    }
  }
}

export function passThroughVisitors(context) {
  const sourceCode = context.sourceCode;
  const typeDeclarations = new Map();
  const isTest = isTestFile(ruleFilename(context));

  function checkFunction(node) {
    const candidate = wrapperCandidate(node, sourceCode);
    const forwardingCall =
      node.params.length >= 4 && (!candidate || candidate.exported)
        ? positionalForwardingCall(node, sourceCode)
        : null;
    if (forwardingCall) {
      for (const parameter of node.params) {
        if (isDirectlyForwarded(sourceCode, parameter, forwardingCall)) {
          context.report({
            node: parameter,
            messageId: "passThrough",
            data: { name: parameter.name, callee: forwardingCall.callee.name },
          });
        }
      }
    }
    if (!isTest) {
      for (const parameter of node.params) {
        for (const jsxForward of forwardedJsxProps(
          sourceCode,
          parameter,
          node
        )) {
          context.report({
            node: jsxForward.node,
            messageId: "passThrough",
            data: { name: jsxForward.name, callee: jsxForward.callee },
          });
        }
      }
      checkParameterBags(node, typeDeclarations, context);
    }
  }

  return {
    Program(node) {
      recordProgramTypeDeclarations(node, typeDeclarations);
    },
    FunctionDeclaration: checkFunction,
    FunctionExpression: checkFunction,
    ArrowFunctionExpression: checkFunction,
    CallExpression(node) {
      if (!isTest) checkMutatorClosures(node, context);
    },
  };
}
