---
sidebar_label: Version Numbering
sidebar_position: 3
description: How Sofie Core versions, release branches, and nightlies are numbered.
---

# Version Numbering Scheme

This repository, Sofie Core, does not follow semver. We believe that semver does not make sense for Sofie Core as there are so many moving parts that a majority of releases could be considered breaking in some way.

Instead of semver we use CalVer. The minor number gets incremented for each calendar quarter (`03` / `06` / `09` / `12`). The patch number gets incremented for patch releases as expected.

| Kind                      | Git tag (examples)                        | `package.json` / DB version                              |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| Stable / patch            | `v26.03`, `v26.03.02`                     | `26.3.0`, `26.3.2`                                       |
| Nightly (`main`)          | `0.0.0-nightly.260602`, rolling `nightly` | `0.0.0-nightly.260602`                                   |
| Feature-branch test build | _(no git tag)_                            | `0.0.0-nightly.YYMMDD-<branch>-<hash>` _NPM/Docker only_ |

## Release lines (`release/YY.MM`)

| Calendar months | Version  |
| --------------- | -------- |
| Jan–Mar         | `vYY.03` |
| Apr–Jun         | `vYY.06` |
| Jul–Sep         | `vYY.09` |
| Oct–Dec         | `vYY.12` |

**Quarterly cut** ([`q-release.yml`](https://github.com/Sofie-Automation/sofie-core/blob/main/.github/workflows/q-release.yml)): runs on **1 Jan / 1 Apr / 1 Jul / 1 Oct** (first day of the _next_ quarter). The version is the **last completed** quarter (e.g. 1 Oct → `release/26.09`; a manual run on 3 Aug → `release/26.06`, not `26.09`).

Before creating `release/YY.MM`, the cut job snapshots docs on **`main`** with `docusaurus docs:version YY.MM` (quarter only — not patch). That commit is pushed to `main`, then the release branch is cut from that tip. Patches do **not** create a new documentation version.

**Patches:** merge to `release/**` → [`hotfix-patch.yml`](https://github.com/Sofie-Automation/sofie-core/blob/main/.github/workflows/hotfix-patch.yml).

**Nightly:** [`nightly.yml`](https://github.com/Sofie-Automation/sofie-core/blob/main/.github/workflows/nightly.yml) — daily on `main` (commit, tag, move floating `nightly`), or manual dispatch from a feature branch to publish test artifacts only.

All version forms go through [`scripts/version-sync.mjs`](https://github.com/Sofie-Automation/sofie-core/blob/main/scripts/version-sync.mjs). Prefer immutable tags in production (`v26.03.02`); avoid floating `latest` / `nightly`.

Manual GitHub configuration (App, Environments, branch bypass, Pages): [Release Automation Setup](release-automation-setup.md).

## Hotfixes

Open a PR to `main` and to the active `release/YY.MM` (or justify a single-branch fix in the PR description). Reviewers should confirm both PRs exist when both are required.

## Integration libraries

The version numbers of the `blueprints-integration` and `server-core-integration` libraries are tied to this, and as such they also do not follow semver. In future these may be decoupled.

The api of `server-core-integration` is pretty stable and rarely undergoes any breaking changes, so is ok to be mismatched.

The api of `blueprints-integration` is rather volatile, and often has breaking changes. Because of this, we recommend matching the minor version of `blueprints-integration` with Sofie core. Sofie will warn if these do not match. We expect this to settle down in the future, and will review this decision when we feel it is worthwhile.
