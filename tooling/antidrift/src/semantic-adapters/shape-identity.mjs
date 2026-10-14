import ts from "typescript";
import { dirname, join } from "node:path";

function readonlyProperty(property) {
  return Boolean(
    ts.getCheckFlags(property) & ts.CheckFlags.Readonly ||
    ts.getDeclarationModifierFlagsFromSymbol(property) &
      ts.ModifierFlags.Readonly ||
    (property.flags & ts.SymbolFlags.GetAccessor &&
      !(property.flags & ts.SymbolFlags.SetAccessor))
  );
}

const walkedTypes = new Map([
  [true, { clean: new WeakSet(), unchecked: new WeakSet() }],
  [false, { clean: new WeakSet(), unchecked: new WeakSet() }],
]);

function runtimeImplemented(type, program) {
  const declarations = type.symbol?.declarations ?? [];
  return (
    Boolean(type.objectFlags & ts.ObjectFlags.Tuple) ||
    declarations.some((declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    )
  );
}

function memberSource(type) {
  return type.objectFlags & ts.ObjectFlags.Reference && type.target
    ? type.target
    : type;
}

function signatureTypes(signature, output, checker) {
  const predicate = checker.getTypePredicateOfSignature(signature);
  return [
    [checker.getReturnTypeOfSignature(signature), output],
    ...(predicate?.type ? [[predicate.type, output]] : []),
    ...[
      ...(signature.thisParameter ? [signature.thisParameter] : []),
      ...signature.parameters,
    ].map((parameter) => [checker.getTypeOfSymbol(parameter), !output]),
    ...(signature.typeParameters ?? []).flatMap((parameter) =>
      [
        parameter.getConstraint(),
        checker.getDefaultFromTypeParameter(parameter),
      ]
        .filter(Boolean)
        .map((bound) => [bound, output])
    ),
  ];
}

function referencedTypes(type, output, program) {
  const checker = program.getTypeChecker();
  const referenced = (type.aliasTypeArguments ?? []).map((argument) => [
    argument,
    output,
  ]);
  if (type.isUnionOrIntersection()) {
    referenced.push(...type.types.map((member) => [member, output]));
  }
  const constraint =
    type.flags & ts.TypeFlags.TypeParameter && type.getConstraint();
  if (constraint) referenced.push([constraint, output]);
  if (!(type.flags & ts.TypeFlags.Object)) return referenced;
  if (type.objectFlags & ts.ObjectFlags.Reference) {
    referenced.push(
      ...checker.getTypeArguments(type).map((argument) => [argument, output])
    );
  }
  const source = memberSource(type);
  const suppliedToRuntime = !output && runtimeImplemented(source, program);
  for (const property of suppliedToRuntime
    ? []
    : checker.getPropertiesOfType(source)) {
    referenced.push([checker.getTypeOfSymbol(property), output]);
  }
  for (const index of suppliedToRuntime
    ? []
    : checker.getIndexInfosOfType(source)) {
    referenced.push([index.keyType, !output], [index.type, output]);
  }
  for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
    for (const signature of checker.getSignaturesOfType(source, kind)) {
      referenced.push(...signatureTypes(signature, output, checker));
    }
  }
  return referenced;
}

function unchecked(type, output) {
  return (
    type.intrinsicName === "error" ||
    Boolean(output && type.flags & ts.TypeFlags.Any)
  );
}

function reachesUncheckedType(type, output, program) {
  const visited = new Map([
    [true, new Set()],
    [false, new Set()],
  ]);
  const pending = [[type, output]];
  while (pending.length > 0) {
    const [current, currentOutput] = pending.pop();
    const known = walkedTypes.get(currentOutput);
    if (known.unchecked.has(current) || unchecked(current, currentOutput)) {
      walkedTypes.get(output).unchecked.add(type);
      return true;
    }
    if (known.clean.has(current) || visited.get(currentOutput).has(current)) {
      continue;
    }
    visited.get(currentOutput).add(current);
    pending.push(...referencedTypes(current, currentOutput, program));
  }
  for (const [polarity, types] of visited) {
    for (const clean of types) walkedTypes.get(polarity).clean.add(clean);
  }
  return false;
}

export function sameObjectShape(type, owner, program) {
  const checker = program.getTypeChecker();
  let compared = new Map([
    [true, new Map()],
    [false, new Map()],
  ]);
  function scopedComparisons() {
    const previousComparisons = compared;
    compared = new Map(
      [...compared].map(([polarity, pairs]) => [polarity, new Map(pairs)])
    );
    return previousComparisons;
  }
  function samePredicate(signature, owner, output) {
    const predicate = checker.getTypePredicateOfSignature(signature);
    const ownedPredicate = checker.getTypePredicateOfSignature(owner);
    if (!predicate || !ownedPredicate) return predicate === ownedPredicate;
    return (
      predicate.kind === ownedPredicate.kind &&
      predicate.parameterIndex === ownedPredicate.parameterIndex &&
      (predicate.type && ownedPredicate.type
        ? sameType(predicate.type, ownedPredicate.type, output)
        : predicate.type === ownedPredicate.type)
    );
  }

  function sameTypeParameters(signature, owner, output) {
    const ownedParameters = owner.typeParameters ?? [];
    for (const [index, parameter] of (
      signature.typeParameters ?? []
    ).entries()) {
      for (const polarity of [true, false]) {
        compared
          .get(polarity)
          .set(parameter, new Set([ownedParameters[index]]));
      }
    }
    return (signature.typeParameters ?? []).every((parameter, index) =>
      ["getConstraint", "getDefault"].every((field) => {
        const contract = parameter[field]();
        const ownedContract = ownedParameters[index][field]();
        return contract && ownedContract
          ? sameType(contract, ownedContract, output)
          : contract === ownedContract;
      })
    );
  }

  function sameSignature(signature, owner, output) {
    if (
      signature.parameters.length !== owner.parameters.length ||
      signature.minArgumentCount !== owner.minArgumentCount ||
      signature.flags !== owner.flags ||
      (signature.typeParameters?.length ?? 0) !==
        (owner.typeParameters?.length ?? 0) ||
      Boolean(signature.thisParameter) !== Boolean(owner.thisParameter)
    ) {
      return false;
    }
    const previousComparisons = scopedComparisons();
    try {
      return (
        sameTypeParameters(signature, owner, output) &&
        samePredicate(signature, owner, output) &&
        (!signature.thisParameter ||
          sameType(
            checker.getTypeOfSymbol(signature.thisParameter),
            checker.getTypeOfSymbol(owner.thisParameter),
            !output
          )) &&
        sameType(
          checker.getReturnTypeOfSignature(signature),
          checker.getReturnTypeOfSignature(owner),
          output
        ) &&
        signature.parameters.every((parameter, index) =>
          sameType(
            checker.getTypeOfSymbol(parameter),
            checker.getTypeOfSymbol(owner.parameters[index]),
            !output
          )
        )
      );
    } finally {
      compared = previousComparisons;
    }
  }

  function sameArrayKind(type, owner) {
    if (checker.isTupleType(type) !== checker.isTupleType(owner)) {
      return false;
    }
    if (checker.isArrayType(type) && type.target !== owner.target) {
      return false;
    }
    return (
      type.target.readonly === owner.target.readonly &&
      (!checker.isTupleType(type) ||
        JSON.stringify(type.target.elementFlags) ===
          JSON.stringify(owner.target.elementFlags))
    );
  }

  function argumentPairs(type, owner) {
    const typeArguments = checker.getTypeArguments(type);
    const ownedArguments = checker.getTypeArguments(owner);
    return typeArguments.length === ownedArguments.length
      ? typeArguments.map((argument, index) => [
          argument,
          ownedArguments[index],
        ])
      : null;
  }

  function sameReferenceTarget(type, owner) {
    return Boolean(
      type.objectFlags & ts.ObjectFlags.Reference &&
      owner.objectFlags & ts.ObjectFlags.Reference &&
      type.target === owner.target
    );
  }

  function sameMembers(type, owner, output) {
    const properties = checker.getPropertiesOfType(type);
    if (properties.length !== checker.getPropertiesOfType(owner).length) {
      return false;
    }
    const indexes = checker.getIndexInfosOfType(type);
    const ownedIndexes = checker.getIndexInfosOfType(owner);
    return (
      properties.every((property) => {
        const ownedProperty = checker.getPropertyOfType(owner, property.name);
        return (
          ownedProperty &&
          (property.flags & ts.SymbolFlags.Optional) ===
            (ownedProperty.flags & ts.SymbolFlags.Optional) &&
          readonlyProperty(property) === readonlyProperty(ownedProperty) &&
          sameType(
            checker.getTypeOfSymbol(property),
            checker.getTypeOfSymbol(ownedProperty),
            output
          )
        );
      }) &&
      indexes.length === ownedIndexes.length &&
      indexes.every((index) =>
        ownedIndexes.some(
          (ownedIndex) =>
            index.isReadonly === ownedIndex.isReadonly &&
            sameType(index.keyType, ownedIndex.keyType, !output) &&
            sameType(index.type, ownedIndex.type, output)
        )
      ) &&
      [ts.SignatureKind.Call, ts.SignatureKind.Construct].every((kind) => {
        const signatures = checker.getSignaturesOfType(type, kind);
        const ownedSignatures = checker.getSignaturesOfType(owner, kind);
        return (
          signatures.length === ownedSignatures.length &&
          signatures.every((signature, index) =>
            sameSignature(signature, ownedSignatures[index], output)
          )
        );
      })
    );
  }

  function everyMemberMatched(matches) {
    return (
      matches.every((row) => row.some(Boolean)) &&
      matches.every((row, index) => matches.some((otherRow) => otherRow[index]))
    );
  }

  function sameStructure(type, owner, output) {
    if (type === owner) return !reachesUncheckedType(type, output, program);
    const array = checker.isArrayType(type) || checker.isTupleType(type);
    const ownedArray = checker.isArrayType(owner) || checker.isTupleType(owner);
    const reference = sameReferenceTarget(type, owner);
    if (reference || array || ownedArray) {
      const pairs =
        (reference || (array === ownedArray && sameArrayKind(type, owner))) &&
        argumentPairs(type, owner);
      return Boolean(
        pairs &&
        !reachesUncheckedType(type, output, program) &&
        !reachesUncheckedType(owner, output, program) &&
        pairs.every(([argument, ownedArgument]) =>
          sameType(argument, ownedArgument, output)
        )
      );
    }
    if (type.isUnionOrIntersection() || owner.isUnionOrIntersection()) {
      return (
        type.flags === owner.flags &&
        type.types.length === owner.types.length &&
        everyMemberMatched(
          type.types.map((member) =>
            owner.types.map((ownedMember) =>
              sameType(member, ownedMember, output)
            )
          )
        )
      );
    }
    if (
      !(type.flags & ts.TypeFlags.Object) ||
      !(owner.flags & ts.TypeFlags.Object)
    ) {
      return false;
    }
    return sameMembers(type, owner, output);
  }

  function sameType(type, owner, output) {
    if ([type, owner].some((candidate) => unchecked(candidate, output))) {
      return false;
    }
    if (compared.get(output).get(type)?.has(owner)) return true;
    if (
      !checker.isTypeAssignableTo(type, owner) ||
      !checker.isTypeAssignableTo(owner, type)
    ) {
      return false;
    }
    const previousComparisons = scopedComparisons();
    try {
      compared
        .get(output)
        .set(type, new Set([...(compared.get(output).get(type) ?? []), owner]));
      return sameStructure(type, owner, output);
    } finally {
      compared = previousComparisons;
    }
  }
  return (
    checker.isTypeAssignableTo(type, owner) &&
    checker.isTypeAssignableTo(owner, type) &&
    sameType(type, owner, true)
  );
}

export function packageDirectory(filename) {
  let directory = dirname(filename);
  while (!ts.sys.fileExists(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return directory;
}

const generationDeclarations = [
  /^@generated\b/u,
  /^code generated\b.*\bdo not edit\.?$/iu,
  /^(?:this (?:file|module) (?:is|was|has been) )?(?:auto(?:matically)?[- ]?)?generated (?:by|from|with|using) \S/iu,
];

function commentLines(text) {
  return text
    .replace(/^\/\*+|\*+\/$/gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/+|\*+)?\s*/u, "").trim());
}

export function declaresGenerated(source) {
  return (ts.getLeadingCommentRanges(source.text, 0) ?? []).some((range) =>
    commentLines(source.text.slice(range.pos, range.end)).some((line) =>
      generationDeclarations.some((declaration) => declaration.test(line))
    )
  );
}
