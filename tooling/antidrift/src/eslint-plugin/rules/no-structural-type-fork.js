import { semanticFactSink } from "../../policy/lib/semantic-facts.mjs";
import {
  MIN_PROPS,
  collectAcceptedPackageCanonicalTypes,
  collectCanonicalTypes,
  collectGeneratedCanonicalTypes,
  isObjectType,
  resolvesToGeneratedType,
  resolvesToInstalledType,
  typeProps,
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
export function ruleNoStructuralTypeFork() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect hand-written types that exactly redeclare an installed package or configured generated source exported type.",
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
        if (local.size < MIN_PROPS) {
          return;
        }
        const proof = findStructuralProof(
          sym,
          local,
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
