import ts from "typescript";

const GENERATED_DECLARATION_FORMS = [
  /^@generated(?:\b|$)/u,
  /\bdo[\s-]*not[\s-]*(?:edit|modify)\b/iu,
  /\bthis (?:file|code) (?:is|was|has been)\b.*\bgenerated\b/iu,
  /\bthis is code generated\b/iu,
  /^generated (?:by|from|with|using)\b/iu,
  /\bauto-?generated\b/iu,
];

export function isGeneratedDeclarationLine(rawLine) {
  const cleanedLine = rawLine.replace(/^\s*\*+\s*/u, "").trim();
  return GENERATED_DECLARATION_FORMS.some((form) => form.test(cleanedLine));
}

export function isDeclaredGeneratedSource(sourceText) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText
  );
  for (;;) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) {
      return false;
    }
    if (
      token === ts.SyntaxKind.WhitespaceTrivia ||
      token === ts.SyntaxKind.NewLineTrivia ||
      token === ts.SyntaxKind.ShebangTrivia
    ) {
      continue;
    }
    if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
      if (
        isGeneratedDeclarationLine(
          scanner.getTokenText().replace(/^\/\/+/u, "")
        )
      ) {
        return true;
      }
      continue;
    }
    if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const body = scanner
        .getTokenText()
        .replace(/^\/\*+/u, "")
        .replace(/\*+\/$/u, "");
      if (body.split(/\r?\n/u).some(isGeneratedDeclarationLine)) {
        return true;
      }
      continue;
    }
    return false;
  }
}
