import type { Rule } from "eslint";
import ts from "typescript";

import { findVariable } from "../kernel/async-control-flow.ts";
import type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
import { fieldOf, syntaxField } from "../kernel/syntax-node.ts";
import { bindingDefinitions } from "../kernel/syntax-scope.ts";
import { isAnyOrUnknownType, isJsonParseCall } from "./parse-input.ts";

const LIB_DECLARATION_FILE = /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/u;

export function parsedJsonTarget(
  node: unknown,
  context: Pick<Rule.RuleContext, "sourceCode">,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): string | null {
  const seen = new Set<object>();
  const isGlobalJsonParse = (candidate: unknown): boolean => {
    if (!isJsonParseCall(candidate)) {
      return false;
    }
    const jsonReceiver = services.esTreeNodeToTSNodeMap.get(
      syntaxField(syntaxField(candidate, "callee"), "object")
    );
    const symbol = jsonReceiver && checker.getSymbolAtLocation(jsonReceiver);
    return (symbol?.declarations ?? []).some((declaration) =>
      LIB_DECLARATION_FILE.test(declaration.getSourceFile().fileName)
    );
  };
  const isParsedJson = (candidate: unknown): boolean => {
    if (isGlobalJsonParse(candidate)) {
      return true;
    }
    const binding = findVariable(context.sourceCode, candidate);
    if (!binding || seen.has(binding)) {
      return false;
    }
    seen.add(binding);
    const [definition] = bindingDefinitions(binding);
    if (
      fieldOf(definition, "type") !== "Variable" ||
      syntaxField(fieldOf(definition, "parent"), "kind") !== "const"
    ) {
      return false;
    }
    return isParsedJson(syntaxField(fieldOf(definition, "node"), "init"));
  };
  if (!isParsedJson(node)) {
    return null;
  }
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  const target =
    tsNode && ts.isExpression(tsNode)
      ? checker.getContextualType(tsNode)
      : undefined;
  if (!target || isAnyOrUnknownType(target)) {
    return null;
  }
  return checker.typeToString(target);
}
