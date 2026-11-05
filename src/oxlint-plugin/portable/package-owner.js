import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const packageOwnerByDir = new Map();

export function packageOwner(filename) {
  let directory = dirname(resolve(filename));
  const visited = [];
  for (;;) {
    if (packageOwnerByDir.has(directory)) {
      const cached = packageOwnerByDir.get(directory);
      for (const seen of visited) packageOwnerByDir.set(seen, cached);
      return cached;
    }
    visited.push(directory);
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
        const owner = { directory, manifest };
        for (const seen of visited) packageOwnerByDir.set(seen, owner);
        return owner;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      for (const seen of visited) packageOwnerByDir.set(seen, null);
      return null;
    }
    directory = parent;
  }
}
