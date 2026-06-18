export const VIOLATION_TYPES = Object.freeze({
  forbiddenPath: "forbidden-path-touched",
  pathOutOfScope: "path-out-of-scope",
  undeclaredChangeType: "undeclared-change-type",
  undeclaredAddedExport: "undeclared-added-export",
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
      if (glob[index + 2] === "/") {
        pattern += "(?:[^/]+/)*";
        index += 3;
      } else {
        pattern += ".*";
        index += 2;
      }
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

function pathViolations(file, scope) {
  const violations = [];
  const candidatePaths = file.oldPath ? [file.oldPath, file.path] : [file.path];

  for (const candidate of candidatePaths) {
    if (matchesAnyGlob(candidate, scope.forbiddenPaths)) {
      violations.push({
        type: VIOLATION_TYPES.forbiddenPath,
        path: candidate,
        detail: `changed path ${candidate} matches a forbidden path`,
      });
    }
    if (!matchesAnyGlob(candidate, scope.allowedPaths)) {
      violations.push({
        type: VIOLATION_TYPES.pathOutOfScope,
        path: candidate,
        detail: `changed path ${candidate} is outside every allowed path`,
      });
    }
  }
  return violations;
}

function changeTypeViolations(file, scope) {
  const violations = [];
  if (
    scope.allowedChangeTypes.length > 0 &&
    !scope.allowedChangeTypes.includes(file.operation)
  ) {
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

function exportAllowed(addedExport, allowedExports) {
  return allowedExports.some(
    (allowed) =>
      allowed.file === addedExport.file &&
      allowed.name === addedExport.name &&
      allowed.kind === addedExport.kind,
  );
}

function exportViolations(addedExports, allowedExports) {
  const violations = [];
  for (const addedExport of addedExports) {
    if (!exportAllowed(addedExport, allowedExports)) {
      violations.push({
        type: VIOLATION_TYPES.undeclaredAddedExport,
        path: addedExport.file,
        exportName: addedExport.name,
        exportKind: addedExport.kind,
        detail: `export "${addedExport.name}" (${addedExport.kind}) was added in ${addedExport.file} but is not declared in scope.allowedExports`,
      });
    }
  }
  return violations;
}

function requiresSurface(scope, surface) {
  if (!Array.isArray(scope.checkedSurfaces)) {
    throw new TypeError("scope.checkedSurfaces is required before analysis");
  }
  return scope.checkedSurfaces.includes(surface);
}

/**
 * Pure deterministic conformance check: does the change surface exceed the declared contract?
 */
export function analyzeChangeScope(contract, surface) {
  const { scope } = contract;
  const fileViolationList = [];
  if (requiresSurface(scope, "paths")) {
    fileViolationList.push(
      ...surface.changedFiles.flatMap((file) => pathViolations(file, scope)),
    );
  }
  if (requiresSurface(scope, "changeTypes")) {
    fileViolationList.push(
      ...surface.changedFiles.flatMap((file) =>
        changeTypeViolations(file, scope),
      ),
    );
  }
  const dependencyViolationList = requiresSurface(scope, "dependencies")
    ? [
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
      ]
    : [];
  const exportViolationList = requiresSurface(scope, "exports")
    ? exportViolations(surface.addedExports ?? [], scope.allowedExports ?? [])
    : [];
  return [
    ...fileViolationList,
    ...exportViolationList,
    ...dependencyViolationList,
  ];
}
