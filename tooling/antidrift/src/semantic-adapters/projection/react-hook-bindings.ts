import { findVariable } from "../kernel/async-control-flow.ts";
import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  isSyntaxTypeIn,
  syntaxChildren,
  syntaxField,
} from "../kernel/syntax-node.ts";
import {
  bindingDefinitions,
  declaredVariables,
  variableName,
} from "../kernel/syntax-scope.ts";
import { importedName, memberName, unwrapCasts } from "./react-state-syntax.ts";

export type ReactHookName = "useRef" | "useState";

const REACT_OBJECT_SPECIFIER_TYPES = new Set([
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
]);

export class ReactHookBindings {
  readonly #sourceCode: unknown;
  readonly #objectBindings = new Set<object>();
  readonly #hookBindings = new Map<string, Set<object>>([
    ["useRef", new Set()],
    ["useState", new Set()],
  ]);

  constructor(sourceCode: unknown) {
    this.#sourceCode = sourceCode;
  }

  recordImport(declaration: unknown): void {
    if (
      !isSyntaxNode(declaration) ||
      syntaxField(syntaxField(declaration, "source"), "value") !== "react"
    ) {
      return;
    }
    const bindingsByName = new Map(
      declaredVariables(this.#sourceCode, declaration).map(
        (binding): [string | null, object] => [variableName(binding), binding]
      )
    );
    for (const specifier of syntaxChildren(declaration, "specifiers")) {
      const localName = identifierName(syntaxField(specifier, "local"));
      const binding = localName ? bindingsByName.get(localName) : undefined;
      if (!binding) {
        continue;
      }
      if (isSyntaxTypeIn(specifier, REACT_OBJECT_SPECIFIER_TYPES)) {
        this.#objectBindings.add(binding);
        continue;
      }
      this.#hookBindings.get(importedName(specifier))?.add(binding);
    }
  }

  isHookCallee(callee: unknown, hookName: ReactHookName): boolean {
    const unwrapped = unwrapCasts(callee);
    if (isSyntaxType(unwrapped, "Identifier")) {
      const binding = findVariable(this.#sourceCode, unwrapped);
      return Boolean(binding && this.#hookBindings.get(hookName)?.has(binding));
    }
    const binding = findVariable(
      this.#sourceCode,
      unwrapCasts(syntaxField(unwrapped, "object"))
    );
    return (
      isSyntaxType(unwrapped, "MemberExpression") &&
      memberName(unwrapped) === hookName &&
      binding !== null &&
      this.#objectBindings.has(binding)
    );
  }

  isGlobalFetchCall(callee: unknown): boolean {
    const isUnshadowedGlobal = (identifier: unknown, name: string) => {
      if (
        !isSyntaxType(identifier, "Identifier") ||
        identifierName(identifier) !== name
      ) {
        return false;
      }
      const binding = findVariable(this.#sourceCode, identifier);
      return !binding || bindingDefinitions(binding).length === 0;
    };
    if (isSyntaxType(callee, "Identifier")) {
      return isUnshadowedGlobal(callee, "fetch");
    }
    if (
      !isSyntaxType(callee, "MemberExpression") ||
      syntaxField(callee, "computed")
    ) {
      return false;
    }
    return (
      identifierName(syntaxField(callee, "property")) === "fetch" &&
      ["globalThis", "window", "self"].some((name) =>
        isUnshadowedGlobal(syntaxField(callee, "object"), name)
      )
    );
  }
}
