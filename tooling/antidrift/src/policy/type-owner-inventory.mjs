import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  classifyStructuralRelation,
  sortedStructuralCandidates,
  structuralDerivationUtilities,
} from "../eslint-plugin/rules/structural-fork-proof.js";
import { loadRegistriesSync } from "./lib/registries.mjs";
import {
  collectCanonicalTypes,
  collectConvexGeneratedCanonicalTypes,
  collectGeneratedCanonicalTypes,
  isConvexGeneratedFile,
  isObjectType,
  resolvesToGeneratedType,
  resolvesToInstalledType,
  typePropsDetailed,
} from "./lib/type-index.mjs";

const DEFAULT_OUTPUT = "reports/type-owner-inventory.json";

const selfRepoCandidates = [
  process.env.ANTIDRIFT_REPO,
  process.env.AGENT_GUARDRAILS_REPO,
  process.cwd(),
].filter(Boolean);
const murderboxRepoCandidates = [
  process.env.MURDERBOX_REPO,
  "/Users/sushi/code/murderbox",
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
    repo: "murderbox",
    label: "client",
    repoCandidates: murderboxRepoCandidates,
    tsconfig: "apps/client/tsconfig.json",
    targets: ["apps/client/src/**/*.ts", "apps/client/src/**/*.tsx"],
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

export function parseTypeOwnerInventoryArgs(argv) {
  const out = {
    repo: null,
    slice: "type-owner-inventory",
    output: DEFAULT_OUTPUT,
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

const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function resolvedSymbol(checker, symbol) {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function declaresInConvexOwnedModule(sym) {
  for (const declaration of sym?.getDeclarations?.() ?? sym?.declarations ?? []) {
    const file = normalizePath(declaration.getSourceFile().fileName);
    if (
      file.includes("/convex/_generated/") ||
      file.includes("/node_modules/convex/")
    ) {
      return true;
    }
  }
  return false;
}

// `type Row = Doc<"machines">` / `type Result = FunctionReturnType<typeof api.*>`
// reference the Convex owner through its declared symbol; they are derivations, not
// hand-restated shapes, so they never enter classification.
function isConvexOwnerReferenceAlias(checker, node) {
  if (!ts.isTypeAliasDeclaration(node)) return false;
  const annotation = node.type;
  if (!ts.isTypeReferenceNode(annotation)) return false;
  const sym = resolvedSymbol(
    checker,
    checker.getSymbolAtLocation(annotation.typeName),
  );
  return declaresInConvexOwnedModule(sym);
}

function typeReferenceName(typeNode) {
  const name = typeNode?.typeName;
  if (!name) return "";
  return ts.isIdentifier(name) ? name.text : (name.right?.text ?? "");
}

function isStructuralDerivationAlias(node) {
  if (!ts.isTypeAliasDeclaration(node)) return false;
  const annotation = node.type;
  if (ts.isTupleTypeNode(annotation)) return true;
  if (!ts.isTypeReferenceNode(annotation)) return false;
  if (!structuralDerivationUtilities.has(typeReferenceName(annotation))) {
    return false;
  }
  const [source] = annotation.typeArguments ?? [];
  return Boolean(
    source && (ts.isTypeReferenceNode(source) || ts.isImportTypeNode(source)),
  );
}

function localShapeMembers(node) {
  if (ts.isTypeAliasDeclaration(node)) {
    return ts.isTypeLiteralNode(node.type) ? [...node.type.members] : [];
  }
  return [...node.members];
}

// An all-optional shape loosely matches every owner that carries those properties,
// so it classifies as noise against the whole candidate set; the enforcement rule
// skips these for the same reason.
function isAllOptionalLocalShape(node) {
  const props = localShapeMembers(node).filter((member) =>
    ts.isPropertySignature(member),
  );
  return props.length > 0 && props.every((prop) => Boolean(prop.questionToken));
}

function declarationSymbol(checker, node) {
  return node.name ? checker.getSymbolAtLocation(node.name) : null;
}

function declaredType(checker, node) {
  const symbol = declarationSymbol(checker, node);
  if (!symbol) return null;
  try {
    return checker.getDeclaredTypeOfSymbol(symbol);
  } catch {
    return null;
  }
}

function collectLocalTypes(repoRoot, program, checker, targets, generatedSources) {
  const locals = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!isTypeScriptSource(sourceFile)) continue;
    if (isConvexGeneratedFile(sourceFile.fileName)) continue;
    if (!sourceMatches(repoRoot, sourceFile, targets)) continue;
    const file = normalizePath(relative(repoRoot, sourceFile.fileName));
    const test = TEST_FILE_PATTERN.test(file);
    function visit(node) {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        if (
          node.name &&
          !isConvexOwnerReferenceAlias(checker, node) &&
          !isStructuralDerivationAlias(node) &&
          !isAllOptionalLocalShape(node)
        ) {
          const declared = declaredType(checker, node);
          if (
            declared &&
            isObjectType(declared) &&
            !resolvesToInstalledType(declared) &&
            !resolvesToGeneratedType(declared, generatedSources)
          ) {
            const detailedProps = typePropsDetailed(checker, declared);
            if (detailedProps.size > 0) {
              const position = sourceFile.getLineAndCharacterOfPosition(
                node.name.getStart(sourceFile),
              );
              locals.push({
                file,
                line: position.line + 1,
                localName: node.name.text,
                test,
                detailedProps,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return locals.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.localName.localeCompare(right.localName),
  );
}

const relationRank = {
  "exact-owner-copy": 0,
  "loosened-owner-copy": 1,
  "partial-owner-copy": 2,
};

function strongestRelation(localDetailed, candidates) {
  let best = null;
  for (const candidate of sortedStructuralCandidates(candidates)) {
    if (!candidate.detailedProps) continue;
    const relation = classifyStructuralRelation(
      localDetailed,
      candidate.detailedProps,
    );
    if (!relation) continue;
    if (best && relationRank[relation] >= relationRank[best.relation]) {
      continue;
    }
    best = { candidate, relation };
    if (relation === "exact-owner-copy") break;
  }
  return best;
}

function countRelations(rows) {
  const counts = {
    "exact-owner-copy": 0,
    "loosened-owner-copy": 0,
    "partial-owner-copy": 0,
  };
  for (const row of rows) {
    counts[row.relation] = (counts[row.relation] ?? 0) + 1;
  }
  return counts;
}

function parseOwnerLabel(label) {
  const hash = label.indexOf("#");
  if (hash === -1) return null;
  return { package: label.slice(0, hash), exportName: label.slice(hash + 1) };
}

// Proposal candidates are exactly the proposal-state owners: installed-package crawls
// are the only candidates collected below authorityState "accepted", so accepted
// owners (Convex generated, registry generated sources) stay row-only and never
// propose a registry entry they do not need.
function collectProposalSites(rows) {
  const sites = new Map();
  for (const row of rows) {
    if (row.relation !== "exact-owner-copy") continue;
    if (row.authorityState !== "proposal") continue;
    const owner = parseOwnerLabel(row.owner);
    if (!owner) continue;
    const entry = sites.get(row.owner) ?? { ...owner, sites: [] };
    entry.sites.push(`${row.file}:${row.line}`);
    sites.set(row.owner, entry);
  }
  return sites;
}

function finalizeProposals(sites) {
  const usedNames = new Set();
  return [...sites.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, entry]) => {
      let name = entry.exportName;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${entry.exportName}${suffix}`;
        suffix += 1;
      }
      usedNames.add(name);
      const [first, ...rest] = entry.sites;
      return {
        name,
        package: entry.package,
        exportName: entry.exportName,
        reason: `exact-owner-copy of ${label} redeclared at ${first}${rest.length > 0 ? ` and ${rest.length} more` : ""}`,
      };
    });
}

function ownerCandidates(program, checker, repoRoot) {
  const generatedSources =
    loadRegistriesSync(resolve(repoRoot, "policy")).generated
      ?.generatedSources ?? {};
  const candidates = [
    ...collectCanonicalTypes(program, checker),
    ...collectConvexGeneratedCanonicalTypes(program, checker),
    ...collectGeneratedCanonicalTypes(program, checker, generatedSources),
  ];
  return { generatedSources, candidates };
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
  const { generatedSources, candidates } = ownerCandidates(
    program,
    checker,
    repoRoot,
  );
  const checkedFiles = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        isTypeScriptSource(sourceFile) &&
        sourceMatches(repoRoot, sourceFile, targets),
    ).length;
  const locals = collectLocalTypes(
    repoRoot,
    program,
    checker,
    targets,
    generatedSources,
  );
  const rows = [];
  for (const local of locals) {
    const best = strongestRelation(local.detailedProps, candidates);
    if (!best) continue;
    rows.push({
      file: local.file,
      line: local.line,
      localName: local.localName,
      relation: best.relation,
      owner: best.candidate.label,
      authorityState: best.candidate.authorityState ?? "proposal",
      propCount: local.detailedProps.size,
      test: local.test,
    });
  }
  return {
    repo: plan.repo,
    label: plan.label,
    decision: "pass",
    repoRoot,
    tsconfig: plan.tsconfig,
    targets,
    checkedFiles,
    candidateCount: candidates.length,
    scannedTypeCount: locals.length,
    matchCount: rows.length,
    relationCounts: countRelations(rows),
    rows,
  };
}

function summarize({ results, slice }) {
  const passed = results.filter((result) => result.decision === "pass");
  const rows = passed.flatMap((result) => result.rows);
  const relationCounts = countRelations(rows);
  const proposals = finalizeProposals(collectProposalSites(rows));
  return {
    schemaVersion: 1,
    slice,
    decision: passed.length > 0 ? "pass" : "skip",
    checkedFiles: passed.reduce((sum, result) => sum + result.checkedFiles, 0),
    scannedTypeCount: passed.reduce(
      (sum, result) => sum + result.scannedTypeCount,
      0,
    ),
    matchCount: rows.length,
    relationCounts,
    proposalCount: proposals.length,
    proposals,
    rows,
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

export function typeOwnerInventory({
  repo = null,
  slice = "type-owner-inventory",
  output = DEFAULT_OUTPUT,
  targets = null,
  plans = corpusPlans,
  progress = console.error,
  report = console.log,
} = {}) {
  const results = selectedPlans(repo, plans).map((plan) => {
    progress(`[type-owner-inventory] scanning ${plan.repo}/${plan.label}`);
    const result = runPlan(plan, targets);
    if (result.decision === "pass") {
      const counts = result.relationCounts;
      progress(
        `[type-owner-inventory] ${plan.repo}/${plan.label}: ${result.candidateCount} candidates, ${result.scannedTypeCount} local types, ${result.matchCount} matches (exact ${counts["exact-owner-copy"]}, loosened ${counts["loosened-owner-copy"]}, partial ${counts["partial-owner-copy"]})`,
      );
    } else {
      progress(`[type-owner-inventory] ${plan.repo}/${plan.label}: ${result.reason}`);
    }
    return result;
  });
  const summary = summarize({ results, slice });
  emit(summary, output, report);
  const counts = summary.relationCounts;
  progress(
    `[type-owner-inventory] total: ${summary.checkedFiles} files, ${summary.scannedTypeCount} local types, ${summary.matchCount} matches (exact ${counts["exact-owner-copy"]}, loosened ${counts["loosened-owner-copy"]}, partial ${counts["partial-owner-copy"]}), ${summary.proposalCount} ownership proposals`,
  );
  return Promise.resolve(summary);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await typeOwnerInventory(parseTypeOwnerInventoryArgs(process.argv.slice(2)));
}
