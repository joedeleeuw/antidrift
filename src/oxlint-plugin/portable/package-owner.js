import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function packageOwner(filename) {
  let directory = dirname(resolve(filename));
  for (;;) {
    const manifestPath = resolve(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        typeof manifest.name === "string" ||
        [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
          "workspaces",
        ].some((key) => manifest[key] !== undefined)
      ) {
        return { directory, manifest };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
