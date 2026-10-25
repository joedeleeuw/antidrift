import ts from "typescript";
import type { Rule } from "eslint";

import {
  emitSemanticFact,
  semanticFactSink,
} from "../../../policy/lib/semantic-facts.mjs";
import { collectOwnedContractProvenance } from "../../../semantic-adapters/projection/owned-contract-provenance.ts";
import { ownerTypeForProof } from "../../../semantic-adapters/projection/owner-projection-proof.ts";
import type { ProjectionProof } from "../../../semantic-adapters/projection/owner-projection-proof.ts";
import { packageDirectory } from "../../../semantic-adapters/provenance/declared-dependencies.ts";
import { isSymbolPubliclyExported } from "../../../semantic-adapters/provenance/symbol-provenance.ts";
import type { TypeScriptRuleEnvironment } from "../../../semantic-adapters/kernel/rule-kernel.ts";
import {
  isAllOptionalObjectShape,
  isStructuralDerivationAlias,
  structuralMatchFact,
} from "../../../semantic-adapters/shape/structural-fork-proof.ts";
import type {
  findStructuralProofs,
  LocalStructuralType,
} from "../../../semantic-adapters/shape/structural-fork-proof.ts";
import { createPackageOwnerIndex } from "../../../semantic-adapters/type-owner/owner-index.ts";
import type { OwnerScope } from "../../../semantic-adapters/type-owner/owner-scope.ts";
import type { Coverage } from "../../../semantic-adapters/type-owner/discovery-coverage.ts";
import { mergeCoverage } from "../../../semantic-adapters/type-owner/discovery-coverage.ts";
import type { IndexedCandidate } from "../../../semantic-adapters/type-owner/package-entry.ts";
import { arbitrateOwnership } from "../../../semantic-adapters/type-owner/ownership-verdict.ts";
import {
  isConvexGeneratedFile,
  isObjectType,
  resolvesToDomainCanonicalType,
  resolvesToGeneratedType,
  resolvesToInstalledType,
  typeProps,
  typePropsDetailed,
} from "../../../semantic-adapters/type-owner.mjs";
import { createFieldBlockVisitors } from "./field-block-analysis.js";
import { inlineBoundaryVisitors } from "./inline-boundary-analysis.js";
import { localReturnVisitors } from "./local-return-proof.js";
import { scopedProvenanceCandidates } from "./ownership-scope.ts";
import { isConvexOwnerReferenceAlias } from "./convex-owner.ts";
import { relevantFilePaths } from "../../../semantic-adapters/provenance/module-imports.ts";
import { contractFieldTypes } from "../../../semantic-adapters/projection/relevant-contracts.ts";

type InlineReport = Rule.ReportDescriptor;
type DeclarationCheck = {
  readonly node: Rule.Node;
  readonly tsNode: ts.Node;
  readonly sourceNode: ts.Node;
  readonly symbol: ts.Symbol;
  readonly local: LocalStructuralType;
  readonly checker: ts.TypeChecker;
  readonly coverage: Coverage;
  readonly matches: ReturnType<
    ReturnType<typeof createPackageOwnerIndex>["exactShapeCandidates"]
  >["matches"];
};
type ProjectionNode = {
  readonly node: Rule.Node;
  readonly tsNode: ts.Node;
};
type StructuralProof =
  | ReturnType<typeof findStructuralProofs>[number]["proof"]
  | ProjectionProof;
type OwnerOptions = Parameters<typeof createPackageOwnerIndex>[0];

export class StructuralRuleSession {
  private readonly context: TypeScriptRuleEnvironment["context"];
  private readonly services: TypeScriptRuleEnvironment["services"];
  private readonly filename: string;
  private readonly scope: OwnerScope;
  private readonly sourceFile: ts.SourceFile;
  private readonly packageRoot: string;
  private readonly mode: ts.ResolutionMode | undefined;
  private readonly packageEntries: readonly IndexedCandidate[];
  private readonly filePaths: readonly string[];
  private readonly declarationChecks: DeclarationCheck[] = [];
  private readonly projectionNodes: ProjectionNode[] = [];
  private readonly inlineNodes: Rule.Node[] = [];
  private readonly reported = new Set<unknown>();
  private readonly fieldBlockVisitors: ReturnType<
    typeof createFieldBlockVisitors
  >;
  private readonly inlineVisitors: ReturnType<typeof inlineBoundaryVisitors>;
  private readonly localVisitors: ReturnType<typeof localReturnVisitors>;
  private currentInlineNode: Rule.Node | null = null;

  private constructor(environment: TypeScriptRuleEnvironment) {
    const { context, program, services, filename, cwd } = environment;
    this.context = context;
    this.services = services;
    this.filename = filename;
    const parserSourceFile = program.getSourceFile(filename);
    if (!parserSourceFile) {
      throw new TypeError(`${filename} is absent from the TypeScript program.`);
    }
    const options = (environment.options[0] ?? {}) as Omit<
      OwnerOptions,
      "program"
    > & { fieldBlocks?: unknown };
    this.packageRoot = packageDirectory(filename) ?? cwd;
    this.mode = parserSourceFile.impliedNodeFormat;
    this.generatedSources = options.generatedSources ?? {};
    this.canonicalEntities = options.canonicalEntities ?? {};
    const index = createPackageOwnerIndex({
      program,
      generatedSources: options.generatedSources ?? {},
      packageTypeOwners: options.packageTypeOwners ?? {},
      canonicalEntities: options.canonicalEntities ?? {},
      includeInstalledProposals: Boolean(semanticFactSink(context)),
    });
    this.scope = index.candidatesFor({
      packageRoot: this.packageRoot,
      mode: this.mode,
      sourceFile: parserSourceFile,
    });
    const sourceFile = this.scope.program.getSourceFile(
      parserSourceFile.fileName
    );
    if (!sourceFile) {
      throw new TypeError(`${filename} is absent from the ownership program.`);
    }
    this.sourceFile = sourceFile;
    this.filePaths = relevantFilePaths(this.scope.program, sourceFile);
    this.packageEntries = [...this.scope.candidates];
    this.fieldBlockVisitors = createFieldBlockVisitors(
      context,
      options.fieldBlocks,
      (node: ts.Node) => this.hasReportedAncestor(node)
    );
    const inlineContext = {
      ...context,
      report: (report: InlineReport) => {
        if (
          this.currentInlineNode &&
          (!("messageId" in report) || report.messageId !== "undecided")
        ) {
          this.reported.add(this.currentInlineNode);
        }
        context.report(report);
      },
    };
    this.inlineVisitors = inlineBoundaryVisitors({
      ...environment,
      context: inlineContext,
    });
    this.localVisitors = localReturnVisitors(environment);
    this.index = index;
  }

  private readonly index: ReturnType<typeof createPackageOwnerIndex>;

  static visitors(environment: TypeScriptRuleEnvironment): Rule.RuleListener {
    const session = new StructuralRuleSession(environment);
    return {
      Program() {
        session.reset();
      },
      TSTypeAliasDeclaration(node: Rule.Node) {
        session.checkDeclaration(node);
      },
      TSInterfaceDeclaration(node: Rule.Node) {
        session.checkInterfaceDeclaration(node);
      },
      TSTypeLiteral(node: Rule.Node) {
        session.checkProjection(node);
        session.inlineNodes.push(node);
        session.fieldBlockVisitors.TSTypeLiteral(node);
      },
      TSUnionType(node: Rule.Node) {
        session.checkProjection(node);
      },
      TSInterfaceBody: session.fieldBlockVisitors.TSInterfaceBody,
      FunctionDeclaration: session.localVisitors.FunctionDeclaration,
      VariableDeclarator: session.localVisitors.VariableDeclarator,
      CallExpression: session.fieldBlockVisitors.CallExpression,
      "Program:exit"() {
        session.finish();
      },
    };
  }

  private reset() {
    this.declarationChecks.length = 0;
    this.projectionNodes.length = 0;
    this.inlineNodes.length = 0;
    this.reported.clear();
  }

  private analysisNode(node: ts.Node): ts.Node {
    const parserFile = node.getSourceFile();
    const analysisFile = this.scope.program.getSourceFile(parserFile.fileName);
    if (!analysisFile) {
      throw new TypeError(
        `${parserFile.fileName} is absent from the ownership program.`
      );
    }
    if (analysisFile === parserFile) {
      return node;
    }
    const visit = (candidate: ts.Node): ts.Node | undefined => {
      if (
        candidate.kind === node.kind &&
        candidate.pos === node.pos &&
        candidate.end === node.end
      ) {
        return candidate;
      }
      return ts.forEachChild(candidate, visit);
    };
    const analyzed = visit(analysisFile);
    if (!analyzed) {
      throw new TypeError(
        `Cannot align ${node.kind} in ${parserFile.fileName}.`
      );
    }
    return analyzed;
  }

  private hasReportedAncestor(node: Rule.Node | ts.Node) {
    for (
      let parent: Rule.Node | ts.Node | null = node;
      parent;
      parent = parent.parent ?? null
    ) {
      if (this.reported.has(parent)) {
        return true;
      }
    }
    return false;
  }

  private checkProjection(node: Rule.Node) {
    const tsNode = this.services.esTreeNodeToTSNodeMap.get(node);
    if (tsNode) {
      this.projectionNodes.push({ node, tsNode });
    }
  }

  private checkInterfaceDeclaration(node: Rule.Node) {
    const tsNode = this.services.esTreeNodeToTSNodeMap.get(node);
    if (tsNode) {
      this.projectionNodes.push({ node, tsNode });
    }
    this.checkDeclaration(node);
  }

  private checkDeclaration(node: Rule.Node) {
    if (
      isAllOptionalObjectShape(node) ||
      isStructuralDerivationAlias(node) ||
      isConvexGeneratedFile(this.filename)
    ) {
      return;
    }
    const parserNode = this.services.esTreeNodeToTSNodeMap.get(node);
    if (!parserNode) {
      return;
    }
    const tsNode = this.analysisNode(parserNode);
    if (
      (!ts.isTypeAliasDeclaration(tsNode) &&
        !ts.isInterfaceDeclaration(tsNode)) ||
      isConvexOwnerReferenceAlias(this.scope.checker, tsNode)
    ) {
      return;
    }
    const symbol = this.scope.checker.getSymbolAtLocation(tsNode.name);
    if (!symbol) {
      return;
    }
    const declared = this.scope.checker.getDeclaredTypeOfSymbol(symbol);
    if (
      !isObjectType(declared) ||
      resolvesToInstalledType(declared) ||
      resolvesToGeneratedType(declared, this.generatedSources) ||
      resolvesToDomainCanonicalType(declared, this.canonicalEntities)
    ) {
      return;
    }
    const local: LocalStructuralType = {
      type: declared,
      symbol,
      declaration: tsNode,
      props: typeProps(this.scope.checker, declared),
      detailedProps: typePropsDetailed(this.scope.checker, declared),
    };
    const analysis = this.index.exactShapeCandidates({
      packageRoot: this.packageRoot,
      mode: this.mode,
      sourceFile: tsNode.getSourceFile(),
      local,
    });
    this.declarationChecks.push({
      node,
      tsNode: analysis.declaration,
      sourceNode: tsNode,
      symbol: analysis.local.symbol,
      local: analysis.local,
      matches: analysis.matches,
      checker: analysis.checker,
      coverage: analysis.coverage,
    });
  }

  private readonly generatedSources: NonNullable<
    OwnerOptions["generatedSources"]
  >;
  private readonly canonicalEntities: NonNullable<
    OwnerOptions["canonicalEntities"]
  >;

  private reportProof(
    node: Rule.Node,
    proof: StructuralProof,
    analyzed?: ts.Node
  ) {
    emitSemanticFact(
      this.context,
      node,
      structuralMatchFact("antidrift/no-structural-type-fork", proof)
    );
    if (!proof.diagnostic.emitted) {
      return;
    }
    this.reported.add(node);
    this.reported.add(this.services.esTreeNodeToTSNodeMap.get(node));
    if (analyzed) {
      this.reported.add(analyzed);
    }
    this.context.report({
      node,
      messageId: proof.diagnostic.messageId,
      data: { owner: proof.ownerType.label },
    });
  }

  private collectProvenance() {
    const filePaths = this.filePaths.slice(0, 32);
    const localDeclarations = new Map<ts.Node, ReadonlyMap<string, ts.Type>>();
    for (const check of this.declarationChecks) {
      localDeclarations.set(
        check.sourceNode,
        contractFieldTypes(this.scope.checker, check.sourceNode)
      );
    }
    for (const { tsNode } of this.projectionNodes) {
      const analyzed = this.analysisNode(tsNode);
      localDeclarations.set(
        analyzed,
        contractFieldTypes(this.scope.checker, analyzed)
      );
    }
    const candidates = scopedProvenanceCandidates(
      this.scope.program,
      filePaths,
      this.packageEntries
    );
    const hasContractSites = localDeclarations.size > 0;
    const owners = hasContractSites
      ? this.index.ownerProjectionsForUse({
          packageRoot: this.packageRoot,
          mode: this.mode,
          sourceFile: this.sourceFile,
          candidates,
        })
      : undefined;
    const { findings: provenance, incomplete } = hasContractSites
      ? collectOwnedContractProvenance(
          this.scope.program,
          this.scope.checker,
          candidates,
          filePaths,
          { declarations: localDeclarations },
          owners
        )
      : {
          findings: new Map<ts.Node, ProjectionProof[]>(),
          incomplete: new Set<ts.Node>(),
        };
    const coverage: Coverage = {
      complete: this.scope.coverage.complete && this.filePaths.length <= 32,
      exhausted: [
        ...this.scope.coverage.exhausted,
        ...(this.filePaths.length <= 32
          ? []
          : [
              {
                budget: "provenance" as const,
                scope: `${this.filename} direct imports/dependents`,
              },
            ]),
      ],
    };
    return { provenance, incomplete, coverage };
  }

  private reportProjections(
    provenance: ReadonlyMap<ts.Node, readonly ProjectionProof[]>
  ) {
    for (const { node, tsNode } of this.projectionNodes) {
      const analyzed = this.analysisNode(tsNode);
      const proofs = provenance.get(analyzed) ?? [];
      const proof = proofs[0];
      if (
        !proof ||
        this.hasReportedAncestor(tsNode) ||
        this.hasReportedAncestor(analyzed)
      ) {
        continue;
      }
      if (new Set(proofs.map(ownerTypeForProof)).size !== 1) {
        emitSemanticFact(
          this.context,
          node,
          structuralMatchFact("antidrift/no-structural-type-fork", {
            ...proof,
            diagnostic: { emitted: false, reason: "multiple-owners" },
          })
        );
        continue;
      }
      this.reportProof(node, proof, analyzed);
    }
  }

  private arbitrateDeclarations(
    provenance: ReadonlyMap<ts.Node, readonly ProjectionProof[]>,
    incomplete: ReadonlySet<ts.Node>,
    coverage: Coverage
  ) {
    for (const check of this.declarationChecks) {
      const relevantCoverage: Coverage = incomplete.has(check.sourceNode)
        ? {
            complete: false,
            exhausted: [
              {
                budget: "symbol",
                scope: `${this.filename} relevant owner projections`,
              },
            ],
          }
        : { complete: true, exhausted: [] };
      const verdict = arbitrateOwnership({
        checker: check.checker,
        local: {
          symbol: check.symbol,
          node: check.tsNode,
          exported: isSymbolPubliclyExported(
            check.checker,
            check.tsNode,
            check.symbol
          ),
        },
        packageRoot: this.packageRoot,
        matches: check.matches,
        coverage: mergeCoverage(check.coverage, coverage, relevantCoverage),
        witnesses:
          provenance.get(check.sourceNode) ??
          provenance.get(check.tsNode) ??
          [],
      });
      if (verdict.kind === "block") {
        if (
          !this.hasReportedAncestor(check.node) &&
          !this.hasReportedAncestor(check.tsNode)
        ) {
          this.reportProof(check.node, verdict.proof, check.tsNode);
        }
      } else if (verdict.kind === "inventory" && verdict.proof) {
        emitSemanticFact(
          this.context,
          check.node,
          structuralMatchFact(
            "antidrift/no-structural-type-fork",
            verdict.proof
          )
        );
      }
    }
  }

  private finish() {
    const { provenance, incomplete, coverage } = this.collectProvenance();
    this.reportProjections(provenance);
    this.arbitrateDeclarations(provenance, incomplete, coverage);
    for (const node of this.inlineNodes) {
      if (this.hasReportedAncestor(node)) {
        continue;
      }
      this.currentInlineNode = node;
      this.inlineVisitors.TSTypeLiteral(node);
      this.currentInlineNode = null;
    }
    this.fieldBlockVisitors["Program:exit"]();
  }
}
