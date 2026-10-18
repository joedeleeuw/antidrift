import type ts from "typescript";

import { ELEMENT } from "./boundary-contracts.ts";
import { boundaryObservations } from "./boundary-observations.ts";
import type { DecodeEvidence } from "./decoder-forms.ts";

export const FIELD_DEPTH = boundaryObservations.bounds.fieldDepth.limit;

export type RootClaim = {
  readonly contract: ts.Type | null | undefined;
  readonly node: ts.Node;
  readonly afterAccess?: number | undefined;
};

type PendingCarrier = Extract<DecodeEvidence, { readonly carrier: unknown }>;

type RootMarks = {
  readonly opaque?: boolean | undefined;
  readonly decoded?: boolean | undefined;
  readonly pending?: PendingCarrier | undefined;
  readonly activation?: string | undefined;
  readonly castChain?: boolean | undefined;
  readonly incomplete?: string | undefined;
};

type PlaceholderFlags = RootMarks & { readonly root?: ts.Node };

export type RootFlags = PlaceholderFlags & {
  readonly path?: readonly string[] | undefined;
  readonly overrides?: ReadonlySet<string> | undefined;
  readonly claim?: RootClaim | undefined;
};

export type AccessStep = {
  readonly keys: ReadonlySet<string> | null;
  readonly elementKey: boolean;
  readonly receiverType: ts.Type;
  readonly assertionDerived: () => boolean;
  readonly at: string;
  readonly sources: () => readonly Root[];
};

export type RootCapture = {
  readonly kind: string;
  readonly call: ts.Node;
  readonly declaration: ts.Node | null;
  readonly opaque: boolean;
  readonly whenEmpty: () => readonly Root[];
};

export type ConcreteRoot = RootMarks & {
  readonly kind: string;
  readonly root: ts.Node;
  readonly declaration: ts.Node | null;
  readonly upstream?: Root | undefined;
  readonly path?: readonly string[] | undefined;
  readonly deep?: boolean | undefined;
  readonly overrides?: ReadonlySet<string> | undefined;
  readonly claim?: RootClaim | null | undefined;
  readonly parameter?: undefined;
};

export type PlaceholderRoot = {
  readonly parameter: ts.ParameterDeclaration;
  readonly access: readonly AccessStep[];
  readonly deepAccess: boolean;
  readonly filter: string | null;
  readonly captures: readonly RootCapture[];
  readonly claim: RootClaim | null | undefined;
  readonly flags: PlaceholderFlags;
  readonly overrides: ReadonlySet<string> | undefined;
  readonly path: readonly string[];
  readonly deep: boolean;
};

export type Root = ConcreteRoot | PlaceholderRoot;

export function nodeKey(node: ts.Node | null | undefined): string {
  if (!node) {
    return "";
  }
  return `${node.getSourceFile().fileName}:${node.pos}:${node.end}`;
}

function claimKey(claim: RootClaim | null | undefined): string {
  if (claim === null) {
    return "cleared";
  }
  if (!claim) {
    return "";
  }
  return `${claim.contract ? "claimed" : "unresolved"}@${claim.afterAccess ?? ""}`;
}

function setKey(keys: ReadonlySet<string> | null | undefined): string {
  return keys ? [...keys].sort().join(",") : "";
}

export function stepKey(step: AccessStep): string {
  const base = step.elementKey && !step.keys ? ELEMENT : setKey(step.keys);
  return step.sources().length ? `${base}@${step.at}` : base;
}

function flagsKey(flags: PlaceholderFlags): string {
  const entries = new Map(Object.entries(flags));
  return [...entries.keys()]
    .sort()
    .map((name) => {
      const flag = entries.get(name);
      if (flag === undefined) {
        return `${name}=`;
      }
      if (typeof flag === "object") {
        return `${name}=${"call" in flag ? nodeKey(flag.call) : nodeKey(flag)}`;
      }
      return `${name}=${String(flag)}`;
    })
    .join(";");
}

function captureKey(capture: RootCapture): string {
  return `${capture.kind}@${nodeKey(capture.call)}:${capture.opaque}`;
}

function rootKey(root: Root): string {
  const shared = [
    (root.path ?? []).join("/"),
    root.deep ? "deep" : "",
    setKey(root.overrides),
    claimKey(root.claim),
  ].join("|");
  if (root.parameter) {
    return [
      "placeholder",
      nodeKey(root.parameter),
      root.access.map(stepKey).join(">"),
      root.deepAccess ? "deepAccess" : "",
      root.filter ?? "",
      root.captures.map(captureKey).join(">"),
      flagsKey(root.flags),
      shared,
    ].join("|");
  }
  return [
    root.kind,
    nodeKey(root.root),
    nodeKey(root.declaration),
    root.opaque ? "opaque" : "",
    root.decoded ? "decoded" : "",
    root.pending ? nodeKey(root.pending.call) : "",
    root.activation ?? "",
    root.castChain ? "castChain" : "",
    root.incomplete ?? "",
    shared,
  ].join("|");
}

export function dedupe<Candidate extends Root>(
  roots: readonly Candidate[]
): Candidate[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = rootKey(root);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function sameRoots(
  left: readonly Root[],
  right: readonly Root[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightKeys = new Set(right.map(rootKey));
  return left.every((root) => rightKeys.has(rootKey(root)));
}

export function placeholder(
  parameter: ts.ParameterDeclaration,
  claim: RootClaim | undefined
): PlaceholderRoot {
  return {
    parameter,
    access: [],
    deepAccess: false,
    filter: null,
    captures: [],
    claim: claim ? { ...claim, afterAccess: 0 } : undefined,
    flags: {},
    overrides: undefined,
    path: [],
    deep: false,
  };
}

export function unknownProvenance(
  expression: ts.Node,
  cause: string
): ConcreteRoot[] {
  return [
    {
      kind: "unresolved-provenance",
      root: expression,
      declaration: null,
      opaque: true,
      incomplete: cause,
    },
  ];
}
