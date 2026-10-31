import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const RESOLVE_DEADLINE_MS = 15 * 60_000;
const RESOLVE_POLL_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const tarballPaths = process.argv.slice(2);
if (tarballPaths.length === 0) {
  throw new Error("usage: publish-tarball.mjs <tarball.tgz>...");
}

function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function npmView(spec, field) {
  const viewed = spawnSync("npm", ["view", spec, field], { encoding: "utf8" });
  if (viewed.status === 0) {
    return { kind: "found", value: viewed.stdout.trim() };
  }
  if (viewed.stderr.includes("E404")) {
    return { kind: "missing", reason: `${spec} is not on npm yet` };
  }
  return {
    kind: "failed",
    reason: `npm view ${spec} ${field} failed: ${viewed.stderr}`,
  };
}

const releases = tarballPaths.map((tarballPath) => {
  const manifest = JSON.parse(
    String(
      execFileSync("tar", ["-xOzf", tarballPath, "package/package.json"], {
        encoding: "utf8",
      })
    )
  );
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(
      `${tarballPath} has no name and version in package/package.json`
    );
  }
  return {
    tarballPath,
    spec: `${manifest.name}@${manifest.version}`,
    built: integrityOf(readFileSync(tarballPath)),
  };
});

for (const { tarballPath, spec, built } of releases) {
  const published = npmView(spec, "dist.integrity");
  if (published.kind === "failed") {
    throw new Error(published.reason);
  }
  if (published.kind === "missing") {
    execFileSync("npm", ["publish", tarballPath, "--access", "public"], {
      stdio: "inherit",
    });
  } else if (published.value === built) {
    console.log(`${spec} is already on npm with this run's tarball`);
  } else {
    throw new Error(
      `${spec} is on npm as ${published.value}, but this run built ${built}; release a new version`
    );
  }
}

async function fetchTarball(tarballUrl) {
  try {
    const response = await fetch(tarballUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    return response.ok
      ? { kind: "found", bytes: Buffer.from(await response.arrayBuffer()) }
      : {
          kind: "failed",
          reason: `GET ${tarballUrl} answered ${response.status}`,
        };
  } catch (error) {
    return { kind: "failed", reason: `GET ${tarballUrl} failed: ${error}` };
  }
}

async function waitUntilDownloadable({ spec, built }, deadline) {
  const located = npmView(spec, "dist.tarball");
  const fetched =
    located.kind === "found" ? await fetchTarball(located.value) : located;
  if (fetched.kind === "found") {
    const downloaded = integrityOf(fetched.bytes);
    if (downloaded !== built) {
      throw new Error(
        `${spec} downloads as ${downloaded}, but this run built ${built}`
      );
    }
    console.log(`${spec} downloads from ${located.value}`);
    return;
  }
  if (Date.now() > deadline) {
    throw new Error(
      `${spec} did not download within ${RESOLVE_DEADLINE_MS / 60_000} minutes; last attempt: ${fetched.reason}`
    );
  }
  await sleep(RESOLVE_POLL_MS);
  return waitUntilDownloadable({ spec, built }, deadline);
}

const deadline = Date.now() + RESOLVE_DEADLINE_MS;
await Promise.all(
  releases.map((release) => waitUntilDownloadable(release, deadline))
);
