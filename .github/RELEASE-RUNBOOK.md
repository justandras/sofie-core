# Release automation runbook

Canonical setup documentation lives in the developer wiki:

**[Release Automation Setup](https://sofie-automation.github.io/sofie-core/docs/for-developers/release-automation-setup)**  
(source: [`packages/documentation/docs/for-developers/release-automation-setup.md`](../packages/documentation/docs/for-developers/release-automation-setup.md))

Version cadence and tagging: **[Version Numbering](https://sofie-automation.github.io/sofie-core/docs/for-developers/version-numbering)**.

## Quick reference

| Need | Value |
| ---- | ----- |
| Auth | GitHub App → repo variable `APP_CLIENT_ID`, secret `APP_PRIVATE_KEY` |
| Environments | `release-automatic` (cron), `production-release` (manual production), `release-development` (branch nightlies, no reviewers) |
| Branch bypass | `YOUR_APP_SLUG[bot]` on `main` and `release/**` |
| Workflows | `q-release.yml`, `nightly.yml`, `hotfix-patch.yml` |
| Auth action | [`.github/actions/app-git-auth`](actions/app-git-auth/action.yml) |

Prefer **one GitHub App per repository** for production release lines.
