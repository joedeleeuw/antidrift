import ts from "typescript";

const GENERATED_DECLARATION_FORMS = [
  /^@generated(?:\b|$)/u,
  /\bdo[\s-]*not[\s-]*(?:edit|modify)\b/iu,
  /\bthis (?:file|code) (?:is|was|has been)\b.*\bgenerated\b/iu,
  /\bthis is code generated\b/iu,
  /^generated (?:by|from|with|using)\b/iu,
  /\bauto-?generated\b/iu,
];

function isGeneratedDeclarationLine(rawLine: string): boolean {
  const cleanedLine = rawLine.replace(/^\s*\*+\s*/u, "").trim();
  return GENERATED_DECLARATION_FORMS.some((form) => form.test(cleanedLine));
}

export function isDeclaredGeneratedSource(sourceText: string): boolean {
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

const generationDeclarations = [
  /^@generated\b/u,
  /^code generated\b.*\bdo not edit\.?$/iu,
  /^(?:this (?:(?:file|module) )?(?:is|was|has been) )?(?:auto(?:matically)?[- ]?)?generated (?:by|from|with|using) \S/iu,
];

function commentLines(text: string): string[] {
  return text
    .replace(/^\/\*+|\*+\/$/gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/+|\*+)?\s*/u, "").trim());
}

export function declaresGenerated(source: ts.SourceFile): boolean {
  return (ts.getLeadingCommentRanges(source.text, 0) ?? []).some((range) =>
    commentLines(source.text.slice(range.pos, range.end)).some((line) =>
      generationDeclarations.some((declaration) => declaration.test(line))
    )
  );
}
