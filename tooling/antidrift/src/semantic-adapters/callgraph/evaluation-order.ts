import ts from "typescript";
import { targetOf } from "../provenance/package-program.ts";
import { unwrapped, LITERAL_KINDS } from "../kernel/expression-wrappers.ts";

const PRIMITIVE_TYPES =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined;
const NULLISH_OR_UNKNOWN =
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown;
export type EvaluationStep = "immutable" | "read" | "effect";
export type EvaluationEntry =
  | {
      readonly slot: number;
      readonly node: ts.Node;
      readonly step?: undefined;
    }
  | {
      readonly step: EvaluationStep;
      readonly node: ts.Node;
      readonly slot?: undefined;
    };
const assignedSymbolSets = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.SourceFile, Set<ts.Symbol | undefined>>
>();
function assignmentTargets(target: ts.Node, found: ts.Identifier[]) {
  const node = unwrapped(target);
  if (ts.isIdentifier(node)) {
    found.push(node);
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      assignmentTargets(
        ts.isSpreadElement(element) ? element.expression : element,
        found
      );
    }
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        assignmentTargets(property.initializer, found);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        found.push(property.name);
      } else if (ts.isSpreadAssignment(property)) {
        assignmentTargets(property.expression, found);
      }
    }
  } else if (ts.isBinaryExpression(node)) {
    assignmentTargets(node.left, found);
  }
}
function isAssignmentOperator(kind: ts.SyntaxKind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}
function assignedSymbols(checker: ts.TypeChecker, sourceFile: ts.SourceFile) {
  const byFile =
    assignedSymbolSets.get(checker) ??
    new WeakMap<ts.SourceFile, Set<ts.Symbol | undefined>>();
  assignedSymbolSets.set(checker, byFile);
  const cached = byFile.get(sourceFile);
  if (cached) {
    return cached;
  }
  const targets: ts.Identifier[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind)
    ) {
      assignmentTargets(node.left, targets);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      assignmentTargets(node.operand, targets);
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      assignmentTargets(node.initializer, targets);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const symbols = new Set(
    targets.map((identifier) =>
      ts.isShorthandPropertyAssignment(identifier.parent)
        ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : checker.getSymbolAtLocation(identifier)
    )
  );
  byFile.set(sourceFile, symbols);
  return symbols;
}
function isNeverReassigned(checker: ts.TypeChecker, symbol: ts.Symbol) {
  const declaration = symbol.valueDeclaration;
  if (!declaration || declaration.getSourceFile().isDeclarationFile) {
    return false;
  }
  return !assignedSymbols(checker, declaration.getSourceFile()).has(symbol);
}
function stableBinding(checker: ts.TypeChecker, symbol: ts.Symbol | undefined) {
  if (!symbol) {
    return false;
  }
  const target = targetOf(checker, symbol);
  if (
    target.flags &
    (ts.SymbolFlags.Function |
      ts.SymbolFlags.Class |
      ts.SymbolFlags.Enum |
      ts.SymbolFlags.EnumMember |
      ts.SymbolFlags.ValueModule)
  ) {
    return true;
  }
  const declaration = target.valueDeclaration;
  if (!declaration) {
    return symbol.name === "undefined";
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
  ) {
    return true;
  }
  return (
    (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
    isNeverReassigned(checker, target)
  );
}
function typeHasFlag(type: ts.Type, flags: ts.TypeFlags) {
  return type.isUnion()
    ? type.types.some((member) => member.flags & flags)
    : Boolean(type.flags & flags);
}
function isPrimitive(checker: ts.TypeChecker, node: ts.Node) {
  const type = checker.getTypeAtLocation(node);
  return type.isUnion()
    ? type.types.every((member) => member.flags & PRIMITIVE_TYPES)
    : Boolean(type.flags & PRIMITIVE_TYPES);
}
function isConstAsserted(objectLiteral: ts.ObjectLiteralExpression) {
  let node: ts.Node = objectLiteral;
  while (
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.parent;
    if (ts.isAsExpression(node) && ts.isConstTypeReference(node.type)) {
      return true;
    }
  }
  return false;
}
function isImmutableDataField(declaration: ts.Declaration) {
  const modifiers = ts.getCombinedModifierFlags(declaration);
  if (ts.isPropertyDeclaration(declaration)) {
    return (
      ts.isClassLike(declaration.parent) &&
      Boolean(modifiers & ts.ModifierFlags.Readonly) &&
      !(modifiers & (ts.ModifierFlags.Abstract | ts.ModifierFlags.Accessor))
    );
  }
  return (
    (ts.isPropertyAssignment(declaration) ||
      ts.isShorthandPropertyAssignment(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
    ts.isObjectLiteralExpression(declaration.parent) &&
    isConstAsserted(declaration.parent)
  );
}
function memberStep(
  program: ts.Program,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression
): EvaluationStep {
  const checker = program.getTypeChecker();
  const object = checker.getTypeAtLocation(node.expression);
  if (typeHasFlag(object, NULLISH_OR_UNKNOWN)) {
    return "effect";
  }
  if (
    ts.isElementAccessExpression(node) &&
    !ts.isStringLiteralLike(node.argumentExpression) &&
    !ts.isNumericLiteral(node.argumentExpression)
  ) {
    return "effect";
  }
  const symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
  );
  const declarations = symbol?.declarations ?? [];
  const receiver = unwrapped(node.expression);
  const stableReceiver = ts.isIdentifier(receiver)
    ? stableBinding(checker, checker.getSymbolAtLocation(receiver))
    : (ts.isPropertyAccessExpression(receiver) ||
        ts.isElementAccessExpression(receiver)) &&
      memberStep(program, receiver) === "read";
  return declarations.length > 0 &&
    stableReceiver &&
    declarations.every(isImmutableDataField)
    ? "read"
    : "effect";
}
const STEP_RANK = { immutable: 0, read: 1, effect: 2 };
export function strongerStep(left: EvaluationStep, right: EvaluationStep) {
  return STEP_RANK[right] > STEP_RANK[left] ? right : left;
}
export function stepsCommute(
  preceding: EvaluationStep,
  following: EvaluationStep
) {
  return (
    preceding === "immutable" ||
    following === "immutable" ||
    (preceding === "read" && following === "read")
  );
}
function isImmutableNode(node: ts.Node) {
  return (
    (LITERAL_KINDS.has(node.kind) && !ts.isTemplateExpression(node)) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}
class EvaluationStepper {
  readonly #program: ts.Program;
  readonly #checker: ts.TypeChecker;
  readonly #parameterSymbols: readonly (ts.Symbol | undefined)[];
  readonly steps = { order: new Array<EvaluationEntry>(), modelled: true };
  constructor(
    program: ts.Program,
    parameterSymbols: readonly (ts.Symbol | undefined)[]
  ) {
    this.#program = program;
    this.#checker = program.getTypeChecker();
    this.#parameterSymbols = parameterSymbols;
  }
  name(node: ts.Identifier, symbol: ts.Symbol | undefined) {
    const index = this.#parameterSymbols.indexOf(symbol);
    if (index >= 0) {
      this.steps.order.push({ slot: index, node });
    } else {
      this.steps.order.push({
        step: stableBinding(this.#checker, symbol) ? "immutable" : "read",
        node,
      });
    }
  }
  spread(node: ts.SpreadElement | ts.SpreadAssignment) {
    this.visit(node.expression);
    this.steps.order.push({ step: "effect", node });
  }
  visitMember(node: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
    this.visit(node.expression);
    if (ts.isElementAccessExpression(node)) {
      this.visit(node.argumentExpression);
    }
    this.steps.order.push({ step: memberStep(this.#program, node), node });
  }
  visitCall(node: ts.CallExpression) {
    this.visit(node.expression);
    for (const argument of node.arguments) {
      if (ts.isSpreadElement(argument)) {
        this.spread(argument);
      } else {
        this.visit(argument);
      }
    }
    this.steps.order.push({ step: "effect", node });
  }
  visitTemplate(node: ts.TemplateExpression) {
    for (const span of node.templateSpans) {
      this.visit(span.expression);
      this.steps.order.push({
        step: isPrimitive(this.#checker, span.expression)
          ? "immutable"
          : "effect",
        node: span.expression,
      });
    }
  }
  visitArray(node: ts.ArrayLiteralExpression) {
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        this.spread(element);
      } else if (!ts.isOmittedExpression(element)) {
        this.visit(element);
      }
    }
  }
  visitProperty(property: ts.ObjectLiteralElementLike) {
    if (ts.isPropertyAssignment(property)) {
      if (ts.isComputedPropertyName(property.name)) {
        this.visit(property.name.expression);
      }
      this.visit(property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      this.name(
        property.name,
        this.#checker.getShorthandAssignmentValueSymbol(property)
      );
    } else if (ts.isSpreadAssignment(property)) {
      this.spread(property);
    } else {
      this.steps.order.push({ step: "immutable", node: property });
    }
  }
  visit(node: ts.Node): void {
    const expression = unwrapped(node);
    if (ts.isIdentifier(expression)) {
      this.name(expression, this.#checker.getSymbolAtLocation(expression));
    } else if (isImmutableNode(expression)) {
      this.steps.order.push({ step: "immutable", node: expression });
    } else if (
      (ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression)) &&
      !expression.questionDotToken
    ) {
      this.visitMember(expression);
    } else if (
      ts.isCallExpression(expression) &&
      !expression.questionDotToken
    ) {
      this.visitCall(expression);
    } else if (ts.isTemplateExpression(expression)) {
      this.visitTemplate(expression);
    } else if (ts.isArrayLiteralExpression(expression)) {
      this.visitArray(expression);
    } else if (ts.isObjectLiteralExpression(expression)) {
      expression.properties.forEach((property) => this.visitProperty(property));
    } else {
      this.steps.modelled = false;
      this.steps.order.push({ step: "effect", node: expression });
    }
  }
}
export function bodyEvaluationOrder(
  program: ts.Program,
  functionNode: ts.FunctionLikeDeclaration
) {
  const { body } = functionNode;
  const stepper = new EvaluationStepper(
    program,
    functionNode.parameters.map((parameter) =>
      program.getTypeChecker().getSymbolAtLocation(parameter.name)
    )
  );
  if (!body) {
    throw new TypeError("Hop function has no body");
  }
  const statement = ts.isBlock(body) ? body.statements[0] : undefined;
  const expression = ts.isBlock(body)
    ? statement &&
      (ts.isReturnStatement(statement) ||
        ts.isExpressionStatement(statement)) &&
      statement.expression
    : body;
  if (!expression) {
    throw new TypeError("Hop function body has no expression");
  }
  stepper.visit(expression);
  return stepper.steps;
}
export function argumentEffect(
  program: ts.Program,
  functionNode: ts.SignatureDeclaration,
  call: ts.CallExpression,
  index: number
) {
  const parameter = functionNode.parameters[index];
  if (!parameter) {
    throw new TypeError(`Hop parameter ${index} does not exist`);
  }
  const argumentsForSlot = parameter.dotDotDotToken
    ? call.arguments.slice(index)
    : call.arguments.slice(index, index + 1);
  let strongest: EvaluationStep = "immutable";
  for (const argument of argumentsForSlot) {
    const stepper = new EvaluationStepper(program, []);
    stepper.visit(argument);
    const effect: EvaluationStep = stepper.steps.modelled
      ? stepper.steps.order.reduce<EvaluationStep>(
          (current, entry) =>
            strongerStep(
              current,
              entry.slot === undefined ? entry.step : "immutable"
            ),
          "immutable"
        )
      : "effect";
    strongest = strongerStep(strongest, effect);
  }
  return strongest;
}
