import { basename } from "node:path";
import ts from "typescript";

import { boundaryObservations } from "../boundary/boundary-observations.ts";
import { targetOf } from "../provenance/package-program.ts";
import { CallersOutOfView } from "./widening-outside.ts";

type CallerBound =
  | typeof boundaryObservations.bounds.wideningCallSites
  | typeof boundaryObservations.bounds.wideningCallerFiles
  | typeof boundaryObservations.bounds.wideningPackageFiles;

export type CallerSearch =
  | { readonly kind: "calls"; readonly calls: readonly ts.CallExpression[] }
  | { readonly kind: "unseen"; readonly cause: string }
  | {
      readonly kind: "incomplete";
      readonly cause: string;
      readonly bound: CallerBound | null;
    };

type Callable = {
  readonly declaration: FunctionLike;
  readonly name: string;
  readonly nameNode: ts.Identifier | ts.PrivateIdentifier;
  readonly symbol: ts.Symbol;
  readonly instance: ts.Type | null;
  readonly surfaceNode: ts.Identifier | null;
  readonly scope: "file" | "program";
};

type Occurrence =
  | { readonly kind: "call"; readonly call: ts.CallExpression }
  | {
      readonly kind: "alias";
      readonly name: string;
      readonly file: ts.SourceFile | null;
    }
  | { readonly kind: "ignore" }
  | Exclude<CallerSearch, { readonly kind: "calls" }>;

type FunctionLike = ts.SignatureDeclaration;

type PendingName = {
  readonly name: string;
  readonly files: readonly ts.SourceFile[];
};

type NameScan =
  | { readonly kind: "continue"; readonly aliases: readonly PendingName[] }
  | { readonly kind: "stop"; readonly search: CallerSearch };

type CallerTally = { readonly calls: ts.CallExpression[]; examined: number };

const SITE_CAP = boundaryObservations.bounds.wideningCallSites.limit;

const FILE_CAP = boundaryObservations.bounds.wideningCallerFiles.limit;

const IDENTIFIER_PART = /[\w$]/u;

const IGNORE: Occurrence = { kind: "ignore" };

const searches = new WeakMap<ts.Program, Map<ts.Node, CallerSearch>>();

function incomplete(
  cause: string,
  bound: CallerBound | null = null
): Extract<CallerSearch, { readonly kind: "incomplete" }> {
  return { kind: "incomplete", cause, bound };
}

function unseen(cause: string): Extract<CallerSearch, { kind: "unseen" }> {
  return { kind: "unseen", cause };
}

function location(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  return `${basename(sourceFile.fileName)}:${line + 1}`;
}

function* namePositions(text: string, name: string): Generator<number> {
  let index = text.indexOf(name);
  while (index >= 0) {
    const before = text[index - 1] ?? "";
    const after = text[index + name.length] ?? "";
    if (!IDENTIFIER_PART.test(before) && !IDENTIFIER_PART.test(after)) {
      yield index;
    }
    index = text.indexOf(name, index + name.length);
  }
}

function nameAt(
  sourceFile: ts.SourceFile,
  position: number
): ts.Identifier | ts.PrivateIdentifier | null {
  let node: ts.Node = sourceFile;
  for (;;) {
    if (
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
      node.getStart(sourceFile) === position
    ) {
      return node;
    }
    const child = ts.forEachChild(node, (candidate) =>
      candidate.pos <= position && position < candidate.end
        ? candidate
        : undefined
    );
    if (!child) {
      return null;
    }
    node = child;
  }
}

function decorated(node: ts.Node): boolean {
  return (
    ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0
  );
}

/**
 * Finds the in-program calls of one function on demand, memoized per program.
 * A call counts when TypeScript resolves its signature to the function, or,
 * for a method, when the call goes through a receiver type that an instance
 * of the method's class satisfies (a base class, an implemented or structural
 * interface). Any use that is not a call means callers the program cannot see.
 */
export class ProgramCallers {
  readonly #program: ts.Program;
  readonly #checker: ts.TypeChecker;
  readonly #searches: Map<ts.Node, CallerSearch>;
  readonly #outOfView: CallersOutOfView;

  constructor(program: ts.Program, checker: ts.TypeChecker) {
    this.#program = program;
    this.#checker = checker;
    this.#outOfView = new CallersOutOfView(program);
    const known = searches.get(program) ?? new Map<ts.Node, CallerSearch>();
    searches.set(program, known);
    this.#searches = known;
  }

  of(declaration: FunctionLike): CallerSearch {
    const known = this.#searches.get(declaration);
    if (known) {
      return known;
    }
    const search = this.#search(declaration);
    this.#searches.set(declaration, search);
    return search;
  }

  #search(declaration: FunctionLike): CallerSearch {
    const callable = this.#callable(declaration);
    if (!callable) {
      return incomplete("it has no name its callers can use");
    }
    return this.#hazard(callable) ?? this.#collect(callable);
  }

  #callable(declaration: FunctionLike): Callable | null {
    if (ts.isFunctionDeclaration(declaration) && declaration.name) {
      return this.#named(declaration, declaration.name);
    }
    const holder = declaration.parent;
    if (
      (ts.isArrowFunction(declaration) ||
        ts.isFunctionExpression(declaration)) &&
      ts.isVariableDeclaration(holder) &&
      holder.initializer === declaration &&
      ts.isIdentifier(holder.name)
    ) {
      return this.#named(declaration, holder.name);
    }
    if (
      ts.isMethodDeclaration(declaration) &&
      ts.isClassLike(holder) &&
      (ts.isIdentifier(declaration.name) ||
        ts.isPrivateIdentifier(declaration.name))
    ) {
      return this.#method(declaration, declaration.name, holder);
    }
    return null;
  }

  #named(declaration: FunctionLike, name: ts.Identifier): Callable | null {
    const declared = this.#checker.getSymbolAtLocation(name);
    if (!declared) {
      return null;
    }
    const symbol = targetOf(this.#checker, declared);
    const exported = this.#exported(name, symbol);
    return {
      declaration,
      name: name.text,
      nameNode: name,
      symbol,
      instance: null,
      surfaceNode: exported ? name : null,
      scope: exported ? "program" : "file",
    };
  }

  #exported(name: ts.Identifier, symbol: ts.Symbol): boolean {
    const sourceFile = name.getSourceFile();
    const declaration = symbol.valueDeclaration;
    if (
      !ts.isExternalModule(sourceFile) ||
      (declaration &&
        (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !==
          0)
    ) {
      return true;
    }
    const moduleSymbol = this.#checker.getSymbolAtLocation(sourceFile);
    return Boolean(
      moduleSymbol &&
      this.#checker
        .getExportsOfModule(moduleSymbol)
        .some((exported) => targetOf(this.#checker, exported) === symbol)
    );
  }

  #method(
    declaration: ts.MethodDeclaration,
    name: ts.Identifier | ts.PrivateIdentifier,
    owner: ts.ClassLikeDeclaration
  ): Callable | null {
    const checker = this.#checker;
    const declared = checker.getSymbolAtLocation(name);
    const symbol = declared && targetOf(checker, declared);
    const classSymbol = owner.name
      ? checker.getSymbolAtLocation(owner.name)
      : undefined;
    if (!symbol || !classSymbol) {
      return null;
    }
    const flags = ts.getCombinedModifierFlags(declaration);
    const hidden =
      ts.isPrivateIdentifier(name) || (flags & ts.ModifierFlags.Private) !== 0;
    return {
      declaration,
      name: name.text,
      nameNode: name,
      symbol,
      instance:
        (flags & ts.ModifierFlags.Static) !== 0
          ? checker.getTypeOfSymbol(classSymbol)
          : checker.getDeclaredTypeOfSymbol(classSymbol),
      surfaceNode: hidden ? null : (owner.name ?? null),
      scope: hidden ? "file" : "program",
    };
  }

  #hazard(callable: Callable): CallerSearch | null {
    const { declaration } = callable;
    const overloads = (callable.symbol.declarations ?? []).filter(
      ts.isFunctionLike
    );
    if (overloads.length > 1) {
      return incomplete("it is overloaded");
    }
    const owner = declaration.parent;
    if (decorated(declaration) || (callable.instance && decorated(owner))) {
      return unseen("it is decorated, so a framework may call it");
    }
    if (
      callable.instance &&
      ts.isClassLike(owner) &&
      this.#overridesLibraryMember(owner, callable.name)
    ) {
      return unseen("it overrides a library member, so the library calls it");
    }
    return callable.surfaceNode
      ? this.#outOfView.of(callable.surfaceNode, callable.name)
      : null;
  }

  #overridesLibraryMember(owner: ts.ClassLikeDeclaration, name: string) {
    const heritage = (owner.heritageClauses ?? []).flatMap(
      (clause) => clause.types
    );
    return heritage.some((reference) => {
      const base = this.#checker.getTypeAtLocation(reference);
      const member = this.#checker.getPropertyOfType(base, name);
      return (member?.declarations ?? []).some((memberDeclaration) =>
        this.#library(memberDeclaration.getSourceFile())
      );
    });
  }

  #library(sourceFile: ts.SourceFile): boolean {
    return (
      sourceFile.isDeclarationFile ||
      this.#program.isSourceFileFromExternalLibrary(sourceFile) ||
      this.#program.isSourceFileDefaultLibrary(sourceFile)
    );
  }

  #files(name: string): readonly ts.SourceFile[] {
    return this.#program
      .getSourceFiles()
      .filter(
        (sourceFile) =>
          !this.#library(sourceFile) && sourceFile.text.includes(name)
      );
  }

  #collect(callable: Callable): CallerSearch {
    const tally: CallerTally = { calls: [], examined: 0 };
    const pending: PendingName[] = [
      {
        name: callable.name,
        files:
          callable.scope === "file"
            ? [callable.declaration.getSourceFile()]
            : this.#files(callable.name),
      },
    ];
    for (let next = pending.shift(); next; next = pending.shift()) {
      const scan = this.#scanName(next, callable, tally);
      if (scan.kind === "stop") {
        return scan.search;
      }
      pending.push(...scan.aliases);
    }
    return tally.calls.length > 0
      ? { kind: "calls", calls: tally.calls }
      : incomplete("it has no call site in this program");
  }

  #scanName(
    pending: PendingName,
    callable: Callable,
    tally: CallerTally
  ): NameScan {
    if (pending.files.length > FILE_CAP) {
      return {
        kind: "stop",
        search: incomplete(
          `${pending.files.length} files mention ${pending.name}`,
          boundaryObservations.bounds.wideningCallerFiles
        ),
      };
    }
    const aliases: PendingName[] = [];
    for (const sourceFile of pending.files) {
      for (const position of namePositions(sourceFile.text, pending.name)) {
        tally.examined += 1;
        if (tally.examined > SITE_CAP) {
          return {
            kind: "stop",
            search: incomplete(
              `more than ${SITE_CAP} occurrences of ${callable.name}`,
              boundaryObservations.bounds.wideningCallSites
            ),
          };
        }
        const token = nameAt(sourceFile, position);
        const occurrence =
          token && token !== callable.nameNode
            ? this.#classify(token, callable)
            : IGNORE;
        if (occurrence.kind === "call") {
          tally.calls.push(occurrence.call);
        } else if (occurrence.kind === "alias") {
          aliases.push({
            name: occurrence.name,
            files: occurrence.file
              ? [occurrence.file]
              : this.#files(occurrence.name),
          });
        } else if (occurrence.kind !== "ignore") {
          return { kind: "stop", search: occurrence };
        }
      }
    }
    return { kind: "continue", aliases };
  }

  #classify(
    token: ts.Identifier | ts.PrivateIdentifier,
    callable: Callable
  ): Occurrence {
    const parent = token.parent;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
      return this.#specifier(parent, token, callable);
    }
    if (ts.isExportAssignment(parent)) {
      return this.#refersTo(token, callable)
        ? unseen("it is the default export")
        : IGNORE;
    }
    const callee =
      ts.isPropertyAccessExpression(parent) && parent.name === token
        ? parent
        : token;
    const call = callee.parent;
    if (ts.isCallExpression(call) && call.expression === callee) {
      return this.#call(call, callee, token, callable);
    }
    if (callee !== token && callable.instance) {
      return this.#reaches(callee, callable.instance)
        ? unseen(`it is referenced without a call at ${location(token)}`)
        : IGNORE;
    }
    return this.#refersTo(token, callable)
      ? unseen(`it is referenced by identity at ${location(token)}`)
      : IGNORE;
  }

  #specifier(
    specifier: ts.ImportSpecifier | ts.ExportSpecifier,
    token: ts.Identifier | ts.PrivateIdentifier,
    callable: Callable
  ): Occurrence {
    if (!ts.isIdentifier(token) || !this.#refersTo(token, callable)) {
      return IGNORE;
    }
    const alias = specifier.name.text;
    if (ts.isExportSpecifier(specifier) && alias === "default") {
      return unseen("it is the default export");
    }
    if (alias === callable.name) {
      return IGNORE;
    }
    return {
      kind: "alias",
      name: alias,
      file: ts.isImportSpecifier(specifier) ? token.getSourceFile() : null,
    };
  }

  /**
   * A call names the function when its callee resolves to the function's
   * symbol, which needs no overload resolution. A method call through another
   * member counts when an instance of the method's class can be its receiver.
   */
  #call(
    call: ts.CallExpression,
    callee: ts.Expression,
    token: ts.Identifier | ts.PrivateIdentifier,
    callable: Callable
  ): Occurrence {
    if (this.#refersTo(token, callable)) {
      return { kind: "call", call };
    }
    if (!callable.instance || !ts.isPropertyAccessExpression(callee)) {
      return IGNORE;
    }
    const receiver = this.#checker.getTypeAtLocation(callee.expression);
    if ((receiver.flags & ts.TypeFlags.Any) !== 0) {
      return incomplete(
        `a call on an untyped receiver at ${location(call)} may reach it`
      );
    }
    return this.#reaches(callee, callable.instance)
      ? { kind: "call", call }
      : IGNORE;
  }

  #reaches(access: ts.Expression, instance: ts.Type): boolean {
    if (!ts.isPropertyAccessExpression(access)) {
      return false;
    }
    const receiver = this.#checker.getTypeAtLocation(access.expression);
    const members = receiver.isUnion() ? receiver.types : [receiver];
    return members.some((member) =>
      this.#checker.isTypeAssignableTo(instance, member)
    );
  }

  #refersTo(
    token: ts.Identifier | ts.PrivateIdentifier,
    callable: Callable
  ): boolean {
    const checker = this.#checker;
    const parent = token.parent;
    const symbol =
      ts.isShorthandPropertyAssignment(parent) && parent.name === token
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(token);
    return Boolean(
      symbol &&
      [symbol, ...checker.getRootSymbols(symbol)].some(
        (candidate) => targetOf(checker, candidate) === callable.symbol
      )
    );
  }
}
