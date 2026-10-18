import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import ts from "typescript";
import { z } from "zod";

import { rootCases } from "./source-cases.ts";

const packageManifest = z.object({
  name: z.string().optional(),
  dependencies: z.record(z.string()).optional(),
  devDependencies: z.record(z.string()).optional(),
  peerDependencies: z.record(z.string()).optional(),
  optionalDependencies: z.record(z.string()).optional(),
});

export type PackageOwner = z.infer<typeof packageManifest> & {
  readonly manifest: string;
};

type PackageOwnedCase = {
  readonly owner?: string | undefined;
  readonly owners?: readonly string[] | undefined;
};

function readManifest(filename: string) {
  try {
    return packageManifest.parse(JSON.parse(readFileSync(filename, "utf8")));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Boundary model: invalid package manifest ${filename}: ${reason}`,
      { cause }
    );
  }
}

export function rowMatchesOwner(
  row: PackageOwnedCase,
  packageName: string | undefined
): boolean {
  return Boolean(
    packageName &&
    (row.owner === packageName || row.owners?.includes(packageName))
  );
}

function declarationPath(declaration: ts.Node) {
  const source = declaration.getSourceFile();
  const modules: string[] = [];
  const names: string[] = [];
  for (
    let ancestor = declaration;
    !ts.isSourceFile(ancestor);
    ancestor = ancestor.parent
  ) {
    if (ts.isModuleDeclaration(ancestor) && ts.isStringLiteral(ancestor.name)) {
      modules.push(ancestor.name.text.replace(/^node:/u, ""));
    } else if (
      !(ancestor.flags & ts.NodeFlags.GlobalAugmentation) &&
      ts.isNamedDeclaration(ancestor) &&
      !ts.isParameter(ancestor) &&
      !ts.isTypeParameterDeclaration(ancestor)
    ) {
      names.unshift(ancestor.name.getText(source));
    }
  }
  const parameterSymbol = ts.isParameter(declaration)
    ? [...names, declaration.name.getText(source)].join(".")
    : null;
  return { modules, baseSymbol: names.join("."), parameterSymbol };
}

export class DeclarationFacts {
  readonly #program: ts.Program;
  readonly #checker: ts.TypeChecker;
  readonly #packages = new Map<string, PackageOwner | null>();
  readonly #dependencySets = new Map<PackageOwner, ReadonlySet<string>>();
  readonly #callsBySource = new WeakMap<
    ts.SourceFile,
    readonly (ts.CallExpression | ts.NewExpression)[]
  >();

  constructor(program: ts.Program, checker: ts.TypeChecker) {
    this.#program = program;
    this.#checker = checker;
  }

  packageAt(filename: string): PackageOwner | null {
    let directory = dirname(filename);
    const searched: string[] = [];
    while (!this.#packages.has(directory)) {
      searched.push(directory);
      const owner = this.#manifestOwner(directory);
      if (owner) {
        this.#packages.set(directory, owner);
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) {
        this.#packages.set(directory, null);
        break;
      }
      directory = parent;
    }
    const owner = this.#packages.get(directory) ?? null;
    for (const searchedDirectory of searched) {
      this.#packages.set(searchedDirectory, owner);
    }
    return owner;
  }

  origin(declaration: ts.Node, use: ts.Node): "platform" | "dependency" | null {
    const source = declaration.getSourceFile();
    if (this.#program.isSourceFileDefaultLibrary(source)) {
      return "platform";
    }
    const owner = this.packageAt(source.fileName);
    if (owner?.name === "@types/node") {
      return "platform";
    }
    if (!owner) {
      return null;
    }
    const dependencies = this.#dependencies(use.getSourceFile());
    return owner.name !== undefined && dependencies.has(owner.name)
      ? "dependency"
      : null;
  }

  platformSource(declaration: ts.Node) {
    const source = declaration.getSourceFile();
    const { modules, baseSymbol, parameterSymbol } =
      declarationPath(declaration);
    const ownerName = this.packageAt(source.fileName)?.name;
    const sourceName = basename(source.fileName);
    return rootCases.find((row) => {
      const symbolMatches =
        row.symbols?.includes(baseSymbol) ||
        Boolean(parameterSymbol && row.symbols?.includes(parameterSymbol));
      if (!symbolMatches) {
        return false;
      }
      if (row.libraries) {
        return (
          this.#program.isSourceFileDefaultLibrary(source) &&
          row.libraries.includes(sourceName)
        );
      }
      return (
        rowMatchesOwner(row, ownerName) &&
        (!row.files || row.files.includes(sourceName)) &&
        (!row.modules || row.modules.some((module) => modules.includes(module)))
      );
    });
  }

  exported(declaration: ts.Node): boolean {
    const sourceSymbol = this.#checker.getSymbolAtLocation(
      declaration.getSourceFile()
    );
    if (!sourceSymbol) {
      return false;
    }
    const binding = ts.isVariableDeclaration(declaration.parent)
      ? declaration.parent
      : declaration;
    return this.#checker.getExportsOfModule(sourceSymbol).some((symbol) => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias
          ? this.#checker.getAliasedSymbol(symbol)
          : symbol;
      return (target.declarations ?? []).some(
        (candidate) => candidate === binding
      );
    });
  }

  callsInSource(source: ts.SourceFile) {
    const cached = this.#callsBySource.get(source);
    if (cached) {
      return cached;
    }
    const collected: (ts.CallExpression | ts.NewExpression)[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        collected.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    this.#callsBySource.set(source, collected);
    return collected;
  }

  #manifestOwner(directory: string): PackageOwner | null {
    const manifest = join(directory, "package.json");
    if (!existsSync(manifest)) {
      return null;
    }
    const contract = readManifest(manifest);
    return contract.name || contract.dependencies || contract.devDependencies
      ? { manifest, ...contract }
      : null;
  }

  #ownerChain(owner: PackageOwner): PackageOwner[] {
    const chain: PackageOwner[] = [];
    let currentOwner = owner;
    for (;;) {
      chain.push(currentOwner);
      const packageDirectory = dirname(currentOwner.manifest);
      const parentDirectory = dirname(packageDirectory);
      if (parentDirectory === packageDirectory) {
        return chain;
      }
      const nextOwner = this.packageAt(parentDirectory);
      if (!nextOwner || nextOwner.manifest === currentOwner.manifest) {
        return chain;
      }
      currentOwner = nextOwner;
    }
  }

  #dependencies(source: ts.SourceFile): ReadonlySet<string> {
    const owner = this.packageAt(source.fileName);
    if (!owner) {
      throw new Error(
        `Boundary model: missing package.json for ${source.fileName}`
      );
    }
    const cached = this.#dependencySets.get(owner);
    if (cached) {
      return cached;
    }
    const manifests = new Map<string, PackageOwner>();
    for (const loaded of this.#program.getSourceFiles()) {
      const dependency = this.packageAt(loaded.fileName);
      if (dependency?.name) {
        manifests.set(dependency.name, dependency);
      }
    }
    const names = new Set<string>();
    const pending = this.#ownerChain(owner);
    for (let manifest = pending.pop(); manifest; manifest = pending.pop()) {
      for (const name of Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      })) {
        const dependency = manifests.get(name);
        if (!names.has(name) && dependency) {
          pending.push(dependency);
        }
        names.add(name);
      }
    }
    this.#dependencySets.set(owner, names);
    return names;
  }
}
