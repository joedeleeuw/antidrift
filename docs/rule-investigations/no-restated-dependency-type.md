# no-restated-dependency-type

Import an object type that a declared dependency already exports instead of restating it.

The rule checks first-party interfaces and type literals with at least three members. Dependencies are the keys of `dependencies`, `devDependencies` and `peerDependencies` in the nearest package.json, workspace packages included. Public entry points are the package root and every subpath in its `exports` map, with wildcard subpaths expanded to matching TypeScript files. Owners are interfaces and type aliases with at least three properties exported from those entries, directly or through exported namespaces; classes are not owners. A match must be identical at every depth through `tooling/antidrift/src/semantic-adapters/shape-identity.mjs`, the matcher shared with `no-inline-structural-type-at-use-site`. A declaration inside `declare module "pkg"` for the owner's package, or whose type is the owner's own merged type, is an augmentation and does not report.

Entry points missing from the linted program are added to one second program that reuses the linted program's source files. A declared dependency that is not installed is reported once per checked file as a coverage gap; it never stops the file.

## Measurement on October 13, 2026

The shipped lint population of 39 installed oss-corpus repositories gives 233 hits in 21 repositories and 1,279 coverage-gap reports. The 20 agent-written repositories give 86 hits in 18 and 10 gap reports. twentyhq-twenty finishes with an 8 GB heap.

A hit-weighted sample capped at 3 per repository, seed 2026101319, excluding every earlier sampled location, holds 24 reports from 14 repositories. Source review labels 18 true, 2 false (a vendored mongodb declaration copy and a data-migration snapshot) and 4 coincidental matches with an unrelated library. Precision is 18/24 with coincidences counted false and 22/24 with them counted true. Label file `labels-no-restated-dependency-type.tsv`, SHA256 `c110a830e0cf7102a71691f58b75d7da1c35742eddc89f5eb220e6d7fff44d89`.

Agreement with the dependency corpus detector on `cases-real.jsonl`: 62 of 65 positives and 0 of 47 negatives. Without the coincidental and error-shaped categories, 50 of 52. The cases were selected by that detector, so this is agreement, not recall.

Evidence remains at `/home/joedeleeuw/.local/state/lanes/shape-attempts/claude-combined`.
