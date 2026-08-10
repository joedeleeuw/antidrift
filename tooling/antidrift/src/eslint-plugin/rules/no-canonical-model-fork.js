import {
  collectDomainCanonicalTypes,
  isObjectType,
  resolvesToDomainCanonicalType,
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

export function ruleNoCanonicalModelFork() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect hand-written copies of configured repo-owned canonical domain models.",
      },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            canonicalEntities: {
              type: "object",
              additionalProperties: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      owner: { type: "string" },
                      exportName: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-canonical-model-fork");
      }
      const program = services.program;
      const checker = program.getTypeChecker();
      const canonicalEntities = context.options[0]?.canonicalEntities ?? {};
      const candidates = collectDomainCanonicalTypes(
        program,
        checker,
        canonicalEntities,
      );
      if (!candidates.length) {
        return {};
      }
      function check(node) {
        if (
          node.type === "TSTypeAliasDeclaration" &&
          node.typeAnnotation?.type !== "TSTypeLiteral"
        ) {
          return;
        }
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
        if (resolvesToDomainCanonicalType(declared, canonicalEntities)) {
          return;
        }
        const local = typeProps(checker, declared);
        const localDetailed = typePropsDetailed(checker, declared);
        const proof = findStructuralProof(
          sym,
          local,
          localDetailed,
          candidates,
          "canonicalModelFork",
        );
        if (!proof) {
          return;
        }
        emitStructuralMatchFact(
          context,
          node,
          "antidrift/no-canonical-model-fork",
          proof,
        );
        if (proof.diagnostic.emitted) {
          context.report({
            node,
            message: `Type matches ${proof.ownerType.label} — import or derive from the canonical model owner instead of redeclaring.`,
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
