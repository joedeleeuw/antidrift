import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { expect, it } from "vitest";
import YAML from "yaml";

import {
  fixture,
  fixturesDir,
  plugin,
} from "../../test/support/eslint-plugin-harness.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const semanticFactKinds = YAML.parse(
  readFileSync(resolve(repoRoot, "policy/registries/rules.yaml"), "utf8"),
).semanticFactKinds;

function expectFactMatchesRegistry(fact) {
  const entry = semanticFactKinds[fact.factKind];
  expect(entry).toBeDefined();
  expect(entry.rules).toContain(fact.ruleId);
  expect(fact.adapterId).toBe(entry.adapterId);
  expect(entry.confidence).toContain(fact.confidence);
  for (const field of entry.payloadFields) {
    expect(fact.payload).toHaveProperty(field);
  }
}

const generatedStructuralOptions = {
  generatedSources: {
    fixtureGenerated: {
      generated: "programs/generated",
    },
  },
};

const acceptedPackageStructuralOptions = {
  packageTypeOwners: {
    firebaseAuthUserInfo: {
      package: "@firebase/auth",
      exportName: "UserInfo",
      reason: "Firebase Auth UserInfo is the accepted auth user info contract.",
    },
  },
};

async function lintWithStructuralFacts(file, ruleOptions = {}) {
  const facts = [];
  const drift = fixture(file);
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            projectService: {
              allowDefaultProject: ["*.ts", "*.tsx"],
              defaultProject: resolve(fixturesDir, "tsconfig.json"),
            },
            tsconfigRootDir: fixturesDir,
          },
        },
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-structural-type-fork": ["error", ruleOptions],
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(drift.code, {
    filePath: drift.filename,
  });
  return { facts, result };
}

async function lintIdentityTransformWithFacts(file) {
  const facts = [];
  const drift = fixture(file);
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            projectService: {
              allowDefaultProject: ["*.ts", "*.tsx"],
              defaultProject: resolve(fixturesDir, "tsconfig.json"),
            },
            tsconfigRootDir: fixturesDir,
          },
        },
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-identity-schema-transform": "error",
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(drift.code, {
    filePath: drift.filename,
  });
  return { facts, result };
}

it("emits an identity-schema-transform fact from the reported proof", async () => {
  const { facts, result } = await lintIdentityTransformWithFacts(
    "programs/drift/identity-schema-transform-reconstruction.ts",
  );

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual([
    expect.objectContaining({
      factKind: "identitySchemaTransform",
      ruleId: "antidrift/no-identity-schema-transform",
      adapterId: "typescript-eslint/schema-provenance",
      confidence: "deterministic-enforcement",
      provenance: ["AST", "TypeChecker"],
      payload: {
        diagnostic: {
          emitted: true,
          messageId: "identitySchemaTransform",
        },
        inputShape: { keys: ["a", "b"] },
        outputShape: { keys: ["a", "b"] },
        transform: {
          parameterStyle: "identifier",
          relation: "identity-object-reconstruction",
          returnStyle: "implicit",
        },
      },
    }),
  ]);
  expectFactMatchesRegistry(facts[0]);
});

it("emits structural proposal facts for unaccepted installed-package matches", async () => {
  const { facts, result } = await lintWithStructuralFacts(
    "programs/drift/redeclares-full.ts",
  );

  expect(result.messages).toEqual([]);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "structuralMatch",
        ruleId: "antidrift/no-structural-type-fork",
        adapterId: "typescript-eslint/type-owner",
        confidence: "deterministic-inventory",
        provenance: expect.arrayContaining(["AST", "TypeChecker"]),
        payload: expect.objectContaining({
          authorityState: "proposal",
          localType: expect.objectContaining({ name: "UserInfo" }),
          ownerType: expect.objectContaining({
            label: expect.stringContaining("#"),
          }),
          structuralMatch: expect.objectContaining({
            relation: "exact-owner-copy",
          }),
          diagnostic: expect.objectContaining({
            emitted: false,
          }),
        }),
      }),
    ]),
  );
});

it("emits blocking structural facts from accepted generated owners with stable ids", async () => {
  const first = await lintWithStructuralFacts(
    "programs/drift/generated-release-fork.ts",
    generatedStructuralOptions,
  );
  const second = await lintWithStructuralFacts(
    "programs/drift/generated-release-fork.ts",
    generatedStructuralOptions,
  );

  expect(first.result.messages).toHaveLength(1);
  expect(second.result.messages).toHaveLength(1);
  expect(first.facts.map((fact) => fact.factId)).toEqual(
    second.facts.map((fact) => fact.factId),
  );
  expect(first.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          authorityState: "accepted",
          localType: expect.objectContaining({ name: "ReleaseRow" }),
          ownerType: expect.objectContaining({
            label: "fixtureGenerated#GeneratedRelease",
            authority: "generated-source",
          }),
          diagnostic: expect.objectContaining({
            emitted: true,
            messageId: "structuralTypeFork",
          }),
        }),
      }),
    ]),
  );
});

it("emits blocking structural facts from accepted package owners", async () => {
  const { facts, result } = await lintWithStructuralFacts(
    "programs/drift/redeclares-full.ts",
    acceptedPackageStructuralOptions,
  );

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          authorityState: "accepted",
          localType: expect.objectContaining({ name: "UserInfo" }),
          ownerType: expect.objectContaining({
            label: "@firebase/auth#UserInfo",
            authority: "installed-package",
          }),
          diagnostic: expect.objectContaining({
            emitted: true,
            messageId: "structuralTypeFork",
          }),
        }),
      }),
    ]),
  );
});

async function lintCoupledStateProgramWithFacts(program, options = {}) {
  const facts = [];
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            projectService: {
              allowDefaultProject: ["*.ts", "*.tsx"],
              defaultProject: resolve(fixturesDir, "tsconfig.json"),
            },
            tsconfigRootDir: fixturesDir,
          },
        },
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-handrolled-resource-lifecycle-cells": [
            "error",
            options,
          ],
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(program.code, {
    filePath: program.filename,
  });
  return { facts, result };
}

async function lintWithCoupledStateFacts(file, options = {}) {
  return lintCoupledStateProgramWithFacts(fixture(file), options);
}

async function lintCoupledStateCodeWithFacts(code, options = {}) {
  return lintCoupledStateProgramWithFacts(
    {
      code,
      filename: resolve(fixturesDir, "coupled-state.ts"),
    },
    options,
  );
}

async function lintSourceShardWithFacts(code, options = {}) {
  const facts = [];
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            projectService: {
              allowDefaultProject: ["*.ts", "*.tsx"],
              defaultProject: resolve(fixturesDir, "tsconfig.json"),
            },
            tsconfigRootDir: fixturesDir,
          },
        },
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-shattered-ingested-entity-state": ["error", options],
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(code, {
    filePath: resolve(fixturesDir, "source-shard.tsx"),
  });
  return { facts, result };
}

it("emits a deterministic-enforcement lifecycle fact and diagnostic from one proof, with stable ids", async () => {
  const first = await lintWithCoupledStateFacts(
    "programs/drift/handrolled-resource-lifecycle.ts",
  );
  const second = await lintWithCoupledStateFacts(
    "programs/drift/handrolled-resource-lifecycle.ts",
  );

  expect(first.result.messages).toHaveLength(1);
  expect(first.facts.map((fact) => fact.factId)).toEqual(
    second.facts.map((fact) => fact.factId),
  );
  expect(first.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
        adapterId: "react-state",
        confidence: "deterministic-enforcement",
        provenance: expect.arrayContaining([
          "AST",
          "control-flow",
          "scope-binding",
        ]),
        payload: expect.objectContaining({
          boolCell: "setPending",
          errorCell: "setFailure",
          payloadCell: "setUsers",
        }),
      }),
    ]),
  );
});

it("keeps sibling payload setters inventory-only under an aggressive threshold", async () => {
  const { facts, result } = await lintWithCoupledStateFacts(
    "programs/correct/sibling-payload-setters.ts",
    { threshold: 2 },
  );

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ setterCount: 2 }),
      }),
    ]),
  );
});

it("proves lifecycle from derived catch writes and awaited source-member payloads", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function fetchRows(): Promise<{ rows: string[] }>;
    declare function codeFrom(error: unknown): string;

    function RowsPanel() {
      const [rows, setRows] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [errorCode, setErrorCode] = useState("");

      return async function load() {
        setPending(true);
        try {
          const response = await fetchRows();
          setRows(response.rows);
        } catch (err) {
          setErrorCode(codeFrom(err));
        } finally {
          setPending(false);
        }
      };
    }

    void RowsPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          boolCell: "setPending",
          errorCell: "setErrorCode",
          payloadCell: "setRows",
        }),
      }),
    ]),
  );
});

it("ignores local useState impostors for React-state facts", async () => {
  const lifecycle = await lintCoupledStateCodeWithFacts(`
    function useState<T>(value: T): [T, (value: T) => void] {
      return [value, () => undefined];
    }
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);
  const sourceShard = await lintSourceShardWithFacts(`
    function useState<T>(value: T): [T, (value: T) => void] {
      return [value, () => undefined];
    }
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(lifecycle.result.messages).toHaveLength(0);
  expect(sourceShard.result.messages).toHaveLength(0);
  expect(lifecycle.facts).toHaveLength(0);
  expect(sourceShard.facts).toHaveLength(0);
});

it("ignores imported useState when a local binding shadows it for React-state facts", async () => {
  const lifecycle = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      function useState<T>(value: T): [T, (value: T) => void] {
        return [value, () => undefined];
      }
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);
  const sourceShard = await lintSourceShardWithFacts(`
    import { useState } from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      function useState<T>(value: T): [T, (value: T) => void] {
        return [value, () => undefined];
      }
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(lifecycle.result.messages).toHaveLength(0);
  expect(sourceShard.result.messages).toHaveLength(0);
  expect(lifecycle.facts).toHaveLength(0);
  expect(sourceShard.facts).toHaveLength(0);
});

it("ignores imported React objects when a local binding shadows them for React-state facts", async () => {
  const lifecycle = await lintCoupledStateCodeWithFacts(`
    import * as React from "react";
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      const React = {
        useState<T>(value: T): [T, (value: T) => void] {
          return [value, () => undefined];
        },
      };
      const [users, setUsers] = React.useState<string[]>([]);
      const [pending, setPending] = React.useState(false);
      const [failure, setFailure] = React.useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);
  const sourceShard = await lintSourceShardWithFacts(`
    import React from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const React = {
        useState<T>(value: T): [T, (value: T) => void] {
          return [value, () => undefined];
        },
      };
      const [id, setId] = React.useState("");
      const [name, setName] = React.useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(lifecycle.result.messages).toHaveLength(0);
  expect(sourceShard.result.messages).toHaveLength(0);
  expect(lifecycle.facts).toHaveLength(0);
  expect(sourceShard.facts).toHaveLength(0);
});

it("downgrades a request-guarded lifecycle to heuristic-inventory with no diagnostic", async () => {
  const { facts, result } = await lintWithCoupledStateFacts(
    "programs/correct/abort-guarded-fetch.ts",
  );

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ requestGuard: true }),
      }),
    ]),
  );
});

it("downgrades a lifecycle when the payload write is inside a positive abort-status guard", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function loadUsers(signal: AbortSignal): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        const controller = new AbortController();
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers(controller.signal);
          if (!controller.signal.aborted) {
            setUsers(result);
          }
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ requestGuard: true }),
      }),
    ]),
  );
});

it("does not downgrade lifecycle proof when the abort check follows the payload setter", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function loadUsers(signal: AbortSignal): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        const controller = new AbortController();
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers(controller.signal);
          setUsers(result);
          if (controller.signal.aborted) return;
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          payloadCell: "setUsers",
          requestGuard: false,
        }),
      }),
    ]),
  );
});

it("does not downgrade lifecycle proof for abort calls without an abort status gate", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function loadUsers(signal: AbortSignal): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        const controller = new AbortController();
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers(controller.signal);
          controller.abort();
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          payloadCell: "setUsers",
          requestGuard: false,
        }),
      }),
    ]),
  );
});

it("does not downgrade lifecycle proof for unrelated abort-shaped members", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare const request: { aborted: boolean };
    declare const fake: { abort(): void; signal: { aborted: boolean } };
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          if (request.aborted) return;
          fake.abort();
          if (fake.signal.aborted) return;
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          boolCell: "setPending",
          errorCell: "setFailure",
          payloadCell: "setUsers",
          requestGuard: false,
        }),
      }),
    ]),
  );
});

it("downgrades a useRef AbortController lifecycle to heuristic-inventory with no diagnostic", async () => {
  const { facts, result } = await lintWithCoupledStateFacts(
    "programs/correct/abort-guarded-component-scope.ts",
  );

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ requestGuard: true }),
      }),
    ]),
  );
});

it("emits a source-member shard candidate fact (inventory-only, no diagnostic)", async () => {
  const { facts, result } = await lintSourceShardWithFacts(`
    import { useState } from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(result.messages).toEqual([]);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "sourceMemberStateShardCandidate",
        ruleId: "antidrift/no-shattered-ingested-entity-state",
        adapterId: "react-state",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({
          source: "profile",
          editableCells: [],
          members: expect.arrayContaining([
            { setter: "setId", cell: "id", property: "id" },
            { setter: "setName", cell: "name", property: "displayName" },
          ]),
        }),
      }),
    ]),
  );
});

it("emits semantic facts that satisfy the registered public payload contract", async () => {
  const identityTransform = await lintIdentityTransformWithFacts(
    "programs/drift/identity-schema-transform-reconstruction.ts",
  );
  const structural = await lintWithStructuralFacts(
    "programs/drift/redeclares-full.ts",
  );
  const lifecycle = await lintWithCoupledStateFacts(
    "programs/drift/handrolled-resource-lifecycle.ts",
  );
  const inventory = await lintWithCoupledStateFacts(
    "programs/correct/sibling-payload-setters.ts",
    { threshold: 2 },
  );
  const sourceShardCandidate = await lintSourceShardWithFacts(`
    import { useState } from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);
  const facts = [
    ...identityTransform.facts,
    ...structural.facts,
    ...lifecycle.facts,
    ...inventory.facts,
    ...sourceShardCandidate.facts,
  ];

  const pluginEmittedKinds = Object.entries(semanticFactKinds)
    .filter(([, contract]) => (contract.rules?.length ?? 0) > 0)
    .map(([kind]) => kind);
  expect(facts.map((fact) => fact.factKind)).toEqual(
    expect.arrayContaining(pluginEmittedKinds),
  );
  for (const fact of facts) {
    expectFactMatchesRegistry(fact);
  }
});
