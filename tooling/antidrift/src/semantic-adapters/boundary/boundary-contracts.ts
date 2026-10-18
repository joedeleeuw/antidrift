import ts from "typescript";

import {
  isErrorType,
  primitiveTypeFlags,
} from "../kernel/typescript-internals.ts";
import { shapeless, typed } from "./boundary-types.ts";

export const ELEMENT = "[]";

export const logicalOperators: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

export const assertionKinds: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

const AWAITED = ts.escapeLeadingUnderscores("Awaited");

type Contract = ts.Type | null | undefined;

type KeyedMember = { readonly name?: ts.DeclarationName | undefined };

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

export function unresolvedType(type: Contract): boolean {
  return Boolean(type && isErrorType(type));
}

function passesThrough(contract: ts.Type): boolean {
  return (
    (contract.flags & ts.TypeFlags.TypeParameter) !== 0 ||
    unresolvedType(contract)
  );
}

function soleAcrossOwners(
  contract: ts.Type,
  projection: (owner: ts.Type) => Contract
): ts.Type | null {
  const owner = contract.getNonNullableType();
  const whole = projection(owner);
  if (whole || !owner.isUnion()) {
    return whole ?? null;
  }
  const contracts = owner.types
    .map(projection)
    .filter((candidate) => candidate !== null && candidate !== undefined);
  return contracts.length === 1 ? (contracts[0] ?? null) : null;
}

function stripNullish(type: ts.Type): ts.Type {
  const awaited =
    type.aliasSymbol?.escapedName === AWAITED &&
    type.aliasTypeArguments?.length === 1
      ? type.aliasTypeArguments[0]
      : undefined;
  if (awaited) {
    return stripNullish(awaited);
  }
  if (type.isUnion()) {
    const members = type.types.filter(
      (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))
    );
    const [sole] = members;
    if (members.length === 1 && sole) {
      return stripNullish(sole);
    }
  }
  if (type.isIntersection()) {
    const shaped = type.types.filter((member) => !shapeless(member));
    const [sole] = shaped;
    if (shaped.length === 1 && sole) {
      return stripNullish(sole);
    }
  }
  return type;
}

class ContractProjection {
  readonly #checker: ts.TypeChecker;

  constructor(checker: ts.TypeChecker) {
    this.#checker = checker;
  }

  propertyKeys(property: KeyedMember) {
    const { name } = property;
    if (!name) {
      return null;
    }
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return new Set([name.text]);
    }
    return this.#literalKeys(
      ts.isComputedPropertyName(name) ? name.expression : name
    );
  }

  accessKeys(expression: MemberAccess) {
    if (ts.isPropertyAccessExpression(expression)) {
      return new Set([expression.name.text]);
    }
    return this.#literalKeys(expression.argumentExpression);
  }

  propertyKey(property: KeyedMember) {
    const { name } = property;
    if (!name) {
      return null;
    }
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return name.text;
    }
    return this.#literalText(
      ts.isComputedPropertyName(name) ? name.expression : name
    );
  }

  accessKey(expression: MemberAccess) {
    if (ts.isPropertyAccessExpression(expression)) {
      return expression.name.text;
    }
    return this.#literalText(expression.argumentExpression);
  }

  memberContract(contract: Contract, memberName: string | null) {
    if (!contract) {
      return null;
    }
    if (passesThrough(contract)) {
      return contract;
    }
    return soleAcrossOwners(contract, (owner) => {
      if (owner.flags & primitiveTypeFlags) {
        return null;
      }
      const property =
        memberName !== null &&
        this.#checker.getPropertyOfType(owner, memberName);
      if (property) {
        return this.#checker.getTypeOfSymbol(property);
      }
      return (
        this.#checker.getIndexTypeOfType(owner, ts.IndexKind.String) ??
        this.#checker.getIndexTypeOfType(owner, ts.IndexKind.Number) ??
        null
      );
    });
  }

  elementContract(contract: Contract) {
    if (!contract) {
      return null;
    }
    if (passesThrough(contract)) {
      return contract;
    }
    return soleAcrossOwners(contract, (owner) =>
      this.#checker.getIndexTypeOfType(owner, ts.IndexKind.Number)
    );
  }

  projectContract(contract: Contract, path: readonly string[] = []) {
    return path.reduce<Contract>(
      (current, step) =>
        step === ELEMENT
          ? this.elementContract(current)
          : this.memberContract(current, step),
      contract
    );
  }

  claimContract(
    contract: Contract,
    options: { readonly allowTypeParameter?: boolean } = {}
  ): ts.Type | null {
    if (!contract) {
      return null;
    }
    const core = stripNullish(contract);
    if (core.flags & ts.TypeFlags.TypeParameter) {
      const constraint = this.#checker.getBaseConstraintOfType(core);
      if (constraint && constraint !== core) {
        return this.claimContract(constraint, options);
      }
      return options.allowTypeParameter ? core : null;
    }
    return typed(contract, options) || unresolvedType(contract)
      ? contract
      : null;
  }

  #literalKeys(expression: ts.Node | undefined) {
    if (!expression) {
      return null;
    }
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
      return new Set([expression.text]);
    }
    const keyType = this.#checker.getTypeAtLocation(expression);
    const members = keyType.isUnion() ? keyType.types : [keyType];
    const literals = members.filter(
      (member) => member.isStringLiteral() || member.isNumberLiteral()
    );
    if (literals.length !== members.length) {
      return null;
    }
    return new Set(literals.map((member) => String(member.value)));
  }

  #literalText(expression: ts.Node | undefined) {
    const keys = this.#literalKeys(expression);
    return keys?.size === 1 ? ([...keys][0] ?? null) : null;
  }
}

export function contractProjection(checker: ts.TypeChecker) {
  const projection = new ContractProjection(checker);
  return {
    accessKey: projection.accessKey.bind(projection),
    accessKeys: projection.accessKeys.bind(projection),
    claimContract: projection.claimContract.bind(projection),
    elementContract: projection.elementContract.bind(projection),
    memberContract: projection.memberContract.bind(projection),
    projectContract: projection.projectContract.bind(projection),
    propertyKey: projection.propertyKey.bind(projection),
    propertyKeys: projection.propertyKeys.bind(projection),
  };
}

export type ContractProjections = ReturnType<typeof contractProjection>;
