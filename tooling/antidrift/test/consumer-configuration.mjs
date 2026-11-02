import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  run,
  runJson,
  runGeneratedHook,
  file,
  fail,
  work,
  pnpmLaunch,
} from "./consumer-process.mjs";

export function proveGeneratedHook() {
  file(
    "policy/agent-guardrails.yaml",
    "version: 1\nmeta:\n  never: []\nclusters: []\n"
  );
  run(
    pnpmLaunch.file,
    [...pnpmLaunch.prefix, "exec", "antidrift", "generate"],
    work
  );
  const settings = JSON.parse(
    readFileSync(join(work, ".claude/settings.json"), "utf8")
  );
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const blocked = runGeneratedHook(command, {
    tool_input: { file_path: "CLAUDE.md" },
  });
  if (blocked.status !== 2 || !blocked.stderr.includes("Blocked edit")) {
    fail(
      `generated hook \`${command}\` should block an edit to CLAUDE.md with exit 2, got exit ${blocked.status}: ${blocked.stdout}${blocked.stderr}`
    );
  }
  const allowed = runGeneratedHook(command, {
    tool_input: { file_path: "CLAUDE.md" },
    prompt: "[policy-change] regenerate",
  });
  if (allowed.status !== 0) {
    fail(
      `generated hook \`${command}\` should allow a [policy-change] edit, got exit ${allowed.status}: ${allowed.stderr}`
    );
  }
}

const EXPECTED_CONFIGURED_RULES = {
  "configured/cast.ts": ["antidrift(no-as-never) warning"],
  "configured/sub/cast.ts": [],
  "configured/shapes.d.ts": [
    "antidrift(no-tutorial-comments) error",
    "antidrift(no-tutorial-comments) error",
  ],
  "configured/card.tsx": ["antidrift(react-max-component-props) error"],
  "configured/exempt-card.tsx": [],
  "apps/client/convex/tasks.ts": [
    "antidrift(require-convex-return-validator) error",
  ],
  "apps/client/src/non-convex-query.ts": [],
  "apps/client/src/tw/index.tsx": [],
  "apps/client/src/screen.tsx": ["eslint(no-restricted-imports) error"],
  "domain/entity.ts": ["import(no-default-export) error"],
  "domain/cross-layer.ts": ["boundaries(element-types) error"],
  "domain/migrations/001_init.ts": [],
};

export function proveConfiguredRules() {
  const config = "oxlint.configured.config.mjs";
  const rows = (relFile) =>
    (lintAntidriftOxlint(relFile, config).diagnostics ?? []).map(
      ({ code, severity }) => `${code} ${severity}`
    );
  const observed = Object.fromEntries(
    Object.keys(EXPECTED_CONFIGURED_RULES).map((relFile) => [
      relFile,
      rows(relFile),
    ])
  );
  if (JSON.stringify(observed) !== JSON.stringify(EXPECTED_CONFIGURED_RULES)) {
    fail(
      `the installed package must honor per-rule severity, override globs, rule options, per-file off and a declaration file the config stops ignoring through the Oxlint config, got: ${JSON.stringify(observed)}`
    );
  }
  console.log(
    "  configured rules: severity, glob, options and per-file off honored"
  );
}

export function lintOxlint(relFile, config) {
  try {
    return runJson(
      pnpmLaunch.file,
      [
        ...pnpmLaunch.prefix,
        "exec",
        "oxlint",
        relFile,
        "--format",
        "json",
        "--config",
        config,
        "--tsconfig",
        "tsconfig.bundler.json",
      ],
      work
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

function lintAntidriftOxlint(relFile, config) {
  try {
    return runJson(
      pnpmLaunch.file,
      [
        ...pnpmLaunch.prefix,
        "exec",
        "antidrift",
        "oxlint",
        relFile,
        "--",
        "--format",
        "json",
        "--config",
        config,
        "--tsconfig",
        "tsconfig.bundler.json",
      ],
      work
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

export function lintOxlintRepository() {
  try {
    return runJson(
      pnpmLaunch.file,
      [
        ...pnpmLaunch.prefix,
        "exec",
        "antidrift",
        "oxlint",
        "--",
        "--format",
        "json",
        "--config",
        "oxlint.config.mjs",
      ],
      work
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

function oxlintRuleIds(output) {
  return (output.diagnostics ?? []).map(({ code }) => {
    const match = /^([^()]+)\(([^()]+)\)$/u.exec(code ?? "");
    return match ? `${match[1]}/${match[2]}` : code;
  });
}

export function proveReactNativePolicy() {
  const unconfiguredTouchableRules = oxlintRuleIds(
    lintOxlint("portable-proofs/raw-touchable.tsx", "oxlint.config.mjs")
  );
  if (unconfiguredTouchableRules.includes("eslint/no-restricted-imports")) {
    fail(
      "React Native restrictions must be opt-in when no interaction owner is configured"
    );
  }
  const configuredTouchableOutput = lintOxlint(
    "portable-proofs/raw-touchable.tsx",
    "oxlint.react-native.config.mjs"
  );
  const configuredTouchableRules = oxlintRuleIds(configuredTouchableOutput);
  if (!configuredTouchableRules.includes("eslint/no-restricted-imports")) {
    fail("Configured React Native policy must reject a raw Pressable import");
  }
  const restrictedMessages = (configuredTouchableOutput.diagnostics ?? []).map(
    ({ message }) => message
  );
  for (const expected of [
    "'default' import",
    "* import is invalid",
    "'TouchableOpacity' import",
  ]) {
    if (!restrictedMessages.some((message) => message.includes(expected))) {
      fail(
        `React Native restrictions must cover default, namespace and re-export forms; missing ${expected}: ${JSON.stringify(restrictedMessages)}`
      );
    }
  }
  proveAllowedReactNativeImports();
}

function proveAllowedReactNativeImports() {
  for (const allowed of [
    "portable-proofs/tw/index.tsx",
    "portable-proofs/type-only-touchable.tsx",
  ]) {
    if (
      oxlintRuleIds(
        lintOxlint(allowed, "oxlint.react-native.config.mjs")
      ).includes("eslint/no-restricted-imports")
    ) {
      fail(
        `React Native owner and type-only imports must stay clean: ${allowed}`
      );
    }
  }
}

export function proveFallbackPolicy() {
  const fallbackConfig = "nested/oxlint.fallback.config.mjs";
  const fallbackOutput = lintAntidriftOxlint(
    "portable-proofs/fallback.ts",
    fallbackConfig
  );
  const fallbackRules = oxlintRuleIds(fallbackOutput);
  const hostPathDiagnostics = (fallbackOutput.diagnostics ?? []).filter(
    ({ message }) => message.includes("Host-absolute path literal")
  );
  if (
    !fallbackRules.includes("@rikalabs/no-property-default-fallbacks") ||
    !fallbackRules.includes("antidrift/no-host-path-literal") ||
    hostPathDiagnostics.length !== 2
  ) {
    fail(
      `Fallback opt-in must enforce Rika defaults and both host-path literal forms, got: ${JSON.stringify(fallbackOutput.diagnostics)}`
    );
  }
  if (!fallbackRules.includes("antidrift/no-sentinel-absence-fallback")) {
    fail("Template-literal sentinels must remain covered when Rika is enabled");
  }
  const allowedFallbackRules = oxlintRuleIds(
    lintAntidriftOxlint("portable-proofs/allowed-fallback.ts", fallbackConfig)
  );
  if (
    allowedFallbackRules.includes("@rikalabs/no-property-default-fallbacks") ||
    allowedFallbackRules.includes("antidrift/no-host-path-literal")
  ) {
    fail(
      `Nested config must honor repo-relative fallback exceptions, got: ${JSON.stringify(allowedFallbackRules)}`
    );
  }
}

export function proveRulePrecedence() {
  const composedRuleIds = oxlintRuleIds(
    lintOxlint("precedence-proof.ts", "oxlint.config.mjs")
  );
  const precedenceRuleIds = oxlintRuleIds(
    lintOxlint("precedence-proof.ts", "oxlint.precedence.config.mjs")
  );
  if (
    !composedRuleIds.includes("eslint/no-nested-ternary") ||
    precedenceRuleIds.includes("eslint/no-nested-ternary")
  ) {
    fail(
      `consumer rules composed after tooling and governance must win, got: ${JSON.stringify({ composedRuleIds, precedenceRuleIds })}`
    );
  }
}
