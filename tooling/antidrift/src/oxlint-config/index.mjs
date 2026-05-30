// Self-contained Oxlint baseline — the fast first lint tier. Owned explicitly; no external
// personal configs. The policy generator serializes this object to `.oxlintrc.json`, which Oxlint
// auto-discovers; `oxlint . --deny-warnings` enforces it. ESLint layers the type-aware bespoke
// rules on top. Every rule here is a native Oxlint rule (no JS plugins), so it runs at full speed.
export default {
  ignorePatterns: ["**/dist/**", "**/coverage/**", "reports/**", "docs/examples/**", "**/fixtures/**"],
  plugins: ["typescript", "unicorn", "vitest", "react"],
  rules: {
    // Type escape hatches are the most common agent shortcut.
    "typescript/no-explicit-any": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-extra-non-null-assertion": "error",
    "typescript/no-non-null-asserted-optional-chain": "error",
    "typescript/no-unsafe-function-type": "error",
    "typescript/no-wrapper-object-types": "error",
    "typescript/no-misused-new": "error",
    "typescript/no-unsafe-declaration-merging": "error",
    "typescript/no-duplicate-enum-values": "error",
    "typescript/prefer-as-const": "error",

    // Production debris is failed output, not review feedback.
    "no-console": "error",
    "no-debugger": "error",
    "no-array-constructor": "error",
    "no-warning-comments": ["error", { "terms": ["@nocommit", "FIXME"], "location": "anywhere" }],

    // Focused tests silently green a suite.
    "vitest/no-focused-tests": "error",

    // React correctness TypeScript can't see: missing keys, dropped duplicate props,
    // dangerouslySetInnerHTML clobbering children, target=_blank without rel=noopener.
    "react/jsx-key": "error",
    "react/jsx-no-target-blank": "error",
    "react/jsx-no-duplicate-props": "error",
    "react/no-danger-with-children": "error",
    "react/no-unknown-property": "error",
    "react/no-children-prop": "error",
    "react/jsx-no-undef": "error",
    "react/jsx-no-comment-textnodes": "error",

    // Disables must name a rule; prefer node: protocol and structuredClone over the workarounds.
    "unicorn/no-abusive-eslint-disable": "error",
    "unicorn/prefer-node-protocol": "error",
    "unicorn/prefer-structured-clone": "error",

    // Braces when a control body spans multiple lines — kills the dangling-if footgun
    // (a second indented statement that looks guarded but isn't) without touching clean
    // single-line guards like `if (!x) return;`.
    "curly": ["error", "multi-line"],
  },
  overrides: [
    {
      // CLI tooling and tests legitimately write to the console.
      files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "tooling/**"],
      rules: { "no-console": "off" },
    },
  ],
};
