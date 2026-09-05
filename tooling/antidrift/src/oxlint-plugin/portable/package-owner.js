import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function packageOwner(filename) {
  let directory = dirname(resolve(filename));
  for (;;) {
    const manifest = resolve(directory, "package.json");
    if (existsSync(manifest)) {
      const data = JSON.parse(readFileSync(manifest, "utf8"));
      if (
        typeof data.name === "string" ||
        [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
          "workspaces",
        ].some((key) => data[key] !== undefined)
      ) {
        return { directory, manifest: data };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
