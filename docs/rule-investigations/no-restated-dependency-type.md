# no-restated-dependency-type

Import an object type that a declared dependency already exports instead of restating it.

The rule checks first-party interfaces and type literals with at least three members. Dependencies are the keys of `dependencies`, `devDependencies` and `peerDependencies` in the nearest package.json, workspace packages included. A dependency is found in node_modules or, failing that, through the linted program's module resolution when the resolved package's manifest has the dependency's name. Public entry points are the package root and every subpath in its `exports` map, with wildcard subpaths expanded to matching TypeScript files. Owners are interfaces and type aliases with at least three properties exported from those entries, directly or through exported namespaces. Classes are not owners, and neither is an export whose declarations all sit in the linted package, such as an interface a module augmentation adds. A match must be identical at every depth through `tooling/antidrift/src/semantic-adapters/shape-identity.mjs`, the matcher shared with `no-inline-structural-type-at-use-site`; no reachable type may be any or an unresolved error type. An interface that merges into the owner export itself, checked by symbol identity, does not report.

Entry points missing from the linted program are added to one second program that reuses the linted program's source files.

A declared dependency that neither lookup finds is a coverage gap. The rule reports it on the module specifier of each import, export, require, dynamic import and import type of that package, as TypeScript and eslint-plugin-import report unresolved modules. A missing dependency that no file of the package imports is reported once per package, at line 1 of the path-sorted first TypeScript source file of that package outside nested packages and node_modules. If that file is not linted, the package-level report is not shown.

## Measurement after the review fixes on October 13, 2026

The shipped lint population of 39 installed oss-corpus repositories gives 222 restatement reports in 20 repositories, 3,961 import-site gap reports and 156 package-level gap reports in 18 repositories. The 20 agent-written repositories give 86 restatement reports in 18, 18 import-site and 2 package-level gap reports. twentyhq-twenty finishes with an 8 GB heap at 7.1 GiB peak RSS.

A hit-weighted sample capped at 3 per repository, seed 2026101323, excluding every earlier sampled location, holds 24 restatement reports from 17 repositories. Each label was written with the checker-resolved owner and its complete members printed. Source review labels 17 true, 5 false and 2 coincidental matches with an unrelated library. The false reports are three vendored mongodb declaration copies, a generated Payload types file whose declaration is not the leading comment, and a data-migration snapshot. The published score counts coincidences false: 17/24 = 70.8%. Counting them true gives 19/24. Label file `labels-no-restated-dependency-type.tsv`, SHA256 `3e44cda32c2273c04bd1979272ab19d48c642f554815edba1ff10226717d22d1`.

Agreement with the dependency corpus detector on `cases-real.jsonl`: 62 of 65 positives and 0 of 47 negatives; without the coincidental and error-shaped categories, 50 of 52. The cases were selected by that detector, so this is agreement, not recall.

Evidence remains at `/home/joedeleeuw/.local/state/lanes/shape-attempts/claude-combined/round2`. The earlier combined measurement, 18/24 on 233 reports with 1,279 per-file gap reports, is superseded.
