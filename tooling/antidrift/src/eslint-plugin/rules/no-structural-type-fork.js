import ts from "typescript";

import { semanticFactSink } from "../../policy/lib/semantic-facts.mjs";
import {
  collectAcceptedPackageCanonicalTypes,
  collectCanonicalTypes,
  collectConvexGeneratedCanonicalTypes,
  collectGeneratedCanonicalTypes,
  isConvexGeneratedFile,
  isObjectType,
  resolvesToGeneratedType,
  resolvesToInstalledType,
  typeProps,
  typePropsDetailed,
} from "../../semantic-adapters/type-owner.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";
import {
  emitStructuralMatchFact,
  findStructuralProof,
  isAllOptionalObjectShape,
  isStructuralDerivationAlias,
} from "./structural-fork-proof.js";

// Canonical candidate list is cached per TypeScript Program (stable per ESLint process),
// so the node_modules enumeration runs once rather than per linted file.
const canonicalCache = new WeakMap();
// Same per-program caching for the implicit Convex generated owner sweep.
const convexOwnerCache = new WeakMap();

function resolvedSymbol(checker, symbol) {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function declaresInConvexOwnedModule(sym) {
  for (const declaration of sym?.getDeclarations?.() ?? sym?.declarations ?? []) {
    const file = declaration.getSourceFile().fileName.replace(/\\/gu, "/");
    if (
      file.includes("/convex/_generated/") ||
      file.includes("/node_modules/convex/")
    ) {
      return true;
    }
  }
  return false;
}

// `type Row = Doc<"machines">` / `type Result = FunctionReturnType<typeof api.machines.get>`
// are references to the Convex owner, not hand-written forks. Alias-symbol preservation is
// unreliable through convex's conditional/indexed-access owner types, so the exemption
// resolves the referenced symbol's declarations instead of inspecting the resolved type.
function isConvexOwnerReferenceAlias(services, checker, node) {
  if (node.type !== "TSTypeAliasDeclaration") return false;
  const annotation = node.typeAnnotation;
  if (annotation?.type !== "TSTypeReference") return false;
  const tsAnnotation = services.esTreeNodeToTSNodeMap.get(annotation);
  const typeName = tsAnnotation?.typeName;
  if (!typeName) return false;
  const sym = resolvedSymbol(checker, checker.getSymbolAtLocation(typeName));
  return declaresInConvexOwnedModule(sym);
}

export function ruleNoStructuralTypeFork() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect hand-written types that exactly redeclare an installed package, configured generated source, or Convex generated owner exported type.",
      },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            generatedSources: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: true,
                properties: {
                  generated: { type: "string" },
                },
              },
            },
            packageTypeOwners: {
              type: "object",
              additionalProperties: {
                type: "object",
                required: ["package", "exportName"],
                additionalProperties: false,
                properties: {
                  package: { type: "string" },
                  exportName: { type: "string" },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
      ],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-structural-type-fork");
      }
      const program = services.program;
      const checker = program.getTypeChecker();
      const generatedSources = context.options[0]?.generatedSources ?? {};
      const packageTypeOwners = context.options[0]?.packageTypeOwners ?? {};
      const shouldCollectProposalFacts = Boolean(semanticFactSink(context));
      let candidates = [];
      if (Object.keys(generatedSources).length > 0) {
        candidates = collectGeneratedCanonicalTypes(
          program,
          checker,
          generatedSources,
        );
      }
      if (Object.keys(packageTypeOwners).length > 0) {
        candidates = [
          ...candidates,
          ...collectAcceptedPackageCanonicalTypes(
            program,
            checker,
            packageTypeOwners,
          ),
        ];
      }
      if (shouldCollectProposalFacts) {
        let installedCandidates = canonicalCache.get(program);
        if (!installedCandidates) {
          installedCandidates = collectCanonicalTypes(program, checker);
          canonicalCache.set(program, installedCandidates);
        }
        candidates = [...candidates, ...installedCandidates];
      }
      let convexCandidates = convexOwnerCache.get(program);
      if (!convexCandidates) {
        convexCandidates = collectConvexGeneratedCanonicalTypes(
          program,
          checker,
        );
        convexOwnerCache.set(program, convexCandidates);
      }
      candidates = [...candidates, ...convexCandidates];
      if (!candidates.length) {
        return {};
      }
      function check(node) {
        if (isAllOptionalObjectShape(node)) {
          return;
        }
        if (isStructuralDerivationAlias(node)) {
          return;
        }
        // Generated output is owner, never fork.
        if (
          isConvexGeneratedFile(context.filename ?? context.getFilename?.())
        ) {
          return;
        }
        if (isConvexOwnerReferenceAlias(services, checker, node)) {
          return;
        }
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const sym = tsNode?.name && checker.getSymbolAtLocation(tsNode.name);
        if (!sym) {
          return;
        }
        const declared = checker.getDeclaredTypeOfSymbol(sym);
        if (!isObjectType(declared)) {
          return;
        }
        // `type AppUser = firebase.User` resolves to the package's own type — a reference, not a
        // fork. Only hand-written shapes (resolved symbol declared in the user's code) are flagged.
        if (resolvesToInstalledType(declared)) {
          return;
        }
        if (resolvesToGeneratedType(declared, generatedSources)) {
          return;
        }
        const local = typeProps(checker, declared);
        const localDetailed = typePropsDetailed(checker, declared);
        const proof = findStructuralProof(
          sym,
          local,
          localDetailed,
          candidates,
          "structuralTypeFork",
        );
        if (!proof) {
          return;
        }
        emitStructuralMatchFact(
          context,
          node,
          "antidrift/no-structural-type-fork",
          proof,
        );
        if (proof.diagnostic.emitted) {
          context.report({
            node,
            message: `Type matches ${proof.ownerType.label} — import or derive from the owner instead of redeclaring.`,
          });
        }
      }
      return {
        TSTypeAliasDeclaration: check,
        TSInterfaceDeclaration: check,
      };
    },
  };
}
