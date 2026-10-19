import ts from "typescript";
import { ELEMENT } from "./boundary-contracts.ts";
import type { CarrierPath } from "./carrier-paths.ts";
import type { Root } from "./root-domain.ts";
import { nodeKey, placeholder } from "./root-domain.ts";
import { memoizedRoots } from "./trace-context.ts";
import type { TraceContext, TraceCall } from "./trace-context.ts";
import { excluded } from "./decision-cases.ts";
import { broad } from "./boundary-types.ts";
import { enclosingFunction, unconditionalBefore } from "./boundary-syntax.ts";

type BindingRootsContext = Pick<
  TraceContext,
  | "checker"
  | "contracts"
  | "declarations"
  | "algebra"
  | "sources"
  | "contextualSources"
  | "trace"
  | "summary"
  | "withClaim"
  | "elementStep"
  | "projected"
  | "resolveAll"
  | "callArgumentsOf"
  | "concatenationRoots"
>;
export class BindingRoots {
  readonly context: BindingRootsContext;
  currentUse: ts.Node | null = null;
  constructor(context: BindingRootsContext) {
    this.context = context;
  }
  declaredClaim(parameter: ts.ParameterDeclaration) {
    const declared =
      parameter.type &&
      this.context.checker.getTypeFromTypeNode(parameter.type);
    const contract = this.context.contracts.claimContract(declared);
    return contract ? { contract, node: parameter } : undefined;
  }
  parameterRoots(parameter: ts.ParameterDeclaration): readonly Root[] {
    const ownerFn = parameter.parent;
    if (!ts.isFunctionLike(ownerFn)) {
      return [];
    }
    const signature = this.context.checker.getSignatureFromDeclaration(ownerFn);
    const decoder = this.context.declarations.signatureDecode(
      signature,
      parameter
    );
    const index = ownerFn.parameters.indexOf(parameter);
    if (excluded({ decoderSubject: decoder?.parameter === index })) {
      return [];
    }
    if (ts.isExpression(ownerFn)) {
      const contextual =
        this.context.contextualSources.contextualParameterRoots(parameter);
      if (contextual.length) {
        return contextual;
      }
    }
    return [placeholder(parameter, this.declaredClaim(parameter))];
  }
  argumentRootsAt(
    call: TraceCall,
    parameter: ts.ParameterDeclaration,
    index: number
  ) {
    const callArguments = this.context.callArgumentsOf(call);
    if (parameter.dotDotDotToken) {
      return callArguments
        .slice(index)
        .flatMap((argument) =>
          argument
            ? this.context
                .trace(argument)
                .map((root) =>
                  this.context.algebra.prefixed(root, ELEMENT, call)
                )
            : []
        );
    }
    const argument = callArguments[index] ?? parameter.initializer;
    return argument ? this.context.trace(argument) : [];
  }
  incomingRoots(parameter: ts.ParameterDeclaration): readonly Root[] {
    const ownerFn = parameter.parent;
    const declared =
      parameter.type &&
      this.context.checker.getTypeFromTypeNode(parameter.type);
    const index = ownerFn.parameters.indexOf(parameter);
    if (declared && this.context.declarations.exported(ownerFn)) {
      const boundary = this.context.sources.exportedParameterRoots(
        parameter,
        declared
      );
      if (boundary.length) {
        return boundary;
      }
    }
    const callers = this.context.sources
      .callersOf(ownerFn)
      .flatMap((call) => this.argumentRootsAt(call, parameter, index));
    if (callers.length) {
      return this.context.resolveAll(callers);
    }
    return this.context.resolveAll(
      this.context.contextualSources.contextualParameterRoots(parameter)
    );
  }
  assignmentRoots(assignment: ts.BinaryExpression): readonly Root[] {
    return assignment.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
      ? this.context.concatenationRoots(assignment, [assignment.right])
      : this.context.trace(assignment.right);
  }
  variableRoots(declaration: ts.VariableDeclaration): readonly Root[] {
    const use = this.currentUse;
    if (!use) {
      throw new TypeError(
        `Boundary binding ${declaration.getSourceFile().fileName}:${declaration.name.getText()} has no use`
      );
    }
    const source = this.context.declarations.platformSource(declaration);
    if (source && !source.requiresProvenance) {
      const declaredType = this.context.checker.getTypeAtLocation(declaration);
      if (!declaredType.getCallSignatures().length) {
        const awaitedOutput = this.context.checker.getAwaitedType(declaredType);
        const opaque = Boolean(source.opaque || broad(awaitedOutput));
        return [{ kind: source.kind, root: use, declaration, opaque }];
      }
    }
    const declarationList = declaration.parent;
    if (
      ts.isVariableDeclarationList(declarationList) &&
      ts.isForOfStatement(declarationList.parent)
    ) {
      const iterated = declarationList.parent.expression;
      return this.context.projected(
        this.context.trace(iterated),
        this.context.elementStep(iterated)
      );
    }
    const symbol = this.context.checker.getSymbolAtLocation(declaration.name);
    const declaringFunction = enclosingFunction(declaration);
    const nestedUse =
      declaringFunction !== enclosingFunction(use) ||
      declaration.getSourceFile() !== use.getSourceFile();
    const assignments = symbol
      ? (this.context.sources.writes(declaration.getSourceFile()).get(symbol) ??
        [])
      : [];
    const direct = assignments.filter(
      (assignment) =>
        enclosingFunction(assignment) === declaringFunction &&
        (nestedUse || assignment.end < use.pos)
    );
    const closureWrites = assignments.filter(
      (assignment) => enclosingFunction(assignment) !== declaringFunction
    );
    const last = nestedUse
      ? undefined
      : direct.findLast(
          (assignment) =>
            assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            unconditionalBefore(assignment, use)
        );
    const collected = [];
    if (last) {
      collected.push(...this.assignmentRoots(last));
    } else if (declaration.initializer) {
      collected.push(...this.context.trace(declaration.initializer));
    }
    for (const assignment of direct) {
      if (!last || assignment.pos > last.pos) {
        collected.push(...this.assignmentRoots(assignment));
      }
    }
    for (const assignment of closureWrites) {
      collected.push(...this.assignmentRoots(assignment));
    }
    return this.context.withClaim(
      collected,
      declaration.type &&
        this.context.checker.getTypeFromTypeNode(declaration.type),
      declaration
    );
  }
  bindingKeys(element: ts.BindingElement) {
    const name = element.propertyName ?? element.name;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return new Set([name.text]);
    }
    return this.context.contracts.propertyKeys({ name });
  }
  bindingCarrier(
    element: ts.BindingElement
  ): Pick<CarrierPath, "parameter" | "path" | "deserialized"> | null {
    const owner = element.parent.parent;
    let carrier: Pick<
      CarrierPath,
      "parameter" | "path" | "deserialized"
    > | null = null;
    if (ts.isBindingElement(owner)) {
      carrier = this.bindingCarrier(owner);
    } else if (ts.isParameter(owner)) {
      carrier = { parameter: owner, path: [] };
    } else if (ts.isVariableDeclaration(owner) && owner.initializer) {
      carrier = this.context.declarations.carrierPath(owner.initializer);
    }
    const keys = ts.isObjectBindingPattern(element.parent)
      ? this.bindingKeys(element)
      : null;
    if (!carrier || carrier.deserialized || keys?.size !== 1) {
      return null;
    }
    const [key] = keys;
    if (key === undefined) {
      throw new TypeError("Boundary binding carrier has no single key");
    }
    return { ...carrier, path: [...carrier.path, key] };
  }
  bindingElementRoots(element: ts.BindingElement): readonly Root[] {
    const pattern = element.parent;
    const owner = pattern.parent;
    const inherited = ts.isBindingElement(owner)
      ? this.bindingElementRoots(owner)
      : this.bindingRoots(owner, element);
    const defaults = element.initializer
      ? this.context.trace(element.initializer)
      : [];
    if (element.dotDotDotToken) {
      if (!ts.isObjectBindingPattern(pattern)) {
        return [...defaults, ...inherited];
      }
      const siblingKeys = new Set(
        pattern.elements
          .filter((sibling) => sibling !== element)
          .flatMap((sibling) => [...(this.bindingKeys(sibling) ?? [])])
      );
      return [
        ...defaults,
        ...this.context.algebra.overridden(inherited, siblingKeys),
      ];
    }
    const keys = ts.isObjectBindingPattern(pattern)
      ? this.bindingKeys(element)
      : null;
    const receiverType = this.context.checker.getTypeAtLocation(pattern);
    const step = {
      keys,
      elementKey: keys === null,
      receiverType,
      assertionDerived: () => false,
      at: nodeKey(pattern),
      sources: memoizedRoots(() =>
        this.context.sources.bindingSourceRoots(
          element,
          receiverType,
          keys,
          this.bindingCarrier(element)
        )
      ),
    };
    return [...defaults, ...this.context.projected(inherited, step)];
  }
  bindingRoots(declaration: ts.Node, use: ts.Node): readonly Root[] {
    if (ts.isParameter(declaration)) {
      return this.parameterRoots(declaration);
    }
    const previous = this.currentUse;
    this.currentUse = use;
    try {
      if (ts.isBindingElement(declaration)) {
        return this.bindingElementRoots(declaration);
      }
      if (ts.isVariableDeclaration(declaration)) {
        return this.variableRoots(declaration);
      }
      return [];
    } finally {
      this.currentUse = previous;
    }
  }
}
