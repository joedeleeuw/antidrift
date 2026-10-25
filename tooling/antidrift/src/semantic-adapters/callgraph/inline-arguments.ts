import ts from "typescript";

const BARE_ARGUMENT_KINDS = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.ElementAccessExpression,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

export function requireArgumentText(texts: readonly string[], index: number) {
  const text = texts[index];
  if (text === undefined) {
    throw new TypeError(`No inlined argument text for parameter ${index}`);
  }
  return text;
}

function argumentText(sourceFile: ts.SourceFile, argument: ts.Expression) {
  const text = argument.getText(sourceFile);
  const optionalChain = ts.isOptionalChain(argument);
  return BARE_ARGUMENT_KINDS.has(argument.kind) && !optionalChain
    ? text
    : `(${text})`;
}

export function argumentTexts(
  functionNode: ts.SignatureDeclaration,
  call: ts.CallExpression
) {
  const sourceFile = call.getSourceFile();
  return functionNode.parameters.map((parameter, index) => {
    if (parameter.dotDotDotToken) {
      return `[${call.arguments
        .slice(index)
        .map((argument) => argumentText(sourceFile, argument))
        .join(", ")}]`;
    }
    const argument = call.arguments[index];
    return argument ? argumentText(sourceFile, argument) : "undefined";
  });
}
