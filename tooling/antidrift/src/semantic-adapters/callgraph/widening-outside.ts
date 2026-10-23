import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type ts from "typescript";

import { boundaryObservations } from "../boundary/boundary-observations.ts";
import { publicSurface } from "../provenance/package-entry-points.ts";

/** Why an exported function's callers are out of the program's view, or why that could not be decided. */
type OutOfView =
  | { readonly kind: "unseen"; readonly cause: string }
  | {
      readonly kind: "incomplete";
      readonly cause: string;
      readonly bound:
        | typeof boundaryObservations.bounds.wideningPackageFiles
        | null;
    };

type PackageSource = { readonly path: string; readonly text: string };

const PACKAGE_FILE_CAP = boundaryObservations.bounds.wideningPackageFiles.limit;

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
]);

const SOURCE_FILE = /\.[cm]?[jt]sx?$/u;

const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

const outsideByProgram = new WeakMap<
  ts.Program,
  Map<string, readonly PackageSource[] | null>
>();

function packageRoot(fileName: string): string | null {
  let directory = dirname(fileName);
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
  return directory;
}

/** Source paths under a package root, skipping nested packages, dependencies and build output; null past the cap. */
function packageSourcePaths(root: string): string[] | null {
  const found: string[] = [];
  const pending = [root];
  for (
    let directory = pending.pop();
    directory !== undefined;
    directory = pending.pop()
  ) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          !entry.name.startsWith(".") &&
          !SKIPPED_DIRECTORIES.has(entry.name) &&
          !existsSync(join(path, "package.json"))
        ) {
          pending.push(path);
        }
      } else if (
        SOURCE_FILE.test(entry.name) &&
        !DECLARATION_FILE.test(entry.name)
      ) {
        found.push(path);
        if (found.length > PACKAGE_FILE_CAP) {
          return null;
        }
      }
    }
  }
  return found;
}

/**
 * Callers a program cannot see for an exported function: whatever a package
 * entry point exports, and calls from files of the declaring package that the
 * program does not hold, such as tests or scripts under another tsconfig.
 */
export class CallersOutOfView {
  readonly #program: ts.Program;
  readonly #outside: Map<string, readonly PackageSource[] | null>;

  constructor(program: ts.Program) {
    this.#program = program;
    const known =
      outsideByProgram.get(program) ??
      new Map<string, readonly PackageSource[] | null>();
    outsideByProgram.set(program, known);
    this.#outside = known;
  }

  of(surfaceNode: ts.Identifier, name: string): OutOfView | null {
    const surface = publicSurface(this.#program, surfaceNode);
    if (surface.owner) {
      return { kind: "unseen", cause: surface.owner };
    }
    if (surface.incomplete) {
      return { kind: "incomplete", cause: surface.incomplete, bound: null };
    }
    const root = packageRoot(surfaceNode.getSourceFile().fileName);
    const outside = root === null ? [] : this.#outsideSources(root);
    if (outside === null) {
      return {
        kind: "incomplete",
        cause: `its package has more than ${PACKAGE_FILE_CAP} source files`,
        bound: boundaryObservations.bounds.wideningPackageFiles,
      };
    }
    const pattern = new RegExp(
      `(?<![\\w$])${name.replaceAll("$", "\\$")}(?![\\w$])`,
      "u"
    );
    const mention = outside.find(
      (source) => source.text.includes(name) && pattern.test(source.text)
    );
    return mention && root !== null
      ? {
          kind: "unseen",
          cause: `${relative(root, mention.path)} mentions it outside this program`,
        }
      : null;
  }

  #outsideSources(root: string): readonly PackageSource[] | null {
    const known = this.#outside.get(root);
    if (known !== undefined) {
      return known;
    }
    const paths = packageSourcePaths(root);
    const sources =
      paths === null
        ? null
        : paths
            .filter((path) => !this.#program.getSourceFile(path))
            .map((path) => ({ path, text: readFileSync(path, "utf8") }));
    this.#outside.set(root, sources);
    return sources;
  }
}
