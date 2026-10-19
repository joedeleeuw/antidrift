import ts from "typescript";

import type { BoundaryDeclarations } from "./boundary-declarations.ts";
import { broad } from "./boundary-types.ts";
import type { CarrierPath } from "./carrier-paths.ts";
import { excluded, exclusionCases } from "./decision-cases.ts";
import type { ConcreteRoot } from "./root-domain.ts";
import { frameworkCases } from "./source-cases.ts";

type FrameworkShape = (typeof frameworkCases)[number];

type HandlerSubject = {
  readonly subjectType: ts.Type;
  readonly declaration: ts.Declaration;
};

function startsWithShape(
  carrier: Pick<CarrierPath, "parameter" | "path">,
  shape: FrameworkShape
) {
  return (
    carrier.path.length > shape.path.length &&
    shape.path.every((segment, position) => carrier.path[position] === segment)
  );
}

export class FrameworkRoots {
  readonly #checker: ts.TypeChecker;
  readonly #origin: BoundaryDeclarations["origin"];

  constructor(checker: ts.TypeChecker, origin: BoundaryDeclarations["origin"]) {
    this.#checker = checker;
    this.#origin = origin;
  }

  rootOf(
    carrier: Pick<CarrierPath, "parameter" | "path">,
    expression: ts.Node
  ): ConcreteRoot | null {
    const [head] = carrier.path;
    for (const subject of this.#handlerSubjects(
      carrier.parameter,
      expression
    )) {
      const upstreamContract = exclusionCases.some(
        (row) =>
          "required" in row &&
          row.payloads.some((payload) => payload === head) &&
          row.required.every((name) =>
            this.#checker.getPropertyOfType(subject.subjectType, name)
          )
      );
      if (excluded({ upstreamContract })) {
        return null;
      }
      for (const shape of frameworkCases) {
        const root = this.#shapeRoot({ carrier, expression, subject }, shape);
        if (root) {
          return root;
        }
      }
    }
    return null;
  }

  #handlerSubjects(
    parameter: ts.ParameterDeclaration,
    expression: ts.Node
  ): HandlerSubject[] {
    const owner = parameter.parent;
    const index = owner.parameters.indexOf(parameter);
    const signatures = ts.isExpression(owner)
      ? (this.#checker
          .getContextualType(owner)
          ?.getNonNullableType()
          .getCallSignatures() ?? [])
      : [];
    const explicit = this.#checker
      .getTypeAtLocation(parameter)
      .getNonNullableType();
    const candidates = [
      ...signatures
        .map((signature) => signature.parameters[index])
        .filter((symbol) => symbol !== undefined)
        .map((symbol) => ({
          subjectType: this.#checker.getTypeOfSymbol(symbol),
          declarations: symbol.declarations ?? [],
        })),
      {
        subjectType: explicit,
        declarations: [
          ...(explicit.getSymbol()?.declarations ?? []),
          ...(explicit.aliasSymbol?.declarations ?? []),
        ],
      },
    ];
    return candidates.flatMap(({ subjectType, declarations: subjects }) => {
      const declaration = subjects.find(
        (contract) => this.#origin(contract, expression) === "dependency"
      );
      return declaration ? [{ subjectType, declaration }] : [];
    });
  }

  #shapeRoot(
    match: {
      readonly carrier: Pick<CarrierPath, "parameter" | "path">;
      readonly expression: ts.Node;
      readonly subject: HandlerSubject;
    },
    shape: FrameworkShape
  ): ConcreteRoot | null {
    const { carrier, expression, subject } = match;
    if (!startsWithShape(carrier, shape)) {
      return null;
    }
    let receiver: ts.Type | undefined = subject.subjectType;
    for (const segment of shape.path) {
      const member = this.#checker.getPropertyOfType(receiver, segment);
      receiver = member && this.#checker.getTypeOfSymbol(member);
      if (!receiver) {
        break;
      }
    }
    const shapedReceiver = receiver;
    if (
      !shapedReceiver ||
      !shape.required.every((name) =>
        this.#checker.getPropertyOfType(shapedReceiver, name)
      )
    ) {
      return null;
    }
    const payload = carrier.path[shape.path.length];
    if (payload === undefined || !shape.payloads.includes(payload)) {
      return null;
    }
    const opaque = broad(this.#checker.getTypeAtLocation(expression));
    return {
      kind: shape.kind,
      root: expression,
      declaration: subject.declaration,
      opaque,
    };
  }
}
