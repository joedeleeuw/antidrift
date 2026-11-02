import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RESOLVE_DEADLINE_MS = 15 * 60_000;
const RESOLVE_POLL_MS = 10_000;
const VIEW_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const tarballPaths = process.argv.slice(2);
if (tarballPaths.length === 0) {
  throw new Error("usage: publish-tarball.mjs <tarball.tgz>...");
}

function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function npmViewSync(spec, field) {
  const viewed = spawnSync("npm", ["view", spec, field], {
    encoding: "utf8",
    timeout: VIEW_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (viewed.status === 0) {
    return { kind: "found", value: viewed.stdout.trim() };
  }
  if (viewed.stderr?.includes("E404")) {
    return { kind: "missing", reason: `${spec} is not on npm yet` };
  }
  const detail = viewed.error ? String(viewed.error) : viewed.stderr;
  return {
    kind: "failed",
    reason: `npm view ${spec} ${field} failed: ${detail}`,
  };
}

async function npmView(spec, field, timeoutMs) {
  try {
    const { stdout } = await execFileAsync("npm", ["view", spec, field], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return { kind: "found", value: stdout.trim() };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : String(error);
    if (stderr.includes("E404")) {
      return { kind: "missing", reason: `${spec} is not on npm yet` };
    }
    return {
      kind: "failed",
      reason: `npm view ${spec} ${field} failed: ${stderr}`,
    };
  }
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
  const published = npmViewSync(spec, "dist.integrity");
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

async function fetchTarball(tarballUrl, timeoutMs) {
  try {
    const response = await fetch(tarballUrl, {
      signal: AbortSignal.timeout(timeoutMs),
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

function remainingBudget(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function pollTarballAttempt(spec, deadline) {
  const viewBudget = Math.min(VIEW_TIMEOUT_MS, remainingBudget(deadline));
  if (viewBudget <= 0) {
    return null;
  }
  const located = await npmView(spec, "dist.tarball", viewBudget);
  if (located.kind !== "found") {
    return { located, fetched: located };
  }
  const downloadBudget = Math.min(
    DOWNLOAD_TIMEOUT_MS,
    remainingBudget(deadline)
  );
  if (downloadBudget <= 0) {
    return {
      located,
      fetched: {
        kind: "failed",
        reason: `${located.value} located at deadline`,
      },
    };
  }
  const fetched = await fetchTarball(located.value, downloadBudget);
  return { located, fetched };
}

async function waitUntilDownloadable(
  { spec, built },
  deadline,
  lastReason = "deadline expired before lookup"
) {
  const attempt = await pollTarballAttempt(spec, deadline);
  if (!attempt) {
    throw new Error(
      `${spec} did not download within ${RESOLVE_DEADLINE_MS / 60_000} minutes; last attempt: ${lastReason}`
    );
  }
  const { located, fetched } = attempt;
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
  const sleepBudget = Math.min(RESOLVE_POLL_MS, remainingBudget(deadline));
  if (sleepBudget <= 0) {
    throw new Error(
      `${spec} did not download within ${RESOLVE_DEADLINE_MS / 60_000} minutes; last attempt: ${fetched.reason}`
    );
  }
  await sleep(sleepBudget);
  return waitUntilDownloadable({ spec, built }, deadline, fetched.reason);
}

const deadline = Date.now() + RESOLVE_DEADLINE_MS;
await Promise.all(
  releases.map((release) => waitUntilDownloadable(release, deadline))
);
