import type ts from "typescript";
import type { BoundaryObserver } from "./boundary-observations.ts";
import type { ContractProjections } from "./boundary-contracts.ts";
import type { BoundaryDeclarations } from "./boundary-declarations.ts";
import type { boundarySources } from "./boundary-sources.ts";
import type { classReceivers } from "./class-receivers.ts";
import type { ContextualSources } from "./contextual-sources.ts";
import type { SignatureForwarding } from "./signature-forwarding.ts";
import type { RootOperations } from "./root-algebra.ts";
import type { AccessStep, Root } from "./root-domain.ts";

export type TraceCall =
  | ts.CallExpression
  | ts.NewExpression
  | ts.TaggedTemplateExpression;
export type TraceContext = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly observer: BoundaryObserver;
  readonly contracts: ContractProjections;
  readonly declarations: BoundaryDeclarations;
  readonly sources: ReturnType<typeof boundarySources>;
  readonly algebra: RootOperations;
  readonly contextualSources: ContextualSources;
  readonly forwarding: SignatureForwarding;
  readonly receivers: ReturnType<typeof classReceivers>;
  readonly summary: (declaration: ts.Node) => readonly Root[];
  readonly trace: (expression: ts.Node | undefined) => readonly Root[];
  readonly withClaim: (
    roots: readonly Root[],
    contract: ts.Type | null | undefined,
    node: ts.Node,
    options?: Parameters<ContractProjections["claimContract"]>[1]
  ) => readonly Root[];
  readonly accessStep: (
    expression: ts.Expression,
    keys: ReadonlySet<string> | null,
    elementKey: boolean,
    sourcesOf: () => readonly Root[]
  ) => AccessStep;
  readonly elementStep: (expression: ts.Node) => AccessStep;
  readonly projected: (
    roots: readonly Root[],
    step: AccessStep
  ) => readonly Root[];
  readonly resolveAll: (roots: readonly Root[]) => readonly Root[];
  readonly bindingRoots: (
    declaration: ts.Node,
    use: ts.Node
  ) => readonly Root[];
  readonly parameterRoots: (
    parameter: ts.ParameterDeclaration
  ) => readonly Root[];
  readonly incomingRoots: (
    parameter: ts.ParameterDeclaration
  ) => readonly Root[];
  readonly callArgumentsOf: (
    call: TraceCall
  ) => readonly (ts.Expression | null)[];
  readonly callRoots: (
    call: ts.CallExpression | ts.TaggedTemplateExpression
  ) => readonly Root[];
  readonly constructionRoots: (call: ts.NewExpression) => readonly Root[];
  readonly returnRoots: (
    declaration: ts.SignatureDeclaration
  ) => readonly Root[];
  readonly stringified: (roots: readonly Root[]) => readonly Root[];
  readonly concatenationRoots: (
    expression: ts.Node,
    operands: readonly ts.Expression[]
  ) => readonly Root[];
  readonly derivedThroughAssertion: (
    expression: ts.Expression | undefined,
    visited?: Set<ts.Node>
  ) => boolean;
};
export function memoizedRoots(compute: () => readonly Root[]) {
  let computed: readonly Root[] | undefined;
  return () => (computed ??= compute());
}
