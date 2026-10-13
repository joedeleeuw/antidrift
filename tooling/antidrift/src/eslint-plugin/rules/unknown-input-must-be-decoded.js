import ts from "typescript";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

function declaresUnknown(annotation, checker) {
  return Boolean(
    annotation &&
    checker.getTypeFromTypeNode(annotation).flags & ts.TypeFlags.Unknown
  );
}

function decodesParameter(parameter) {
  const predicate = parameter.parent.type;
  return Boolean(
    predicate &&
    ts.isTypePredicateNode(predicate) &&
    ts.isIdentifier(predicate.parameterName) &&
    ts.isIdentifier(parameter.name) &&
    predicate.parameterName.text === parameter.name.text
  );
}

function receivesUnknown(expression, checker, visited) {
  if (visited.has(expression)) return false;
  visited.add(expression);
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return receivesUnknown(expression.expression, checker, visited);
  }
  if (ts.isCallExpression(expression)) {
    const declaration = checker.getResolvedSignature(expression)?.declaration;
    if (!declaration?.type) return false;
    const declared = checker.getTypeFromTypeNode(declaration.type);
    const received = checker.getAwaitedType(declared);
    return Boolean(received && received.flags & ts.TypeFlags.Unknown);
  }
  if (!ts.isIdentifier(expression)) return false;
  const declarations = checker.getSymbolAtLocation(expression)?.declarations;
  return Boolean(
    declarations?.some((declaration) => {
      if (ts.isParameter(declaration)) {
        return (
          declaresUnknown(declaration.type, checker) &&
          !decodesParameter(declaration)
        );
      }
      if (!ts.isVariableDeclaration(declaration)) return false;
      if (ts.isCatchClause(declaration.parent)) {
        return declaresUnknown(declaration.type, checker);
      }
      return Boolean(
        declaration.initializer &&
        receivesUnknown(declaration.initializer, checker, visited)
      );
    })
  );
}

export default function ruleUnknownInputMustBeDecoded() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require decoding before a type assertion replaces a declared unknown input.",
      },
      schema: [],
      messages: {
        decodeUnknown:
          "This assertion gives a declared unknown input an unchecked type. Decode or narrow the input first.",
      },
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "unknown-input-must-be-decoded"
        );
      }
      const checker = services.program.getTypeChecker();
      function check(node) {
        const operand = services.esTreeNodeToTSNodeMap.get(node.expression);
        if (
          checker.getTypeAtLocation(operand).flags & ts.TypeFlags.Unknown &&
          receivesUnknown(operand, checker, new Set())
        ) {
          context.report({ node, messageId: "decodeUnknown" });
        }
      }
      return { TSAsExpression: check, TSTypeAssertion: check };
    },
  };
}
