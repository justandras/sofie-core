# Release automation runbook

## GitHub App (`APP_CLIENT_ID` / `APP_PRIVATE_KEY`)

The release workflows authenticate as a GitHub App via [`.github/actions/app-git-auth`](../actions/app-git-auth/action.yml). The installation token has `contents: write` and is used to:

- Push version commits to `main` and `release/**`
- Create and force-move annotated tags (`v*`, `0.0.0-nightly.*`, `latest`, `nightly`)

**Operational checklist (quarterly):**

- App is installed only on repositories that need automated releases
- `APP_PRIVATE_KEY` is stored only in org/repo secrets for those workflows
- The App bot is the sole identity allowed to bypass branch protection for release pushes
- Installation access and repository list are reviewed

## Workflows

| Workflow | Trigger | Environment |
|----------|---------|-------------|
| `q-release.yml` | Quarterly cron / manual | `release-automatic` (cron) or `production-release` (manual) |
| `nightly.yml` | Daily cron / manual | `release-automatic` (cron) or `production-release` (manual) |
| `hotfix-patch.yml` | Push to `release/**` (filtered paths) | — |

Create GitHub environments before first use:

- **`release-automatic`** — no required reviewers (scheduled releases)
- **`production-release`** — required reviewers (manual `workflow_dispatch`)

## Floating tags

- **`latest`** — moved on stable and patch releases (`git push origin +latest`)
- **`nightly`** — moved on scheduled main nightly only (`git push origin +nightly`)

Consumers pinning to floating tags receive whatever commit the tag currently points at.

## Hotfix hardening

`hotfix-patch.yml` runs `scripts/version-sync.mjs` from **`main`**, not from the release branch, while versioning files checked out from the triggering `release/**` ref. Bot version commits (`[skip ci]`, App bot actor) do not re-trigger the workflow.

## Yarn install

Release workflows use `yarn --cwd packages install --immutable`. `--ignore-scripts` is **not** used because `packages/package.json` defines a `prepare` script (`lerna run prepare`) that may be required by the monorepo toolchain.

## Branch protection (repo settings)

Configure for `main` and `release/**`:

- Require pull request reviews (include CODEOWNERS)
- Require status checks (CI + PR compliance)
- Restrict who can push and bypass rules
- Disallow force-push
