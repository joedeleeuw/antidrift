import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const codebaseAtlasRepoCandidates = [
  process.env.CODEBASE_ATLAS_REPO,
  "/Users/sushi/code/codebase-atlas",
].filter(Boolean);

const corpusPlans = [
  {
    repo: "codebase-atlas",
    label: "app",
    repoCandidates: codebaseAtlasRepoCandidates,
    tsconfig: "tsconfig.json",
    targets: ["src/**/*.{ts,tsx}", "tools/**/*.ts"],
  },
];

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseArgs(argv) {
  const out = {
    repo: null,
    slice: "schema-roundtrip-inventory",
    output: null,
    targets: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--repo" && next) {
      out.repo = parseCsv(next);
      i += 1;
    } else if (arg === "--slice" && next) {
      out.slice = next;
      i += 1;
    } else if (arg === "--output" && next) {
      out.output = next;
      i += 1;
    } else if ((arg === "--target" || arg === "--targets") && next) {
      out.targets = parseCsv(next);
      i += 1;
    }
  }
  return out;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function selectedPlans(repo) {
  if (!repo) return corpusPlans;
  const requested = new Set(repo);
  return corpusPlans.filter((plan) => requested.has(plan.repo));
}

function readTsconfig(repoRoot, tsconfig) {
  const configPath = resolve(repoRoot, tsconfig);
  const loaded = ts.readConfigFile(configPath, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (loaded.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"),
    );
  }
  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, repoRoot);
}

function isTypeScriptSource(sourceFile) {
  return (
    !sourceFile.isDeclarationFile &&
    /\.(?:tsx?|mts|cts)$/u.test(sourceFile.fileName)
  );
}

function normalizePath(path) {
  return path.replace(/\\/gu, "/");
}

function targetMatches(relativePath, target) {
  const normalizedTarget = normalizePath(target);
  if (normalizedTarget === relativePath) return true;
  if (normalizedTarget.endsWith("/**/*.{ts,tsx}")) {
    const prefix = normalizedTarget.slice(0, -"**/*.{ts,tsx}".length);
    return (
      relativePath.startsWith(prefix) && /\.(?:ts|tsx)$/u.test(relativePath)
    );
  }
  if (normalizedTarget.endsWith("/**/*.ts")) {
    const prefix = normalizedTarget.slice(0, -"**/*.ts".length);
    return relativePath.startsWith(prefix) && /\.ts$/u.test(relativePath);
  }
  if (normalizedTarget.endsWith("/**/*.tsx")) {
    const prefix = normalizedTarget.slice(0, -"**/*.tsx".length);
    return relativePath.startsWith(prefix) && /\.tsx$/u.test(relativePath);
  }
  return false;
}

function sourceMatches(repoRoot, sourceFile, targets) {
  const relativePath = normalizePath(relative(repoRoot, sourceFile.fileName));
  return targets.some((target) => targetMatches(relativePath, target));
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function memberName(node, sourceFile) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.name && ts.isStringLiteralLike(node.name)) return node.name.text;
  return node.name?.getText(sourceFile) ?? "(anonymous)";
}

function containerInfo(node, sourceFile) {
  if (ts.isFunctionDeclaration(node)) {
    return {
      name: node.name?.text ?? "(anonymous)",
      exportBoundary:
        hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
        hasModifier(node, ts.SyntaxKind.DefaultKeyword),
    };
  }
  if (ts.isMethodDeclaration(node)) {
    const classNode = ts.isClassDeclaration(node.parent) ? node.parent : null;
    const className = classNode?.name?.text;
    const classExported = Boolean(
      classNode && hasModifier(classNode, ts.SyntaxKind.ExportKeyword),
    );
    const privateMember =
      hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(node, ts.SyntaxKind.ProtectedKeyword) ||
      node.name?.kind === ts.SyntaxKind.PrivateIdentifier;
    const classPrefix = className ? `${className}.` : "";
    return {
      name: `${classPrefix}${memberName(node, sourceFile)}`,
      exportBoundary: classExported && !privateMember,
    };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      const statement = node.parent.parent?.parent;
      return {
        name: node.parent.name.text,
        exportBoundary:
          ts.isVariableStatement(statement) &&
          hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      };
    }
  }
  return { name: "(anonymous)", exportBoundary: false };
}

function isContainer(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function parseCallInfo(call, sourceFile) {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  if (method !== "parse" && method !== "parseAsync") return null;
  const schemaExpression = call.expression.expression;
  const schemaText = schemaExpression.getText(sourceFile);
  if (!/(?:^|[.])\w+Schema$/u.test(schemaText)) return null;
  const [arg] = call.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  return {
    method,
    schemaName: schemaText.split(".").at(-1) ?? schemaText,
    schemaText,
    objectExpression: arg,
  };
}

function rootPath(expression, sourceFile) {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return rootPath(expression.expression, sourceFile);
  }
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (expression.kind === ts.SyntaxKind.ThisKeyword) {
    return "this";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const root = rootPath(expression.expression, sourceFile);
    return root
      ? `${root}.${expression.name.text}`
      : expression.getText(sourceFile);
  }
  if (ts.isElementAccessExpression(expression)) {
    return rootPath(expression.expression, sourceFile);
  }
  if (ts.isCallExpression(expression)) {
    return rootPath(expression.expression, sourceFile);
  }
  return expression.getText(sourceFile);
}

function isLiteralLike(expression) {
  return (
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression)
  );
}

function propertyValue(property) {
  if (ts.isPropertyAssignment(property)) {
    return property.initializer;
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name;
  }
  return null;
}

function valueDerivesFromOwnedSource(value, ownedRoots, sourceFile) {
  if (isLiteralLike(value)) {
    return true;
  }
  const root = rootPath(value, sourceFile);
  return [...ownedRoots].some(
    (ownedRoot) => root === ownedRoot || root.startsWith(`${ownedRoot}.`),
  );
}

function sameOutputSpreads(checker, call, objectExpression) {
  const signature = checker.getResolvedSignature(call);
  if (!signature) return [];
  const returnType = checker.getReturnTypeOfSignature(signature);
  return objectExpression.properties
    .filter(ts.isSpreadAssignment)
    .map((spread) => {
      const spreadType = checker.getTypeAtLocation(spread.expression);
      const sameOutput =
        checker.isTypeAssignableTo(spreadType, returnType) &&
        checker.isTypeAssignableTo(returnType, spreadType);
      return {
        expression: spread.expression,
        root: rootPath(spread.expression, spread.getSourceFile()),
        sameOutput,
        type: checker.typeToString(spreadType),
      };
    })
    .filter((spread) => spread.sameOutput);
}

function classifyObjectExpression(objectExpression, ownedRoots, sourceFile) {
  const crossSourceProperties = [];
  for (const property of objectExpression.properties) {
    if (ts.isSpreadAssignment(property)) {
      continue;
    }
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }
    const value = propertyValue(property);
    if (!value) {
      continue;
    }
    if (!valueDerivesFromOwnedSource(value, ownedRoots, sourceFile)) {
      crossSourceProperties.push(
        property.name?.getText(sourceFile) ?? property.getText(sourceFile),
      );
    }
  }
  return {
    classification:
      crossSourceProperties.length > 0 ? "cross-source" : "owned-only",
    crossSourceProperties,
  };
}

function candidateKind({ classification, exportBoundary, path }) {
  if (classification === "cross-source") {
    return "cross-source-invariant-checkpoint";
  }
  if (
    path.includes("/test/") ||
    path.endsWith(".test.ts") ||
    path.endsWith(".test.tsx")
  ) {
    return "test-roundtrip";
  }
  if (exportBoundary) {
    return "owner-transition-helper-candidate";
  }
  return "internal-owned-roundtrip";
}

function buildFinding({
  repoRoot,
  sourceFile,
  checker,
  node,
  info,
  container,
}) {
  const ownedSpreads = sameOutputSpreads(checker, node, info.objectExpression);
  if (ownedSpreads.length === 0) {
    return null;
  }

  const ownedRoots = new Set(ownedSpreads.map((spread) => spread.root));
  const classification = classifyObjectExpression(
    info.objectExpression,
    ownedRoots,
    sourceFile,
  );
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const path = normalizePath(relative(repoRoot, sourceFile.fileName));
  const roundtripKind = candidateKind({
    classification: classification.classification,
    exportBoundary: container.exportBoundary,
    path,
  });
  const reasons = ["object-spread-same-output"];
  if (classification.crossSourceProperties.length > 0) {
    reasons.push("override-from-cross-source");
  }
  if (container.exportBoundary) {
    reasons.push("export-boundary");
  }
  if (roundtripKind === "owner-transition-helper-candidate") {
    reasons.push("owner-transition-helper-candidate");
  }

  return {
    path,
    line: position.line + 1,
    column: position.character + 1,
    schemaName: info.schemaName,
    schemaText: info.schemaText,
    method: info.method,
    enclosing: container.name,
    classification: classification.classification,
    candidateKind: roundtripKind,
    exportBoundary: container.exportBoundary,
    sameOutputSpreads: ownedSpreads.map((spread) => ({
      root: spread.root,
      type: spread.type,
    })),
    crossSourceProperties: classification.crossSourceProperties,
    reasons,
  };
}

function collectFindings(repoRoot, sourceFile, checker) {
  const findings = [];
  const containerStack = [];

  function visit(node) {
    if (isContainer(node)) {
      containerStack.push(containerInfo(node, sourceFile));
      ts.forEachChild(node, visit);
      containerStack.pop();
      return;
    }

    if (ts.isCallExpression(node)) {
      const info = parseCallInfo(node, sourceFile);
      if (info) {
        const finding = buildFinding({
          repoRoot,
          sourceFile,
          checker,
          node,
          info,
          container: containerStack.at(-1) ?? {
            name: "(top-level)",
            exportBoundary: false,
          },
        });
        if (finding) {
          findings.push(finding);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function runPlan(plan, options) {
  const repoRoot = firstExisting(plan.repoCandidates);
  if (!repoRoot) {
    return {
      repo: plan.repo,
      label: plan.label,
      decision: "skip",
      reason: `No repository found for ${plan.repo}.`,
    };
  }

  const parsed = readTsconfig(repoRoot, plan.tsconfig);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const checker = program.getTypeChecker();
  const targets = options.targets ?? plan.targets;
  const sourceFiles = program
    .getSourceFiles()
    .filter(isTypeScriptSource)
    .filter((sourceFile) =>
      normalizePath(sourceFile.fileName).startsWith(normalizePath(repoRoot)),
    )
    .filter((sourceFile) => sourceMatches(repoRoot, sourceFile, targets));
  const findings = sourceFiles.flatMap((sourceFile) =>
    collectFindings(repoRoot, sourceFile, checker),
  );

  return {
    repo: plan.repo,
    label: plan.label,
    decision: "pass",
    repoRoot,
    tsconfig: plan.tsconfig,
    targets,
    checkedFiles: sourceFiles.length,
    findings,
    summary: {
      total: findings.length,
      byClassification: Object.fromEntries(
        ["owned-only", "cross-source"].map((classification) => [
          classification,
          findings.filter(
            (finding) => finding.classification === classification,
          ).length,
        ]),
      ),
      byCandidateKind: countByCandidateKind(findings),
      exportBoundaries: findings.filter((finding) => finding.exportBoundary)
        .length,
    },
  };
}

function countByCandidateKind(findings) {
  const kinds = [
    "owner-transition-helper-candidate",
    "cross-source-invariant-checkpoint",
    "internal-owned-roundtrip",
    "test-roundtrip",
  ];
  return Object.fromEntries(
    kinds.map((kind) => [
      kind,
      findings.filter((finding) => finding.candidateKind === kind).length,
    ]),
  );
}

function summarize(results, slice) {
  const findings = results.flatMap((result) => result.findings ?? []);
  return {
    schemaVersion: 1,
    slice,
    decision: results.some((result) => result.decision === "pass")
      ? "pass"
      : "skip",
    checkedFiles: results.reduce(
      (sum, result) => sum + (result.checkedFiles ?? 0),
      0,
    ),
    findings: {
      total: findings.length,
      byClassification: Object.fromEntries(
        ["owned-only", "cross-source"].map((classification) => [
          classification,
          findings.filter(
            (finding) => finding.classification === classification,
          ).length,
        ]),
      ),
      byCandidateKind: countByCandidateKind(findings),
      exportBoundaries: findings.filter((finding) => finding.exportBoundary)
        .length,
    },
    results,
  };
}

function emit(summary, output, report) {
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    writeFileSync(resolve(output), json, "utf8");
  } else {
    report(json.trimEnd());
  }
}

export function schemaRoundtripInventory(options = {}) {
  const report = options.report ?? console.log;
  const results = selectedPlans(options.repo).map((plan) =>
    runPlan(plan, options),
  );
  const summary = summarize(
    results,
    options.slice ?? "schema-roundtrip-inventory",
  );
  emit(summary, options.output, report);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  schemaRoundtripInventory(parseArgs(process.argv.slice(2)));
}
