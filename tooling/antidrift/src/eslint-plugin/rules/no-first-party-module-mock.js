import ts from "typescript";

import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

// Module-registry calls that replace a module for every importer in the test.
const MOCK_METHODS = new Map([
  ["vi", new Set(["mock", "doMock"])],
  ["jest", new Set(["mock", "doMock", "setMock", "unstable_mockModule"])],
]);

function bunMockBindings(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    const bindings = statement.importClause?.namedBindings;
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "bun:test" &&
      bindings &&
      ts.isNamedImports(bindings)
    ) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "mock") {
          names.add(element.name.text);
        }
      }
    }
  }
  return names;
}

function mockedSpecifier(call, bunMocks) {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression)
  ) {
    return null;
  }
  const receiver = callee.expression.text;
  const method = callee.name.text;
  if (
    !MOCK_METHODS.get(receiver)?.has(method) &&
    !(bunMocks.has(receiver) && method === "module")
  ) {
    return null;
  }
  const [target] = call.arguments;
  if (target && ts.isStringLiteralLike(target)) {
    return target;
  }
  const [imported] =
    target &&
    ts.isCallExpression(target) &&
    target.expression.kind === ts.SyntaxKind.ImportKeyword
      ? target.arguments
      : [];
  return imported && ts.isStringLiteralLike(imported) ? imported : null;
}

export function ruleNoFirstPartyModuleMock() {
  return defineTypeScriptRule({
    ruleName: "no-first-party-module-mock",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow test module mocks of first-party modules, which make assertions check the replacement instead of the module.",
      },
      schema: [],
      messages: {
        firstPartyMock:
          "This test replaces the first-party module '{{specifier}}', so its assertions check the replacement instead of the module. Run the real module and replace only the external boundary it reaches, such as the network, storage, the clock or a third-party SDK.",
      },
    },
    run({ sourceFile, program, reportNode }) {
      const bunMocks = bunMockBindings(sourceFile);
      const options = program.getCompilerOptions();
      return {
        [ts.SyntaxKind.CallExpression](call) {
          const specifier = mockedSpecifier(call, bunMocks);
          if (!specifier) return;
          // A workspace package linked into node_modules resolves to its real
          // path in the repository; a third-party package stays under node_modules.
          const resolved = ts.resolveModuleName(
            specifier.text,
            sourceFile.fileName,
            options,
            ts.sys,
            undefined,
            undefined,
            sourceFile.impliedNodeFormat
          ).resolvedModule;
          if (
            resolved &&
            !/[\\/]node_modules[\\/]/u.test(resolved.resolvedFileName)
          ) {
            reportNode(specifier, {
              messageId: "firstPartyMock",
              data: { specifier: specifier.text },
            });
          }
        },
      };
    },
  });
}
