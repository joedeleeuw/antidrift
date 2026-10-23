import { relative } from "node:path";
import ts from "typescript";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";
import { nearDuplicateTypes } from "../../semantic-adapters/shape/near-duplicate-types.ts";
import {
  shapeComparison,
  unresolvedDescription,
} from "../../semantic-adapters/shape/shape-identity.ts";
import { inlineStructuralRepeat } from "./no-inline-structural-type-at-use-site.js";

const listedNames = 4;

// no-inline-structural-type-at-use-site owns exact repeats in boundary
// parameter types; a literal it reports is left to it, so a site gets one
// report and the two rules cannot drift apart.
function reportedAsInlineRepeat(environment, literal) {
  const node = environment.services.tsNodeToESTreeNodeMap?.get(literal);
  return Boolean(node && inlineStructuralRepeat(node, environment));
}

function lineLocation(node, cwd) {
  const source = node.getSourceFile();
  const line =
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return `${relative(cwd, source.fileName)}:${line}`;
}

function staticName(name) {
  return name &&
    (ts.isIdentifier(name) ||
      ts.isPrivateIdentifier(name) ||
      ts.isStringLiteral(name))
    ? name.text
    : null;
}

const namedHolders = [
  ts.isVariableDeclaration,
  ts.isPropertyAssignment,
  ts.isPropertyDeclaration,
  ts.isPropertySignature,
  ts.isTypeAliasDeclaration,
];

function signatureName(signature) {
  const own = staticName(signature.name);
  if (own) return own;
  const holder = signature.parent;
  return namedHolders.some((isHolder) => isHolder(holder))
    ? staticName(holder.name)
    : null;
}

// The nearest enclosing declaration with a name, for a parameter whose own
// function has none (a callback, or a function type in a return annotation).
function enclosingName(signature) {
  for (let node = signature.parent; node && !ts.isSourceFile(node); ) {
    const name =
      (ts.isFunctionLike(node) && signatureName(node)) ||
      (ts.isInterfaceDeclaration(node) || ts.isClassLike(node)
        ? staticName(node.name)
        : null);
    if (name) return name;
    node = node.parent;
  }
  return null;
}

function ownerLabel(node) {
  if (!ts.isTypeLiteralNode(node)) return `\`${node.name.text}\``;
  const parameter = node.parent;
  const parameterName = ts.isIdentifier(parameter.name)
    ? `\`${parameter.name.text}\` parameter`
    : "destructured parameter";
  if (ts.isConstructorDeclaration(parameter.parent)) {
    const className = staticName(parameter.parent.parent.name);
    return className
      ? `the ${parameterName} of the \`${className}\` constructor`
      : `the ${parameterName} of a constructor`;
  }
  const signature = signatureName(parameter.parent);
  if (signature) return `the ${parameterName} of \`${signature}\``;
  const enclosing = enclosingName(parameter.parent);
  return enclosing
    ? `the ${parameterName} of a function in \`${enclosing}\``
    : `the ${parameterName}`;
}

function subjectOf(node) {
  if (ts.isInterfaceDeclaration(node)) return "This interface";
  if (ts.isTypeAliasDeclaration(node)) return "This type";
  return "This parameter type";
}

function fieldCount(count) {
  return count === 1 ? "1 field" : `${count} fields`;
}

function keyList(names) {
  const quoted = names.slice(0, listedNames).map((name) => `"${name}"`);
  if (names.length > listedNames) quoted.push("...");
  return quoted.join(" | ");
}

// Shared fields whose optionality the local type changes: made required
// (optional in the owner) or made optional (required in the owner).
function optionalityFlips(duplicate) {
  const { local, owner, shared } = duplicate;
  const optionalIn = (declaration, name) =>
    declaration.members.get(name).optional;
  return {
    required: shared.filter(
      (name) => optionalIn(owner, name) && !optionalIn(local, name)
    ),
    loosened: shared.filter(
      (name) => !optionalIn(owner, name) && optionalIn(local, name)
    ),
    everyOptional: shared.every((name) => optionalIn(local, name)),
    everyRequired: shared.every((name) => !optionalIn(local, name)),
  };
}

// An interface with an extends clause carries members beyond its own, so a
// derivation from it lists the fields it takes instead of omitting the rest.
function inherits(node) {
  return (
    ts.isInterfaceDeclaration(node) && (node.heritageClauses?.length ?? 0) > 0
  );
}

function ownerSelection(owner, kept, omitted, inherited) {
  if (omitted.length === 0 && !inherited) return owner;
  return omitted.length < kept.length && !inherited
    ? `Omit<${owner}, ${keyList(omitted)}>`
    : `Pick<${owner}, ${keyList(kept)}>`;
}

// The shared fields taken from the owner, with the local type's optionality:
// Required<>/Partial<> around the selection when every shared field agrees,
// otherwise the flipped fields picked again as Required<> or Partial<>.
function ownerDerivation(duplicate, owner, ownerOnly) {
  const inherited = inherits(duplicate.owner.node);
  const flips = optionalityFlips(duplicate);
  const flipped = flips.required.length + flips.loosened.length > 0;
  const selection = ownerSelection(
    owner,
    duplicate.shared,
    ownerOnly,
    inherited
  );
  if (flipped && flips.everyRequired) return `Required<${selection}>`;
  if (flipped && flips.everyOptional) return `Partial<${selection}>`;
  const kept = duplicate.shared.filter(
    (name) => !flips.loosened.includes(name)
  );
  return [
    ownerSelection(owner, kept, [...ownerOnly, ...flips.loosened], inherited),
    ...(flips.loosened.length > 0
      ? [`Partial<Pick<${owner}, ${keyList(flips.loosened)}>>`]
      : []),
    ...(flips.required.length > 0
      ? [`Required<Pick<${owner}, ${keyList(flips.required)}>>`]
      : []),
  ].join(" & ");
}

function namedAdvice(duplicate, owner, ownerOnly, localOnly) {
  const { shared } = duplicate;
  const derived = ownerDerivation(duplicate, owner, ownerOnly);
  if (localOnly.length === 0 && inherits(duplicate.local.node)) {
    return `Extend ${derived} and drop the ${fieldCount(shared.length)} it repeats.`;
  }
  if (localOnly.length === 0) {
    return duplicate.exact && derived === owner
      ? `Use \`${owner}\` instead.`
      : `Derive it as ${derived}.`;
  }
  const sharedPart = ownerDerivation(duplicate, owner, []);
  if (ownerOnly.length === 0 && !sharedPart.includes("&")) {
    return `Extend ${sharedPart === owner ? `\`${owner}\`` : sharedPart} and declare only the ${fieldCount(localOnly.length)} it adds.`;
  }
  return `Move the ${fieldCount(shared.length)} they share into one type that both extend, or take them from Pick<${owner}, ${keyList(shared)}>.`;
}

function unnamedAdvice(duplicate, ownerOnly, localOnly) {
  if (duplicate.exact) {
    return "Name that type once and use the name in both places.";
  }
  if (localOnly.length === 0) {
    return "Name that parameter type and derive this one from it with Pick<>, Omit<>, Partial<> or Required<>.";
  }
  if (ownerOnly.length === 0) {
    return `Name that parameter type and extend it here with only the ${fieldCount(localOnly.length)} this one adds.`;
  }
  return `Name the ${fieldCount(duplicate.shared.length)} they share once and have both types extend that name.`;
}

function fixAdvice(duplicate) {
  const { local, owner } = duplicate;
  const ownerOnly = [...owner.members.keys()].filter(
    (name) => !local.members.has(name)
  );
  const localOnly = [...local.members.keys()].filter(
    (name) => !owner.members.has(name)
  );
  return ts.isTypeLiteralNode(owner.node)
    ? unnamedAdvice(duplicate, ownerOnly, localOnly)
    : namedAdvice(duplicate, owner.node.name.text, ownerOnly, localOnly);
}

function repeatedFields(duplicate) {
  const total = duplicate.owner.members.size;
  return duplicate.shared.length === total
    ? `all ${fieldCount(total)}`
    : `${duplicate.shared.length} of the ${fieldCount(total)}`;
}

function reportedNode(node) {
  return ts.isTypeLiteralNode(node) ? node : node.name;
}

export function ruleNoNearDuplicateType() {
  return defineTypeScriptRule({
    ruleName: "no-near-duplicate-type",
    meta: {
      type: "problem",
      docs: {
        description:
          "Require deriving an object type from the importable type whose fields it repeats instead of keeping a parallel copy.",
      },
      schema: [],
      messages: {
        repeats:
          "{{subject}} repeats {{repeated}} of {{owner}} at {{location}}. {{fix}}",
        undecided:
          "Whether {{subject}} repeats {{repeated}} of {{owner}} at {{location}} is undecided because {{unresolved}} does not resolve.",
      },
    },
    run({ services, sourceFile, program, checker, cwd, reportNode }) {
      const environment = {
        checker,
        program,
        services,
        cwd,
        sameShape: shapeComparison(program),
      };
      for (const duplicate of nearDuplicateTypes(program, sourceFile)) {
        if (
          ts.isTypeLiteralNode(duplicate.local.node) &&
          reportedAsInlineRepeat(environment, duplicate.local.node)
        ) {
          continue;
        }
        const described = {
          subject: subjectOf(duplicate.local.node),
          repeated: repeatedFields(duplicate),
          owner: ownerLabel(duplicate.owner.node),
          location: lineLocation(duplicate.owner.node, cwd),
        };
        if (duplicate.verdict === true) {
          reportNode(reportedNode(duplicate.local.node), {
            messageId: "repeats",
            data: { ...described, fix: fixAdvice(duplicate) },
          });
        } else {
          reportNode(reportedNode(duplicate.local.node), {
            messageId: "undecided",
            data: {
              ...described,
              subject: described.subject.toLowerCase(),
              unresolved: unresolvedDescription(
                duplicate.verdict,
                checker,
                cwd
              ),
            },
          });
        }
      }
      return undefined;
    },
  });
}
