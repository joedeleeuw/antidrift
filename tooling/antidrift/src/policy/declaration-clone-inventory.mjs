import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { MIN_PROPS, isObjectType } from "./lib/type-index.mjs";

const selfRepoCandidates = [
  process.env.ANTIDRIFT_REPO,
  process.env.AGENT_GUARDRAILS_REPO,
  process.cwd(),
].filter(Boolean);
const chaskiRepoCandidates = [
  process.env.CHASKI_REPO,
  "/Users/sushi/code/chaski",
].filter(Boolean);
const codebaseAtlasRepoCandidates = [
  process.env.CODEBASE_ATLAS_REPO,
  "/Users/sushi/code/codebase-atlas",
].filter(Boolean);
const sudocodeRepoCandidates = [
  process.env.SUDOCODE_REPO,
  "/Users/sushi/code/sudocode-main",
].filter(Boolean);
const opencodeRepoCandidates = [
  process.env.OPENCODE_REPO,
  "/Users/sushi/code/opencode",
].filter(Boolean);

const corpusPlans = [
  {
    repo: "agent-guardrails-monorepo-template",
    label: "domain",
    repoCandidates: selfRepoCandidates,
    tsconfig: "packages/domain/tsconfig.json",
    targets: ["packages/domain/src/**/*.ts"],
  },
  {
    repo: "agent-guardrails-monorepo-template",
    label: "contracts",
    repoCandidates: selfRepoCandidates,
    tsconfig: "packages/contracts/tsconfig.json",
    targets: ["packages/contracts/src/**/*.ts"],
  },
  {
    repo: "agent-guardrails-monorepo-template",
    label: "ui",
    repoCandidates: selfRepoCandidates,
    tsconfig: "packages/ui/tsconfig.json",
    targets: ["packages/ui/src/**/*.{ts,tsx}"],
  },
  {
    repo: "agent-guardrails-monorepo-template",
    label: "gateways",
    repoCandidates: selfRepoCandidates,
    tsconfig: "packages/gateways/tsconfig.json",
    targets: ["packages/gateways/src/**/*.ts"],
  },
  {
    repo: "agent-guardrails-monorepo-template",
    label: "api",
    repoCandidates: selfRepoCandidates,
    tsconfig: "packages/api/tsconfig.json",
    targets: ["packages/api/src/**/*.ts"],
  },
  {
    repo: "agent-guardrails-monorepo-template",
    label: "web",
    repoCandidates: selfRepoCandidates,
    tsconfig: "apps/web/tsconfig.json",
    targets: ["apps/web/src/**/*.{ts,tsx}", "apps/web/app/**/*.{ts,tsx}"],
  },
  {
    repo: "agent-guardrails-monorepo-template",
    label: "antidrift",
    repoCandidates: selfRepoCandidates,
    tsconfig: "tooling/antidrift/tsconfig.json",
    targets: ["tooling/antidrift/src/**/*.{ts,tsx,mts,cts}"],
  },
  {
    repo: "chaski",
    label: "bff",
    defaultEnabled: false,
    repoCandidates: chaskiRepoCandidates,
    tsconfig: "src/frontend/bff/tsconfig.json",
    targets: ["src/frontend/bff/**/*.ts"],
  },
  {
    repo: "chaski",
    label: "monolithui",
    defaultEnabled: false,
    repoCandidates: chaskiRepoCandidates,
    tsconfig: "src/frontend/monolithui/tsconfig.json",
    targets: ["src/frontend/monolithui/src/**/*.{ts,tsx}"],
  },
  {
    repo: "codebase-atlas",
    label: "app",
    defaultEnabled: false,
    repoCandidates: codebaseAtlasRepoCandidates,
    tsconfig: "tsconfig.json",
    targets: ["src/**/*.{ts,tsx}", "tools/**/*.ts"],
  },
  {
    repo: "sudocode-main",
    label: "cli",
    defaultEnabled: false,
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "cli/tsconfig.json",
    targets: ["cli/src/**/*.ts"],
  },
  {
    repo: "sudocode-main",
    label: "frontend",
    defaultEnabled: false,
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "frontend/tsconfig.json",
    targets: ["frontend/src/**/*.{ts,tsx}"],
  },
  {
    repo: "sudocode-main",
    label: "server",
    defaultEnabled: false,
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "server/tsconfig.json",
    targets: ["server/src/**/*.ts"],
  },
  {
    repo: "opencode",
    label: "ui",
    defaultEnabled: false,
    repoCandidates: opencodeRepoCandidates,
    tsconfig: "packages/ui/tsconfig.json",
    targets: ["packages/ui/src/**/*.{ts,tsx}"],
  },
];

function parseCsv(value) {
  const items = [];
  let current = "";
  let braceDepth = 0;
  for (const character of value) {
    if (character === "{") {
      braceDepth += 1;
    } else if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
    }
    if (character === "," && braceDepth === 0) {
      items.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

export function parseArgs(argv) {
  const out = {
    repo: null,
    slice: "declaration-clone-inventory",
    output: null,
    targets: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--repo" && next) {
      out.repo = parseCsv(next);
      index += 1;
    } else if (arg === "--slice" && next) {
      out.slice = next;
      index += 1;
    } else if (arg === "--output" && next) {
      out.output = next;
      index += 1;
    } else if ((arg === "--target" || arg === "--targets") && next) {
      out.targets = parseCsv(next);
      index += 1;
    }
  }
  return out;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function selectedPlans(repo, plans) {
  if (!repo) return plans.filter((plan) => plan.defaultEnabled !== false);
  const requested = new Set(repo);
  return plans.filter((plan) => requested.has(plan.repo));
}

function normalizePath(path) {
  return path.replace(/\\/gu, "/");
}

function sourceKind(path) {
  return /(^|\/)(?:gen|generated|__generated__)(?:\/|$)|\.generated\./u.test(
    path,
  )
    ? "generated"
    : "source";
}

function expandBraces(patterns) {
  const expanded = [];
  for (const pattern of patterns) {
    const match = /\{([^{}]+)\}/u.exec(pattern);
    if (!match) {
      expanded.push(pattern);
      continue;
    }
    const prefix = pattern.slice(0, match.index);
    const suffix = pattern.slice(match.index + match[0].length);
    expanded.push(
      ...expandBraces(
        match[1].split(",").map((part) => `${prefix}${part}${suffix}`),
      ),
    );
  }
  return expanded;
}

function escapeSegment(segment) {
  return segment
    .replace(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
    .replace(/\*/gu, "[^/]*");
}

function globRegex(pattern) {
  const segments = normalizePath(pattern).split("/");
  let source = "^";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "**") {
      source += "(?:[^/]+/)*";
      continue;
    }
    source += escapeSegment(segment);
    if (index < segments.length - 1) {
      source += "/";
    }
  }
  source += "$";
  return new RegExp(source, "u");
}

function targetMatchers(targets) {
  return expandBraces(targets).map((target) => globRegex(target));
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
  return ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
}

function isTypeScriptSource(sourceFile) {
  return (
    !sourceFile.isDeclarationFile &&
    /\.(?:tsx?|mts|cts)$/u.test(sourceFile.fileName)
  );
}

function sourceMatches(repoRoot, sourceFile, targets) {
  const relativePath = normalizePath(relative(repoRoot, sourceFile.fileName));
  if (relativePath.startsWith("../")) return false;
  return targetMatchers(targets).some((matcher) => matcher.test(relativePath));
}

function declarationInfo(node) {
  if (ts.isInterfaceDeclaration(node)) {
    return { kind: "interface", name: node.name.text };
  }
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    return { kind: "type", name: node.name.text };
  }
  return null;
}

function declarationType(checker, node) {
  const symbol = checker.getSymbolAtLocation(node.name);
  if (!symbol) return null;
  try {
    return checker.getDeclaredTypeOfSymbol(symbol);
  } catch {
    return null;
  }
}

function declarationMemberContainer(node) {
  return ts.isTypeAliasDeclaration(node) ? node.type : node;
}

function propertyDeclaration(symbol, container) {
  return (symbol.getDeclarations?.() ?? symbol.declarations ?? []).find(
    (declaration) =>
      declaration.parent === container &&
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isMethodSignature(declaration) ||
        ts.isMethodDeclaration(declaration)),
  );
}

function isReadonlyProperty(declaration) {
  return Boolean(
    declaration?.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ),
  );
}

function propertyShape(checker, symbol, container) {
  const declaration = propertyDeclaration(symbol, container);
  if (!declaration) return null;
  const sourceNode = declaration ?? symbol.valueDeclaration;
  const type = sourceNode
    ? checker.getTypeOfSymbolAtLocation(symbol, sourceNode)
    : checker.getTypeOfSymbol(symbol);
  const typeText = checker.typeToString(type);
  return {
    name: symbol.name,
    type: typeText,
    optional:
      Boolean(symbol.flags & ts.SymbolFlags.Optional) ||
      Boolean(declaration?.questionToken),
    readonly: isReadonlyProperty(declaration),
  };
}

function declarationProperties(checker, type, node) {
  const container = declarationMemberContainer(node);
  return checker
    .getPropertiesOfType(type)
    .map((symbol) => propertyShape(checker, symbol, container))
    .filter(Boolean)
    .sort((left, right) =>
      left.name.localeCompare(right.name) || left.type.localeCompare(right.type),
    );
}

function fingerprint(properties) {
  return createHash("sha256")
    .update(JSON.stringify(properties))
    .digest("hex");
}

function location(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.name.getStart(sourceFile),
  );
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

function declarationFor(repoRoot, plan, sourceFile, checker, node) {
  const info = declarationInfo(node);
  if (!info) return null;
  const declared = declarationType(checker, node);
  if (!isObjectType(declared)) return null;
  const properties = declarationProperties(checker, declared, node);
  if (properties.length < MIN_PROPS) return null;
  const path = normalizePath(relative(repoRoot, sourceFile.fileName));
  return {
    ...info,
    repo: plan.repo,
    label: plan.label,
    tsconfig: plan.tsconfig,
    path,
    sourceKind: sourceKind(path),
    ...location(sourceFile, node),
    propCount: properties.length,
    fingerprint: fingerprint(properties),
    properties,
  };
}

function collectDeclarations(repoRoot, plan, program, checker, targets) {
  const declarations = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!isTypeScriptSource(sourceFile)) continue;
    if (!sourceMatches(repoRoot, sourceFile, targets)) continue;
    function visit(node) {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        const declaration = declarationFor(
          repoRoot,
          plan,
          sourceFile,
          checker,
          node,
        );
        if (declaration) declarations.push(declaration);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return declarations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.name.localeCompare(right.name),
  );
}

function groupDeclarations(declarations) {
  const byFingerprint = new Map();
  for (const declaration of declarations) {
    const group = byFingerprint.get(declaration.fingerprint) ?? [];
    group.push(declaration);
    byFingerprint.set(declaration.fingerprint, group);
  }
  return [...byFingerprint.entries()]
    .map(([groupFingerprint, entries]) => {
      const sorted = entries.sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.line - right.line ||
          left.column - right.column ||
          left.name.localeCompare(right.name),
      );
      const paths = new Set(sorted.map((entry) => entry.path));
      const sourceKinds = [
        ...new Set(sorted.map((entry) => entry.sourceKind)),
      ].sort((left, right) => left.localeCompare(right));
      const generatedDeclarationCount = sorted.filter(
        (entry) => entry.sourceKind === "generated",
      ).length;
      const [first] = sorted;
      return {
        fingerprint: groupFingerprint,
        fingerprintFields: ["name", "type", "optional", "readonly"],
        propCount: first.propCount,
        properties: first.properties,
        crossFile: paths.size > 1,
        sourceKinds,
        generatedOnly: generatedDeclarationCount === sorted.length,
        mixedGenerated:
          generatedDeclarationCount > 0 &&
          generatedDeclarationCount < sorted.length,
        generatedDeclarationCount,
        declarations: sorted.map(({ properties: _properties, ...entry }) => entry),
      };
    })
    .filter((group) => group.declarations.length >= 2)
    .sort(
      (left, right) =>
        Number(right.crossFile) - Number(left.crossFile) ||
        right.declarations.length - left.declarations.length ||
        left.declarations[0].path.localeCompare(right.declarations[0].path) ||
        left.fingerprint.localeCompare(right.fingerprint),
    );
}

function globalDeclarations(results) {
  const seen = new Set();
  const declarations = [];
  for (const result of results) {
    for (const declaration of result.declarations ?? []) {
      const key = [
        declaration.repo,
        declaration.path,
        declaration.line,
        declaration.column,
        declaration.name,
      ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      declarations.push(declaration);
    }
  }
  return declarations;
}

function cloneGroupSourceKindCounts(groups) {
  return {
    generatedOnly: groups.filter((group) => group.generatedOnly).length,
    mixedGenerated: groups.filter((group) => group.mixedGenerated).length,
    sourceOnly: groups.filter(
      (group) => !group.generatedOnly && !group.mixedGenerated,
    ).length,
  };
}

function diagnosticSummary(repoRoot, diagnostics) {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category],
    path: diagnostic.file
      ? normalizePath(relative(repoRoot, diagnostic.file.fileName))
      : undefined,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

function runPlan(plan, targetsOverride) {
  const repoRoot = firstExisting(plan.repoCandidates);
  if (!repoRoot) {
    return {
      repo: plan.repo,
      label: plan.label,
      decision: "skip",
      reason: `No repository found for ${plan.repo}.`,
    };
  }

  const targets = targetsOverride ?? plan.targets;
  const parsed = readTsconfig(repoRoot, plan.tsconfig);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const checker = program.getTypeChecker();
  const matchedSourceFiles = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        isTypeScriptSource(sourceFile) &&
        sourceMatches(repoRoot, sourceFile, targets),
    );
  const declarations = collectDeclarations(
    repoRoot,
    plan,
    program,
    checker,
    targets,
  );
  const cloneGroups = groupDeclarations(declarations);
  const parserDiagnostics = matchedSourceFiles.flatMap((sourceFile) =>
    program.getSyntacticDiagnostics(sourceFile),
  );
  const result = {
    repo: plan.repo,
    label: plan.label,
    decision: "pass",
    repoRoot,
    tsconfig: plan.tsconfig,
    targets,
    checkedFiles: matchedSourceFiles.length,
    declarationCount: declarations.length,
    cloneGroupCount: cloneGroups.length,
    cloneGroupSourceKindCounts: cloneGroupSourceKindCounts(cloneGroups),
    cloneDeclarationCount: cloneGroups.reduce(
      (sum, group) => sum + group.declarations.length,
      0,
    ),
    parserErrors: parserDiagnostics.length,
    parserErrorFindings: diagnosticSummary(repoRoot, parserDiagnostics).slice(
      0,
      20,
    ),
    declarations,
    cloneGroups,
  };
  return result;
}

function summarize({ results, slice }) {
  const passed = results.filter((result) => result.decision === "pass");
  const cloneGroups = groupDeclarations(globalDeclarations(passed));
  return {
    schemaVersion: 1,
    slice,
    decision: passed.length > 0 ? "pass" : "skip",
    minimumProperties: MIN_PROPS,
    checkedFiles: passed.reduce((sum, result) => sum + result.checkedFiles, 0),
    declarationCount: passed.reduce(
      (sum, result) => sum + result.declarationCount,
      0,
    ),
    cloneGroupCount: cloneGroups.length,
    cloneGroupSourceKindCounts: cloneGroupSourceKindCounts(cloneGroups),
    cloneDeclarationCount: cloneGroups.reduce(
      (sum, group) => sum + group.declarations.length,
      0,
    ),
    parserErrors: passed.reduce((sum, result) => sum + result.parserErrors, 0),
    cloneGroups,
    results,
  };
}

function emit(summary, output, report) {
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    const target = resolve(output);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, json, "utf8");
  } else {
    report(json.trimEnd());
  }
}

export function declarationCloneInventory({
  repo = null,
  slice = "declaration-clone-inventory",
  output = null,
  targets = null,
  plans = corpusPlans,
  progress = console.error,
  report = console.log,
} = {}) {
  const results = selectedPlans(repo, plans).map((plan) => {
    progress(`[declaration-clone-inventory] scanning ${plan.repo}/${plan.label}`);
    const result = runPlan(plan, targets);
    progress(
      `[declaration-clone-inventory] ${plan.repo}/${plan.label}: ${result.checkedFiles ?? 0} files, ${result.declarationCount ?? 0} declarations, ${result.cloneGroupCount ?? 0} clone groups, ${result.parserErrors ?? 0} parser errors`,
    );
    return result;
  });
  const summary = summarize({ results, slice });
  emit(summary, output, report);
  return Promise.resolve(summary);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await declarationCloneInventory(parseArgs(process.argv.slice(2)));
}
