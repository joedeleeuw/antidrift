import ts from "typescript";

import { isTypeReference } from "../kernel/typescript-internals.ts";
import { boundaryObservations } from "./boundary-observations.ts";

const SEEN_TYPE_PAIRS = boundaryObservations.bounds.narrowingProofPairCap.limit;

const REPEATING_ELEMENT_FLAGS = ts.ElementFlags.Rest | ts.ElementFlags.Variadic;

const SHAPE_PARTS = ["prefix", "repeating", "suffix"] as const;

const SIGNATURE_READERS = [
  (type: ts.Type) => type.getCallSignatures(),
  (type: ts.Type) => type.getConstructSignatures(),
];

type Segment = { readonly type: ts.Type; readonly repeats: boolean };

type ParameterShape = {
  readonly [Part in (typeof SHAPE_PARTS)[number]]: readonly Segment[];
} & { readonly receiver: ts.Type | undefined };

export function unionConstituents(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

function isObjectReference(type: ts.Type): type is ts.TypeReference {
  return (type.flags & ts.TypeFlags.Object) !== 0 && isTypeReference(type);
}

export function sameType(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type
): boolean {
  if (left === right) {
    return true;
  }
  if (
    !isObjectReference(left) ||
    !isObjectReference(right) ||
    left.target !== right.target
  ) {
    return false;
  }
  const leftArguments = checker.getTypeArguments(left);
  const rightArguments = checker.getTypeArguments(right);
  return (
    leftArguments.length === rightArguments.length &&
    leftArguments.every((argument, index) => {
      const rightArgument = rightArguments[index];
      return (
        rightArgument !== undefined &&
        sameType(checker, argument, rightArgument)
      );
    })
  );
}

function elementTypesOf(
  checker: ts.TypeChecker,
  type: ts.Type
): readonly ts.Type[] {
  if (isObjectReference(type) && checker.isArrayLikeType(type)) {
    return checker.getTypeArguments(type);
  }
  const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return indexed ? [indexed] : [];
}

function restSegments(checker: ts.TypeChecker, restType: ts.Type): Segment[] {
  const elements = elementTypesOf(checker, restType);
  if (!checker.isTupleType(restType)) {
    const [element] = elements;
    return element ? [{ type: element, repeats: true }] : [];
  }
  const flags = isTypeReference(restType)
    ? (restType.target.elementFlags ?? [])
    : [];
  return elements.map((type, index) => ({
    type,
    repeats: ((flags[index] ?? 0) & REPEATING_ELEMENT_FLAGS) !== 0,
  }));
}

function parameterShape(
  checker: ts.TypeChecker,
  signature: ts.Signature
): ParameterShape {
  const segments: Segment[] = [];
  for (const parameter of signature.parameters) {
    const type = checker.getTypeOfSymbol(parameter);
    const declaration = parameter.valueDeclaration;
    if (
      declaration &&
      ts.isParameter(declaration) &&
      declaration.dotDotDotToken
    ) {
      segments.push(...restSegments(checker, type));
    } else {
      segments.push({ type, repeats: false });
    }
  }
  const receiver =
    signature.thisParameter && checker.getTypeOfSymbol(signature.thisParameter);
  const firstRepeat = segments.findIndex((segment) => segment.repeats);
  if (firstRepeat < 0) {
    return { prefix: segments, repeating: [], suffix: [], receiver };
  }
  const lastRepeat = segments.findLastIndex((segment) => segment.repeats);
  return {
    prefix: segments.slice(0, firstRepeat),
    repeating: segments.slice(firstRepeat, lastRepeat + 1),
    suffix: segments.slice(lastRepeat + 1),
    receiver,
  };
}

function sameShape(flow: ParameterShape, target: ParameterShape): boolean {
  return SHAPE_PARTS.every((part) => flow[part].length === target[part].length);
}

function repeatingTypes(shape: ParameterShape): ts.Type[] {
  return shape.repeating.map((segment) => segment.type);
}

function typesFromFront(shape: ParameterShape, index: number): ts.Type[] {
  const segment = shape.prefix[index];
  return segment ? [segment.type] : repeatingTypes(shape);
}

function typesFromBack(shape: ParameterShape, index: number): ts.Type[] {
  const tail = shape.repeating.length ? shape.suffix : shape.prefix;
  const segment = tail[tail.length - 1 - index];
  return segment ? [segment.type] : repeatingTypes(shape);
}

function segmentCount(shape: ParameterShape): number {
  return SHAPE_PARTS.reduce((count, part) => count + shape[part].length, 0);
}

export class TypeDifference {
  readonly #checker: ts.TypeChecker;
  readonly #seen = new Map<ts.Type, Set<ts.Type>>();
  #capped = false;

  constructor(checker: ts.TypeChecker) {
    this.#checker = checker;
  }

  get capped(): boolean {
    return this.#capped;
  }

  differs(flowType: ts.Type, targetType: ts.Type): boolean {
    if ((targetType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return false;
    }
    if ((flowType.flags & ts.TypeFlags.Any) !== 0) {
      return true;
    }
    if (sameType(this.#checker, flowType, targetType)) {
      return false;
    }
    const seenTargets = this.#seen.get(flowType) ?? new Set<ts.Type>();
    if (seenTargets.has(targetType)) {
      return false;
    }
    if (this.#seen.size > SEEN_TYPE_PAIRS) {
      this.#capped = true;
      return false;
    }
    seenTargets.add(targetType);
    this.#seen.set(flowType, seenTargets);
    return unionConstituents(flowType).some((constituent) => {
      const admitted = unionConstituents(targetType).filter((candidate) =>
        this.#checker.isTypeAssignableTo(constituent, candidate)
      );
      return (
        admitted.length > 0 &&
        admitted.every((candidate) => this.#structure(constituent, candidate))
      );
    });
  }

  #elements(flowType: ts.Type, targetType: ts.Type): boolean {
    const flowElements = elementTypesOf(this.#checker, flowType);
    const targetElements = elementTypesOf(this.#checker, targetType);
    const [firstFlow] = flowElements;
    const [firstTarget] = targetElements;
    if (!firstFlow || !firstTarget) {
      return false;
    }
    if (this.#checker.isTupleType(targetType)) {
      const flowIsTuple = this.#checker.isTupleType(flowType);
      return targetElements.some((targetElement, index) => {
        const flowElement = flowIsTuple ? flowElements[index] : firstFlow;
        return (
          flowElement !== undefined && this.differs(flowElement, targetElement)
        );
      });
    }
    return flowElements.some((flowElement) =>
      this.differs(flowElement, firstTarget)
    );
  }

  #anyPairDiffers(
    flowTypes: readonly ts.Type[],
    targetTypes: readonly ts.Type[]
  ): boolean {
    return flowTypes.some((flowType) =>
      targetTypes.some((targetType) => this.differs(flowType, targetType))
    );
  }

  #parameters(
    flowSignature: ts.Signature,
    targetSignature: ts.Signature
  ): boolean {
    const flow = parameterShape(this.#checker, flowSignature);
    const target = parameterShape(this.#checker, targetSignature);
    if (
      flow.receiver &&
      target.receiver &&
      this.differs(flow.receiver, target.receiver)
    ) {
      return true;
    }
    if (sameShape(flow, target)) {
      return SHAPE_PARTS.some((part) =>
        flow[part].some((segment, index) => {
          const targetSegment = target[part][index];
          return (
            targetSegment !== undefined &&
            this.differs(segment.type, targetSegment.type)
          );
        })
      );
    }
    const alignTail = flow.repeating.length > 0 || target.repeating.length > 0;
    const positions = segmentCount(flow) + segmentCount(target);
    for (let index = 0; index < positions; index += 1) {
      if (
        this.#anyPairDiffers(
          typesFromFront(flow, index),
          typesFromFront(target, index)
        ) ||
        (alignTail &&
          this.#anyPairDiffers(
            typesFromBack(flow, index),
            typesFromBack(target, index)
          ))
      ) {
        return true;
      }
    }
    return false;
  }

  #signatures(flowType: ts.Type, targetType: ts.Type): boolean {
    return SIGNATURE_READERS.some((readSignatures) => {
      const flowSignatures = readSignatures(flowType);
      return readSignatures(targetType).some((targetSignature, index) => {
        const flowSignature = flowSignatures[index] ?? flowSignatures[0];
        if (!flowSignature) {
          return false;
        }
        return (
          this.differs(
            this.#checker.getReturnTypeOfSignature(flowSignature),
            this.#checker.getReturnTypeOfSignature(targetSignature)
          ) || this.#parameters(flowSignature, targetSignature)
        );
      });
    });
  }

  #typeArguments(flowType: ts.TypeReference, targetType: ts.TypeReference) {
    const targetArguments = this.#checker.getTypeArguments(targetType);
    return this.#checker.getTypeArguments(flowType).some((argument, index) => {
      const targetArgument = targetArguments[index];
      if (targetArgument === undefined) {
        throw new TypeError(
          "Narrowing proof: the flow type reference carries more type arguments than the target reference to the same generic type"
        );
      }
      return this.differs(argument, targetArgument);
    });
  }

  #members(flowType: ts.Type, targetType: ts.Type): boolean {
    const properties = this.#checker
      .getPropertiesOfType(targetType)
      .some((property) => {
        const flowProperty = this.#checker.getPropertyOfType(
          flowType,
          property.name
        );
        return Boolean(
          flowProperty &&
          this.differs(
            this.#checker.getTypeOfSymbol(flowProperty),
            this.#checker.getTypeOfSymbol(property)
          )
        );
      });
    if (properties) {
      return true;
    }
    const flowIndexes = this.#checker.getIndexInfosOfType(flowType);
    return this.#checker
      .getIndexInfosOfType(targetType)
      .some((index) =>
        flowIndexes.some(
          (flowIndex) =>
            flowIndex.keyType === index.keyType &&
            this.differs(flowIndex.type, index.type)
        )
      );
  }

  #structure(flowType: ts.Type, targetType: ts.Type): boolean {
    if (
      this.#checker.isArrayLikeType(targetType) &&
      this.#elements(flowType, targetType)
    ) {
      return true;
    }
    if (this.#signatures(flowType, targetType)) {
      return true;
    }
    if (
      isObjectReference(flowType) &&
      isObjectReference(targetType) &&
      flowType.target === targetType.target
    ) {
      return this.#typeArguments(flowType, targetType);
    }
    return this.#members(flowType, targetType);
  }
}
