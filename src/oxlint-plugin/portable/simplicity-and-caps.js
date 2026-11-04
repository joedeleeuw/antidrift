import { relative, resolve } from "node:path";
import { packageOwner } from "./package-owner.js";
import {
  collectTypePropertyNames,
  recordProgramTypeDeclarations,
} from "./parameter-bag-checks.js";
import {
  hasPlatformSibling,
  isRuleFile,
  ruleFilename,
  scopeProperties,
} from "../shared/rule-scope.js";
import {
  findVariable,
  functionReturnsJsx,
  hasWidgetDirective,
  isFunctionLike,
} from "../shared/scope.js";
import {
  resolvedDeclarationFiles,
  resolvedOwnedPropertyNames,
} from "../shared/type-services.js";

function nonBlankLineCount(text) {
  let count = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

function collectManifestTargetStems(entry, stems = new Set()) {
  if (typeof entry === "string") {
    const normalized = entry
      .replace(/^\.\//u, "")
      .replace(/^dist\//u, "src/")
      .replace(/\.(?:d\.[cm]?ts|[cm]?[jt]sx?)$/u, "");
    stems.add(normalized);
    return stems;
  }
  if (entry && typeof entry === "object") {
    for (const child of Object.values(entry)) {
      collectManifestTargetStems(child, stems);
    }
  }
  return stems;
}

function isDeclaredPackageIndex(filename) {
  if (!/\/index\.[cm]?[jt]sx?$/u.test(filename)) return false;
  if (!filename.startsWith("/")) {
    return /(?:^|\/)src\/index\.[cm]?[jt]sx?$|^index\.[cm]?[jt]sx?$/u.test(
      filename
    );
  }
  const owner = packageOwner(filename);
  if (!owner) {
    return /(?:^|\/)src\/index\.[cm]?[jt]sx?$/u.test(filename);
  }
  const relFile = relative(owner.directory, resolve(filename))
    .replaceAll("\\", "/")
    .replace(/\.[cm]?[jt]sx?$/u, "");
  if (relFile === "index" || relFile === "src/index") return true;
  const stems = collectManifestTargetStems({
    main: owner.manifest.main,
    module: owner.manifest.module,
    types: owner.manifest.types,
    bin: owner.manifest.bin,
    exports: owner.manifest.exports,
  });
  return stems.has(relFile);
}

function isOwnSliceReexport(stem, stmt) {
  if (!stem || typeof stmt.source?.value !== "string") return false;
  const src = stmt.source.value;
  return src.startsWith(`./${stem}.`) || src.startsWith(`./${stem}-`);
}

function collectFunctionParamTypeLines(stmt, sourceCode) {
  const decl =
    stmt.type === "ExportNamedDeclaration" ||
    stmt.type === "ExportDefaultDeclaration"
      ? stmt.declaration
      : stmt;
  if (decl?.type !== "FunctionDeclaration") return 0;
  return (decl.params ?? []).reduce(
    (sum, parameter) =>
      sum +
      (parameter.typeAnnotation
        ? nonBlankLineCount(sourceCode.getText(parameter.typeAnnotation))
        : 0),
    0
  );
}

function checkSplitModuleCeremony(programNode, context) {
  const sourceCode = context.sourceCode;
  const totalLines = nonBlankLineCount(sourceCode.text);
  if (totalLines <= 120) return;
  let ceremonyLines = 0;
  let typeDeclCount = 0;
  let runtimeFunctionCount = 0;
  for (const stmt of programNode.body) {
    const inner =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (
      stmt.type === "ImportDeclaration" ||
      (stmt.type === "ExportNamedDeclaration" && stmt.exportKind === "type")
    ) {
      ceremonyLines += nonBlankLineCount(sourceCode.getText(stmt));
      continue;
    }
    if (
      inner?.type === "TSInterfaceDeclaration" ||
      inner?.type === "TSTypeAliasDeclaration"
    ) {
      typeDeclCount += 1;
      ceremonyLines += nonBlankLineCount(sourceCode.getText(stmt));
      continue;
    }
    if (inner?.type === "FunctionDeclaration") {
      runtimeFunctionCount += 1;
      ceremonyLines += collectFunctionParamTypeLines(stmt, sourceCode);
    }
  }
  if (
    runtimeFunctionCount >= 1 &&
    typeDeclCount >= 1 &&
    ceremonyLines / totalLines > 0.35
  ) {
    context.report({
      node: programNode,
      message:
        "Module spends over 35% of its non-blank lines on import, type, and parameter ceremony; keep coupled helpers in their owning module.",
    });
  }
}

function checkReexports(node, stem, context) {
  if (node.body.length === 0) return;
  const allReexports = node.body.every(
    (stmt) =>
      stmt.type === "ExportAllDeclaration" ||
      (stmt.type === "ExportNamedDeclaration" &&
        stmt.source !== null &&
        stmt.declaration === null)
  );
  if (allReexports) {
    if (node.body.every((stmt) => isOwnSliceReexport(stem, stmt))) {
      return;
    }
    context.report({
      node,
      message:
        "Module only re-exports symbols from other modules; import from the owning module directly.",
    });
    return;
  }
  for (const stmt of node.body) {
    if (
      stmt.type === "ExportNamedDeclaration" &&
      stmt.declaration === null &&
      stmt.exportKind !== "type" &&
      typeof stmt.source?.value === "string" &&
      stmt.source.value.startsWith("./") &&
      !isOwnSliceReexport(stem, stmt) &&
      stmt.specifiers.some((spec) => spec.exportKind !== "type")
    ) {
      context.report({
        node: stmt,
        message:
          "Do not re-export runtime symbols from a relative sibling in a non-index module; import from the owning module directly.",
      });
    }
  }
  checkSplitModuleCeremony(node, context);
}

function checkComponentProps(node, typeDeclarations, context) {
  if (
    !functionReturnsJsx(node) ||
    hasWidgetDirective(node) ||
    node.params.length === 0 ||
    node.params.length > 2
  ) {
    return;
  }
  const max = context.options[0]?.max ?? 7;
  const first = node.params[0];
  let propCount = 0;
  if (first.type === "ObjectPattern") {
    propCount = first.properties.filter(
      (property) => property.type === "Property"
    ).length;
  }
  const annotation = first.typeAnnotation?.typeAnnotation;
  let annotationCount = collectTypePropertyNames(
    annotation,
    typeDeclarations
  ).size;
  if (annotation) {
    const files = resolvedDeclarationFiles(annotation, context.sourceCode);
    if (
      files.length > 0 &&
      files.every((file) => !file.includes("node_modules"))
    ) {
      annotationCount = Math.max(
        annotationCount,
        resolvedOwnedPropertyNames(annotation, context.sourceCode)?.length ?? 0
      );
    }
  }
  const total = Math.max(propCount, annotationCount);
  if (total > max) {
    context.report({
      node: first,
      message: `Component accepts ${total} props (max ${max}); group cohesive props or compose children instead.`,
    });
  }
}

function createComponentPropChecks(context) {
  const typeDeclarations = new Map();
  const check = (node) => checkComponentProps(node, typeDeclarations, context);
  return {
    Program(node) {
      recordProgramTypeDeclarations(node, typeDeclarations);
    },
    FunctionDeclaration: check,
    FunctionExpression: check,
    ArrowFunctionExpression: check,
  };
}

export const reactMaxComponentPropsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow React components with more than 7 props.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          max: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return createComponentPropChecks(context);
  },
};

const NON_BRANCH_CONTAINERS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "TryStatement",
  "SwitchStatement",
]);

function isOnlyConditionalWrite(write, declarationContainer) {
  let sawIf = false;
  for (
    let cur = write.identifier?.parent;
    cur && cur !== declarationContainer;
    cur = cur.parent
  ) {
    if (cur.type === "IfStatement") {
      sawIf = true;
      continue;
    }
    if (isFunctionLike(cur) || NON_BRANCH_CONTAINERS.has(cur.type)) {
      return false;
    }
  }
  return sawIf;
}

export const noMutableLetAliasRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow mutable let bindings that are only assigned across if/else branches.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;
    return {
      VariableDeclaration(node) {
        if (node.kind !== "let") return;
        for (const decl of node.declarations) {
          if (decl.id?.type !== "Identifier" || decl.init !== null) continue;
          const binding = findVariable(sourceCode, decl.id);
          if (!binding) continue;
          const writes = binding.references.filter((reference) =>
            reference.isWrite()
          );
          if (
            writes.length >= 2 &&
            writes.every((write) => isOnlyConditionalWrite(write, node.parent))
          ) {
            context.report({
              node: decl,
              message: `Mutable binding '${decl.id.name}' is only assigned across conditional branches; compute a const expression or return early instead.`,
            });
          }
        }
      },
    };
  },
};

export const noReexportOnlyModuleRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow barrel or shim modules whose only statements are re-exports.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const filename = ruleFilename(context);
    if (
      isDeclaredPackageIndex(filename) ||
      /(?:^|\/)[^/]+\.config\.[cm]?[jt]sx?$/u.test(filename) ||
      /\.(?:ios|android|native|web|electron)\.[cm]?[jt]sx?$/u.test(filename) ||
      /(?:^|\/)app\/.*\.[cm]?[jt]sx?$/u.test(filename)
    ) {
      return {};
    }
    const baseMatch = filename.match(/\/([^/]+)\.[cm]?[jt]sx?$/u);
    const stem = baseMatch ? baseMatch[1] : null;
    if (hasPlatformSibling(filename)) return {};
    return {
      Program(node) {
        checkReexports(node, stem, context);
      },
    };
  },
};
