import { dirname } from "node:path";
import {
  dependencyManifest,
  governingOptions,
  manifestDependencyFields,
  unresolvedEntries,
} from "../../semantic-adapters/provenance/declared-dependencies.ts";

// Import sites are the compiler's: TS2307, TS7016 and TS2882 report a
// declared package that is missing or has no type declarations there.
function manifestVisitors(context) {
  const packageRoot = dirname(context.filename);
  const options = governingOptions(packageRoot);
  return {
    Document(node) {
      if (node.body.type !== "Object") return;
      const keys = new Map();
      for (const fieldName of manifestDependencyFields) {
        const field = node.body.members.find(
          (member) => member.name.value === fieldName
        );
        if (field?.value.type !== "Object") continue;
        for (const member of field.value.members) {
          if (!keys.has(member.name.value)) {
            keys.set(member.name.value, member.name);
          }
        }
      }
      for (const [packageName, key] of keys) {
        const manifestPath = dependencyManifest(
          packageRoot,
          packageName,
          options
        );
        if (!manifestPath) {
          context.report({
            node: key,
            messageId: "uninstalledManifest",
            data: { packageName },
          });
          continue;
        }
        const entries = unresolvedEntries(
          packageRoot,
          packageName,
          manifestPath,
          options
        );
        if (entries.length > 0) {
          context.report({
            node: key,
            messageId: "unresolvedEntry",
            data: { packageName, entries: entries.join(", ") },
          });
        }
      }
    },
  };
}

export function ruleNoUnresolvedDependencyTypes() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Report declared dependencies whose type declarations do not resolve, because their exported types cannot be compared with first-party types.",
      },
      schema: [],
      messages: {
        uninstalledManifest:
          "{{packageName}} is declared here but not installed, so its exported types are not compared with first-party types in this package.",
        unresolvedEntry:
          "{{packageName}} is a workspace or linked package whose public entries {{entries}} do not resolve to type declarations, so their exported types are not compared with first-party types in this package.",
      },
    },
    create(context) {
      return context.sourceCode.ast.type === "Document"
        ? manifestVisitors(context)
        : {};
    },
  };
}
