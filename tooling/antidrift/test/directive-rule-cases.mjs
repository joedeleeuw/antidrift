export const directiveRuleCases = [
  {
    name: "no-hash-literal",
    invalid: `const patchSha256 = "${"ab".repeat(32)}";`,
    valid: `const encryptionKey = "${"ab".repeat(32)}";`,
  },
  {
    name: "no-host-path-literal",
    filename: "scripts/trace.ts",
    invalid: 'const root = "/home/joe/code/app";',
    valid:
      'const root = join(homedir(), "code/app"); const brew = "/home/linuxbrew/.linuxbrew/bin";',
  },
  {
    name: "no-dated-comments",
    invalid: "// Verified against the live API on 2026-06-10.\nstart();",
    valid:
      "/**\n * @example\n * formatDay(new Date('2026-06-10'))\n */\nstart();",
  },
  {
    name: "no-else-if-chain",
    invalid:
      'if (mode === "a") run(1); else if (mode === "b") run(2); else if (mode === "c" || mode === "d") run(3); else if (mode === "e") run(4);',
    valid:
      'if (mode === "a") run(1); else if (kind === "b") run(2); else if (mode === "c") run(3); else if (mode === "e") run(4);',
  },
  {
    name: "no-fallback-to-empty",
    invalid:
      "async function load() { try { return await read(); } catch { return []; } }",
    valid:
      "async function load() { try { return await read(); } catch (error) { throw new LoadError({ cause: error }); } }",
  },
];
