export const VIOLATION_TYPES = Object.freeze({
  forbiddenPath: "forbidden-path-touched",
  pathOutOfScope: "path-out-of-scope",
  undeclaredChangeType: "undeclared-change-type",
  undeclaredRuntimeDependency: "undeclared-runtime-dependency",
  undeclaredDevDependency: "undeclared-dev-dependency",
});

const REGEXP_SPECIAL = new Set(String.raw`\^$.|?+()[]{}`);

/**
 * Compile a path glob (supporting `*` within a segment and `**` across segments) to a RegExp.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let pattern = "^";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      pattern += ".*";
      index += glob[index + 2] === "/" ? 3 : 2;
    } else if (char === "*") {
      pattern += "[^/]*";
      index += 1;
    } else {
      pattern += REGEXP_SPECIAL.has(char) ? `\\${char}` : char;
      index += 1;
    }
  }
  return new RegExp(`${pattern}$`, "u");
}

/**
 * @param {string} path
 * @param {readonly string[]} globs
 */
export function matchesAnyGlob(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function fileViolations(file, scope) {
  const violations = [];
  const candidatePaths = file.oldPath ? [file.oldPath, file.path] : [file.path];

  for (const candidate of candidatePaths) {
    if (matchesAnyGlob(candidate, scope.forbiddenPaths)) {
      violations.push({
        type: VIOLATION_TYPES.forbiddenPath,
        path: candidate,
        detail: `changed path ${candidate} matches a forbidden path`,
      });
    } else if (!matchesAnyGlob(candidate, scope.allowedPaths)) {
      violations.push({
        type: VIOLATION_TYPES.pathOutOfScope,
        path: candidate,
        detail: `changed path ${candidate} is outside every allowed path`,
      });
    }
  }

  if (scope.allowedChangeTypes.length > 0 && !scope.allowedChangeTypes.includes(file.operation)) {
    violations.push({
      type: VIOLATION_TYPES.undeclaredChangeType,
      path: file.path,
      detail: `change type "${file.operation}" on ${file.path} is not in allowedChangeTypes`,
    });
  }

  return violations;
}

function dependencyViolations(added, allowed, type, label) {
  const violations = [];
  for (const dependency of added) {
    if (!allowed.includes(dependency)) {
      violations.push({
        type,
        dependency,
        detail: `${label} dependency "${dependency}" was added but is not declared in the contract`,
      });
    }
  }
  return violations;
}

/**
 * Pure deterministic conformance check: does the change surface exceed the declared contract?
 * @param {object} contract normalized contract from validateContract
 * @param {{ changedFiles: Array<{ path: string, oldPath: string | null, operation: string }>, addedRuntimeDependencies: string[], addedDevDependencies: string[] }} surface
 * @returns {Array<{ type: string, path?: string, dependency?: string, detail: string }>}
 */
export function analyzeChangeScope(contract, surface) {
  const { scope } = contract;
  const violations = [];

  for (const file of surface.changedFiles) {
    violations.push(...fileViolations(file, scope));
  }

  violations.push(
    ...dependencyViolations(
      surface.addedRuntimeDependencies,
      scope.allowedRuntimeDependencies,
      VIOLATION_TYPES.undeclaredRuntimeDependency,
      "runtime",
    ),
    ...dependencyViolations(
      surface.addedDevDependencies,
      scope.allowedDevDependencies,
      VIOLATION_TYPES.undeclaredDevDependency,
      "dev",
    ),
  );

  return violations;
}
