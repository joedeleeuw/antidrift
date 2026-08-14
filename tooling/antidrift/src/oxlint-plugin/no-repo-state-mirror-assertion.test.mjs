import { rule, ruleTester } from "../../test/support/eslint-plugin-harness.mjs";

const options = [
  {
    sources: [
      { module: "lib/server/conf" },
      { module: "@murderbox/shared/model-registry", names: ["getChatModelMeta"] },
    ],
  },
];

ruleTester.run(
  "no-repo-state-mirror-assertion",
  rule("no-repo-state-mirror-assertion"),
  {
    valid: [
      {
        code: `
          import { parseThing } from "./fixtures/helpers";
          const parsed = parseThing("fixture.conf");
          expect(parsed.port).toBe(41001);
        `,
        options,
        filename: "example.test.ts",
      },
      {
        code: `
          import { getChatProfileManifest, getChatRuntimeProfiles } from "../lib/server/conf";
          const manifest = getChatProfileManifest();
          expect(getChatRuntimeProfiles().map((p) => p.id)).toEqual(
            manifest.map((entry) => entry.id)
          );
        `,
        options,
        filename: "example.test.ts",
      },
      {
        code: `
          import { getChatRuntimeProfiles } from "../lib/server/conf";
          const names = new Map();
          for (const profile of getChatRuntimeProfiles()) {
            expect(names.get(profile.name)).toBeUndefined();
            names.set(profile.name, profile.id);
          }
        `,
        options,
        filename: "example.test.ts",
      },
      {
        code: `
          import { getChatProfileManifest } from "../lib/server/conf";
          expect(getChatProfileManifest().length).toBeGreaterThan(0);
        `,
        options,
        filename: "example.test.ts",
      },
      {
        code: `
          import { getChatRuntimeProfile } from "../lib/server/conf";
          const profile = getChatRuntimeProfile("some-id");
          expect(profile).toEqual({ reason: expect.any(String), id: expect.any(String) });
        `,
        options,
        filename: "example.test.ts",
      },
      {
        code: `
          import { getChatModelMeta, otherHelper } from "@murderbox/shared/model-registry";
          const value = otherHelper("id");
          expect(value.title).toBe("Literal Title");
        `,
        options,
        filename: "example.test.ts",
      },
    ],
    invalid: [
      {
        code: `
          import { getChatProfileManifest } from "../lib/server/conf";
          expect(getChatProfileManifest()).toEqual([
            { id: "alpha", confFile: "model-alpha.conf", scope: "switchable" },
          ]);
        `,
        options,
        filename: "example.test.ts",
        errors: [{ messageId: "mirroredLiteral" }],
      },
      {
        code: `
          import { getChatRuntimeProfiles } from "../lib/server/conf";
          const profiles = getChatRuntimeProfiles();
          expect(
            profiles.find((candidate) => candidate.id === "some-id")?.resourceProfile
          ).toMatchObject({
            source: "config",
            selectedGpuIds: ["0", "1", "2"],
            reservedHostRamMiB: 4096,
          });
        `,
        options,
        filename: "example.test.ts",
        errors: [{ messageId: "mirroredLiteral" }],
      },
      {
        code: `
          import { getChatProfileManifest } from "../lib/server/conf";
          for (const entry of getChatProfileManifest()) {
            expect(entry.confFile).toBe("model-alpha.conf");
          }
        `,
        options,
        filename: "example.test.ts",
        errors: [{ messageId: "mirroredLiteral" }],
      },
      {
        code: `
          import { getChatRuntimeProfiles } from "../lib/server/conf";
          getChatRuntimeProfiles().map((profile) => {
            expect(profile.scope).toBe("lab");
          });
        `,
        options,
        filename: "example.test.ts",
        errors: [{ messageId: "mirroredLiteral" }],
      },
      {
        code: `
          import { getChatRuntimeProfile } from "../lib/server/conf";
          const profile = getChatRuntimeProfile("qwen-profile");
          expect(profile?.disabled).not.toBe(true);
        `,
        options,
        filename: "example.test.ts",
        errors: [{ messageId: "mirroredLiteral" }],
      },
      {
        code: `
          import { getChatProfileConf } from "../lib/server/conf";
          expect(getChatProfileConf("retired-id")).toBeNull();
        `,
        options,
        filename: "example.test.ts",
        errors: [{ messageId: "pinnedLookup" }],
      },
      {
        code: `
          import { getChatModelMeta } from "@murderbox/shared/model-registry";
          expect(getChatModelMeta("some-id")?.subtitle).toBe(
            "BF16 GGUF · draft-mtp · thinking off"
          );
        `,
        options,
        filename: "example.test.ts",
        errors: [{ messageId: "mirroredLiteral" }],
      },
    ],
  },
);
