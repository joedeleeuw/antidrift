import { readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";
import { unwrapped } from "../kernel/expression-wrappers.ts";

export const BUILD_TOOLS = {
  tsup: {
    configStem: "tsup.config",
    entryPaths: [["entry"]],
    packages: ["tsup"],
  },
  tsdown: {
    configStem: "tsdown.config",
    entryPaths: [["entry"]],
    packages: ["tsdown"],
  },
  vite: {
    configStem: "vite.config",
    entryPaths: [
      ["build", "lib", "entry"],
      ["build", "rollupOptions", "input"],
    ],
    packages: ["vite"],
  },
  rollup: {
    configStem: "rollup.config",
    entryPaths: [["input"]],
    packages: ["rollup"],
  },
  unbuild: {
    configStem: "build.config",
    entryPaths: [["entries"]],
    packages: ["unbuild"],
  },
  rslib: {
    configStem: "rslib.config",
    entryPaths: [["source", "entry"]],
    packages: ["@rslib/core"],
  },
  webpack: {
    configStem: "webpack.config",
    entryPaths: [["entry"]],
    packages: [],
  },
} satisfies Record<
  string,
  {
    configStem: string;
    entryPaths: string[][];
    packages: string[];
  }
>;
export type BuildTool = keyof typeof BUILD_TOOLS;
export function isBuildTool(name: string): name is BuildTool {
  return Object.hasOwn(BUILD_TOOLS, name);
}
export type BuildInput = {
  readonly name?: string | undefined;
  readonly input: string;
};
type Setting =
  | {
      readonly kind: "string";
      readonly text: string;
    }
  | {
      readonly kind: "object";
      readonly entries: ReadonlyMap<string, () => Setting | null>;
    }
  | {
      readonly kind: "array";
      readonly elements: readonly (() => Setting | null)[];
    };
const ALLOWED_CONSTANT_USES = new Set([
  ts.SyntaxKind.SpreadAssignment,
  ts.SyntaxKind.SpreadElement,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.ArrayLiteralExpression,
]);
function propertyKey(
  property: ts.ObjectLiteralElementLike,
  sourceFile: ts.SourceFile
) {
  if (!property.name) {
    throw new TypeError("Configuration property has no name");
  }
  return property.name.getText(sourceFile).replace(/^["']|["']$/gu, "");
}
class ConfigurationReader {
  readonly #sourceFile: ts.SourceFile;
  readonly #tool: BuildTool;
  readonly #constants = new Map<string, ts.VariableDeclaration>();
  readonly #toolDefineConfig = new Set<string>();
  readonly #identifierUses = new Map<string, ts.Identifier[]>();
  constructor(sourceFile: ts.SourceFile, tool: BuildTool) {
    this.#sourceFile = sourceFile;
    this.#tool = tool;
    this.collectConstants();
    this.collectImports();
    this.collectUses(sourceFile);
  }
  collectConstants() {
    for (const statement of this.#sourceFile.statements) {
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.flags & ts.NodeFlags.Const
      ) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            this.#constants.set(declaration.name.text, declaration);
          }
        }
      }
    }
  }
  collectImports() {
    for (const statement of this.#sourceFile.statements) {
      const moduleSpecifier = ts.isImportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
      const importedPackage =
        moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)
          ? moduleSpecifier.text
          : undefined;
      const bindings =
        ts.isImportDeclaration(statement) &&
        importedPackage !== undefined &&
        BUILD_TOOLS[this.#tool].packages.some(
          (packageName) => packageName === importedPackage
        )
          ? statement.importClause?.namedBindings
          : undefined;
      for (const element of bindings && ts.isNamedImports(bindings)
        ? bindings.elements
        : []) {
        if ((element.propertyName ?? element.name).text === "defineConfig") {
          this.#toolDefineConfig.add(element.name.text);
        }
      }
    }
  }
  collectUses(node: ts.Node): void {
    const parent = node.parent;
    if (
      ts.isIdentifier(node) &&
      (!ts.isNamedDeclaration(parent) ||
        parent.name !== node ||
        ts.isShorthandPropertyAssignment(parent))
    ) {
      const uses = this.#identifierUses.get(node.text) ?? [];
      uses.push(node);
      this.#identifierUses.set(node.text, uses);
    }
    ts.forEachChild(node, (child) => this.collectUses(child));
  }
  isToolDefineConfig(node: ts.Node): node is ts.CallExpression {
    return (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      this.#toolDefineConfig.has(node.expression.text) &&
      node.arguments.length === 1
    );
  }
  onlyRead(name: string) {
    return (this.#identifierUses.get(name) ?? []).every((use) => {
      const parent = use.parent;
      if (ts.isShorthandPropertyAssignment(parent)) {
        return true;
      }
      if (ts.isPropertyAssignment(parent)) {
        return parent.initializer === use;
      }
      if (this.isToolDefineConfig(parent)) {
        return parent.arguments[0] === use;
      }
      return (
        ALLOWED_CONSTANT_USES.has(parent.kind) ||
        (ts.isBinaryExpression(parent) &&
          parent.right === use &&
          parent.left.getText(this.#sourceFile) === "module.exports")
      );
    });
  }
  constantSetting(name: string, seen: ReadonlySet<string>): Setting | null {
    const declaration = this.#constants.get(name);
    if (!declaration?.initializer || !this.onlyRead(name) || seen.has(name)) {
      return null;
    }
    return this.evaluate(declaration.initializer, new Set([...seen, name]));
  }
  objectSetting(
    node: ts.ObjectLiteralExpression,
    seen: ReadonlySet<string>
  ): Extract<
    Setting,
    {
      kind: "object";
    }
  > | null {
    const entries = new Map<string, () => Setting | null>();
    for (const property of node.properties) {
      if (property.name && ts.isComputedPropertyName(property.name)) {
        return null;
      }
      if (ts.isSpreadAssignment(property)) {
        const spread = this.evaluate(property.expression, seen);
        if (spread?.kind !== "object") {
          return null;
        }
        for (const [key, setting] of spread.entries) {
          entries.set(key, setting);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        entries.set(property.name.text, () =>
          this.constantSetting(property.name.text, seen)
        );
      } else if (ts.isPropertyAssignment(property)) {
        entries.set(propertyKey(property, this.#sourceFile), () =>
          this.evaluate(property.initializer, seen)
        );
      } else {
        entries.set(propertyKey(property, this.#sourceFile), () => null);
      }
    }
    return { kind: "object", entries };
  }
  arraySetting(
    node: ts.ArrayLiteralExpression,
    seen: ReadonlySet<string>
  ): Extract<
    Setting,
    {
      kind: "array";
    }
  > | null {
    const elements: (() => Setting | null)[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const spread = this.evaluate(element.expression, seen);
        if (spread?.kind !== "array") {
          return null;
        }
        elements.push(...spread.elements);
      } else {
        elements.push(() => this.evaluate(element, seen));
      }
    }
    return { kind: "array", elements };
  }
  evaluate(
    node: ts.Node,
    seen: ReadonlySet<string> = new Set()
  ): Setting | null {
    const expression = unwrapped(node);
    if (ts.isStringLiteralLike(expression)) {
      return { kind: "string", text: expression.text };
    }
    if (ts.isIdentifier(expression)) {
      return this.constantSetting(expression.text, seen);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return this.objectSetting(expression, seen);
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return this.arraySetting(expression, seen);
    }
    if (this.isToolDefineConfig(expression)) {
      const argument = expression.arguments[0];
      if (!argument) {
        throw new TypeError("defineConfig call has no argument");
      }
      return this.evaluate(argument, seen);
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      const { body } = expression;
      if (!ts.isBlock(body)) {
        return this.evaluate(body, seen);
      }
      const [statement] = body.statements;
      return body.statements.length === 1 &&
        statement &&
        ts.isReturnStatement(statement) &&
        statement.expression
        ? this.evaluate(statement.expression, seen)
        : null;
    }
    return null;
  }
}
function exportedConfiguration(sourceFile: ts.SourceFile) {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      return statement.expression;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(sourceFile) === "module.exports"
    ) {
      return statement.expression.right;
    }
  }
  return undefined;
}
function entryInputs(
  setting: Setting | null,
  name: string | undefined
): BuildInput[] | null {
  if (!setting) {
    return null;
  }
  if (setting.kind === "string") {
    return [{ name, input: setting.text }];
  }
  if (setting.kind === "array") {
    const inputs = setting.elements.map((readSetting) =>
      entryInputs(readSetting(), undefined)
    );
    return inputs.some((input) => input === null)
      ? null
      : inputs.flatMap((input) => input ?? []);
  }
  const nested = setting.entries.get("input") ?? setting.entries.get("import");
  if (nested) {
    return entryInputs(nested(), name);
  }
  const inputs = [...setting.entries].map(([key, readSetting]) =>
    entryInputs(readSetting(), key)
  );
  return inputs.some((input) => input === null)
    ? null
    : inputs.flatMap((input) => input ?? []);
}
function configurationInputs(
  configuration: Setting | null,
  path: readonly string[]
) {
  let setting = configuration;
  for (const key of path) {
    if (setting?.kind !== "object") {
      return null;
    }
    const entry = setting.entries.get(key);
    if (!entry) {
      return [];
    }
    setting = entry();
  }
  return entryInputs(setting, undefined);
}
export function declaredBuildInputs(configFile: string, tool: BuildTool) {
  const name = posix.basename(configFile);
  const sourceFile = ts.createSourceFile(
    configFile,
    readFileSync(configFile, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const exported = exportedConfiguration(sourceFile);
  if (!exported) {
    return { unresolved: `${name} has no default export` };
  }
  const exportedSetting = new ConfigurationReader(sourceFile, tool).evaluate(
    exported
  );
  const configurations =
    exportedSetting?.kind === "array"
      ? exportedSetting.elements.map((readSetting) => readSetting())
      : [exportedSetting];
  const inputs: BuildInput[] = [];
  for (const configuration of configurations) {
    if (configuration?.kind !== "object") {
      return {
        unresolved: `${name} exports a ${tool} configuration whose effective setting is not a statically known object`,
      };
    }
    for (const path of BUILD_TOOLS[tool].entryPaths) {
      const found = configurationInputs(configuration, path);
      if (!found) {
        return {
          unresolved: `${name} sets ${path.join(".")} to a setting that is not a statically known entry`,
        };
      }
      inputs.push(...found);
    }
  }
  return { inputs };
}
