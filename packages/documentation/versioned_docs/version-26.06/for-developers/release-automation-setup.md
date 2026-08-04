---
sidebar_label: Release Automation Setup
sidebar_position: 4
description: GitHub-side configuration that the Sofie Core release workflows depend on (App authentication, Environments, branch rules, Pages).
---

# Release Automation Setup

Release automation in Sofie Core is implemented as GitHub Actions workflows under [`.github/workflows/`](https://github.com/Sofie-Automation/sofie-core/tree/main/.github/workflows). Those workflows assume a fixed set of repository settings outside the YAML: a GitHub App for git authentication, named Environments for approval gating, branch rules that allow the App bot to push, and GitHub Pages built from Actions.

Version numbering, release cadence, and hotfix process are documented in [Version Numbering](version-numbering.md). Authentication is performed by the composite action [`.github/actions/app-git-auth`](https://github.com/Sofie-Automation/sofie-core/blob/main/.github/actions/app-git-auth/action.yml).

## Authentication model

Release jobs push commits and tags to `main` and `release/**`. After a quarterly docs snapshot, `q-release` also dispatches [`deploy-docs.yml`](https://github.com/Sofie-Automation/sofie-core/blob/main/.github/workflows/deploy-docs.yml) explicitly so GitHub Pages updates.

Jobs therefore authenticate as a **GitHub App installation**, not as the default `GITHUB_TOKEN` / `github-actions[bot]`.

| Capability                                    | `GITHUB_TOKEN`                                                      | App installation token                                            |
| --------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Push to a branch that requires a pull request | Typically blocked unless Actions is granted a broad bypass          | Allowed when the App’s `[bot]` user is on the ruleset bypass list |
| Start further workflows from the push         | No — GitHub does not chain workflow runs from `GITHUB_TOKEN` pushes | Yes                                                               |
| Commit / tag author identity                  | Shared Actions bot                                                  | That App’s `[bot]` user                                           |

A long-lived personal access token can technically push and chain workflows, but it is a poorer fit: harder to scope to Contents-only access and harder to rotate as a dedicated release identity.

### App permissions and credentials

The App used by the workflows needs repository **Contents: Read and write** (create commits and tags; force-update floating tags). No other repository permissions are required by the current release jobs.

Workflows read:

| Name              | Kind             | Role                                                             |
| ----------------- | ---------------- | ---------------------------------------------------------------- |
| `APP_CLIENT_ID`   | Actions variable | GitHub App client ID passed to `actions/create-github-app-token` |
| `APP_PRIVATE_KEY` | Actions secret   | PEM private key used to mint short-lived installation tokens     |

The installation token is issued at job start, used for `git` / `gh`, and expires on the order of an hour. The private key is the long-lived credential: anyone who can read `APP_PRIVATE_KEY` can mint new installation tokens for every repository where that App is installed, until the key is revoked or rotated.

### Scope of the App

Because compromise of the private key could affect all installations of that App, Sofie release lines use **one GitHub App per repository**, installed only on that repository. Sharing one App across many repos widens the blast radius of a single leaked key.

The git author configured by `app-git-auth` is the App’s bot user (for example `sofie-core-release[bot]`). That same actor must appear on branch-rule bypass lists.

## Environments

[`q-release.yml`](https://github.com/Sofie-Automation/sofie-core/blob/main/.github/workflows/q-release.yml) and [`nightly.yml`](https://github.com/Sofie-Automation/sofie-core/blob/main/.github/workflows/nightly.yml) select a GitHub [Environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) based on how they were started:

| Environment           | Selected when                                                                | Intended protection                                                                              |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `release-automatic`   | `q-release` / `nightly` on `schedule` (cron)                                 | No required reviewers — scheduled jobs must proceed without interactive approval                 |
| `production-release`  | `q-release` manual dispatch, or `nightly` manual dispatch with branch `main` | Required reviewers — production cuts and canonical main nightlies wait for maintainer approval   |
| `release-development` | `nightly` manual dispatch with a non-`main` branch                           | No required reviewers — anyone who can run Actions can cut a branch nightly for test deployments |

[`hotfix-patch.yml`](https://github.com/Sofie-Automation/sofie-core/blob/main/.github/workflows/hotfix-patch.yml) does not declare an Environment. It still uses the same App credentials and is subject to the same branch rules.

Missing Environments cause the corresponding jobs to fail when entering that Environment.

### Nightly dispatch

Manual `nightly` runs use the branch selected in the Actions UI (“Use workflow from”). There is no separate branch input — the job always targets that ref (or `main` on cron).

| Target branch                  | Environment                                | Git commit / tags                                               | Artifacts                                                        |
| ------------------------------ | ------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `main` (cron or manual)        | `release-automatic` / `production-release` | Version commit; `0.0.0-nightly.YYMMDD`; move floating `nightly` | From tag / main push CI                                          |
| Any other branch (manual only) | `release-development`                      | None                                                            | No commit, artifact tags: `0.0.0-nightly.YYMMDD-<branch>-<hash>` |

## Branch and tag rules

Human contributors are expected to land changes on `main` and `release/**` through pull requests with status checks. The release App is an exception: it must push version commits, documentation snapshots, and tags directly.

Rulesets (or classic branch protection) for `main` and `release/**` therefore include the App’s bot user on the **bypass list** for required pull requests. Without that bypass, pushes fail with `GH013` (changes must be made through a pull request) even when the installation token is valid.

Tag behaviour used by the automation:

| Tag                    | Mutability             | Updated by                                       |
| ---------------------- | ---------------------- | ------------------------------------------------ |
| `vYY.MM.PP`            | Immutable once created | Stable and patch releases                        |
| `0.0.0-nightly.YYMMDD` | Immutable once created | Nightly on `main`                                |
| `latest`               | Floating (force-moved) | Stable and patch releases                        |
| `nightly`              | Floating (force-moved) | Nightly on `main` only (cron or approved manual) |

Repository rules that forbid the App from creating or updating tags will break floating-tag updates even when branch pushes succeed.

## Actions and schedules

Cron triggers only register for workflow files on the repository default branch, and only while Actions (including scheduled workflows) are permitted by repository and organization policy. On forks, scheduled workflows are commonly disabled until enabled in the Actions UI.

## Documentation site

Quarterly release cuts snapshot the developer documentation on `main` with Docusaurus `docs:version YY.MM` before creating `release/YY.MM`. Patch releases do not create a new documentation version. See [Version Numbering](version-numbering.md).

[`deploy-docs.yml`](https://github.com/Sofie-Automation/sofie-core/blob/main/.github/workflows/deploy-docs.yml) builds and publishes from pushes to `main`, and also accepts `workflow_dispatch`. After a quarterly docs snapshot, `q-release.yml` pushes the commit with the GitHub App and then explicitly runs `gh workflow run deploy-docs.yml` (App pushes do not reliably chain into other workflows). The docs snapshot runs even if the release branch already exists, as long as that `YY.MM` is missing from `versions.json`. The Pages source for the repository is **GitHub Actions**; the deploy job uses the `github-pages` Environment.

## Workflow dependencies on this configuration

| Workflow           | Trigger                                                                         | Uses Environments | Uses App auth                  | Pushes                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------- | ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `nightly.yml`      | Daily cron (~23:00 UTC) or `workflow_dispatch`                                  | Yes               | App on `main` only             | `main`: version commit + nightly tags; other branches: dispatch `publish-libs` / `node.yaml` on the same ref |
| `q-release.yml`    | Quarterly cron (1 Jan / 1 Apr / 1 Jul / 1 Oct UTC) or `workflow_dispatch`       | Yes               | Yes                            | Docs snapshot on `main`; `release/YY.MM`; stable tags                                                        |
| `hotfix-patch.yml` | Push to `release/**` (path-filtered); skips the App bot and `[skip ci]` commits | No                | Yes                            | Patch version commit on the release branch; stable tags                                                      |
| `deploy-docs.yml` | Push to `main`, or `workflow_dispatch` (also triggered by `q-release` after a docs snapshot) | `github-pages` | Default token for Pages deploy | Publishes the documentation site |

`hotfix-patch` runs `scripts/version-sync.mjs` from **`main`** against a checkout of the triggering `release/**` ref, so patch bumps always use the sync script as it exists on `main`.

Release jobs install packages with `yarn --cwd packages install --immutable` (lifecycle scripts allowed).

## Failure modes tied to missing configuration

| Symptom                                            | Typical cause                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Cannot mint App token / auth step fails            | Missing or incorrect `APP_CLIENT_ID` / `APP_PRIVATE_KEY`, or App not installed on the repository |
| `GH013` on `git push`                              | App bot not on the ruleset / branch-protection bypass list                                       |
| Job waiting indefinitely or failing on Environment | Missing Environment, or `release-automatic` incorrectly requires reviewers on cron               |
| Docs snapshot on `main` but site unchanged         | Pages not set to GitHub Actions, or push identity that does not chain workflows                  |
| Cron never runs                                    | Actions schedules disabled (common on forks) or workflow file not on the default branch          |
| Hotfix patch loops or never runs                   | Bypass / actor filters misaligned with the App slug; path filters excluding the change           |

## Related configuration (not release tagging)

NPM library publishing uses separate variables and secrets (`NPM_PACKAGE_SCOPE`, `NPM_PACKAGE_PREFIX`, `NPM_TOKEN`). See [NPM Package Publishing](npm-package-publishing.md). Container registries, Codecov, and similar CI secrets are owned by other workflows and are independent of App-based release tagging.

## Related

- [Version Numbering](version-numbering.md)
- [NPM Package Publishing](npm-package-publishing.md)
- [Contribution Guidelines](contribution-guidelines.md)
