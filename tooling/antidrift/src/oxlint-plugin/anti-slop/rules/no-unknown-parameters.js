import { defineRule } from "@oxlint/plugins";
import { findVariable } from "../../../semantic-adapters/async-control-flow.mjs";
import {
  isRejectionHandlerFunction,
  isSerializerSinkUse,
} from "../../unknown-sinks.js";
function parameterAnnotation(parameter) {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}
function parameterName(parameter, sourceText) {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceText);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceText);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument, sourceText);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}
function parameterIdentifier(parameter) {
  let current = parameter;
  while (current?.type === "TSParameterProperty") {
    current = current.parameter;
  }
  if (current?.type === "AssignmentPattern") current = current.left;
  if (current?.type === "RestElement") current = current.argument;
  return current?.type === "Identifier" ? current : null;
}
// An output parameter is exempt only when it is read at least once and every
// read hands the value to a serialization sink; unused parameters, writes,
// and any other read (member access, inline `typeof`/`in` probing, other
// callees) keep the annotation reported.
function readsOnlySerializationSinks(parameter, sourceCode) {
  const identifier = parameterIdentifier(parameter);
  if (!identifier) return false;
  const variable = findVariable(sourceCode, identifier);
  if (!variable) return false;
  if (
    variable.references.some(
      (reference) => reference.isWrite() && !reference.init,
    )
  ) {
    return false;
  }
  const reads = variable.references.filter(
    (reference) => reference.isRead() && !reference.isTypeReference,
  );
  return (
    reads.length > 0 &&
    reads.every((reference) => isSerializerSinkUse(reference.identifier))
  );
}
/**
 * Disallow unknown inputs except positions where `unknown` is honest:
 * parameters named `cause`, rejection-handler parameters, and output
 * parameters whose every read feeds a serialization sink.
 */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    const checkParameters = (node) => {
      if (isRejectionHandlerFunction(node)) return;
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation?.typeAnnotation.type !== "TSUnknownKeyword") continue;
        const name = parameterName(
          parameter,
          context.sourceCode.getText(parameter),
        );
        if (name === "cause") continue;
        if (readsOnlySerializationSinks(parameter, context.sourceCode)) {
          continue;
        }
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };
    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
