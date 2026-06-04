import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	getBaseReleaseFromDate,
	getDateFromDateString,
	inferTodayYymmdd,
	nightlyVersionFromDate,
	marketingFromRelease,
	fileVersionFromRelease,
	migrationFileBaseFromRelease,
	testing,
} from "./version-sync.mjs";

const SCRIPT = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"version-sync.mjs",
);

const fixtures = [];

function createRepo({
	branch = "main",
	currentVersion = "26.3.0",
	meteorVersion = currentVersion,
	lernaVersion = currentVersion,
	withMigrationStep = false,
	tags = [],
	extraCommits = 0,
} = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "version-sync-"));
	fixtures.push(root);

	const migrationDir = path.join(root, "meteor/server/migration");
	fs.mkdirSync(migrationDir, { recursive: true });
	fs.mkdirSync(path.join(root, "packages"), { recursive: true });

	fs.writeFileSync(
		path.join(migrationDir, "currentSystemVersion.ts"),
		`export const CURRENT_SYSTEM_VERSION = '${currentVersion}'\n`,
	);
	fs.writeFileSync(
		path.join(root, "meteor/package.json"),
		`${JSON.stringify({ name: "test-meteor", version: meteorVersion }, null, "\t")}\n`,
	);
	fs.writeFileSync(
		path.join(root, "packages/lerna.json"),
		`${JSON.stringify({ version: lernaVersion }, null, 2)}\n`,
	);
	fs.writeFileSync(
		path.join(root, "packages/package.json"),
		`${JSON.stringify({ name: "packages", private: true }, null, 2)}\n`,
	);
	fs.writeFileSync(
		path.join(migrationDir, "migrations.ts"),
		`import { addSteps as addStepsX_X_X } from './X_X_X'\naddStepsX_X_X()\n`,
	);

	const xxxBody = withMigrationStep
		? `export const addSteps = addMigrationSteps(CURRENT_SYSTEM_VERSION, [\n\t{ id: \`wip-step\` },\n])\n`
		: `export const addSteps = addMigrationSteps(CURRENT_SYSTEM_VERSION, [\n\t// Add your migration here\n])\n`;
	fs.writeFileSync(
		path.join(migrationDir, "X_X_X.ts"),
		`import { addMigrationSteps } from './databaseMigration'\nimport { CURRENT_SYSTEM_VERSION } from './currentSystemVersion'\n\n${xxxBody}`,
	);

	execSync("git init -b main", { cwd: root, stdio: "pipe" });
	execSync("git config user.email test@sofie.test", { cwd: root, stdio: "pipe" });
	execSync("git config user.name Sofie Test", { cwd: root, stdio: "pipe" });
	execSync("git add -A", { cwd: root, stdio: "pipe" });
	execSync('git commit -m "init"', { cwd: root, stdio: "pipe" });

	if (branch !== "main") {
		execSync(`git checkout -b ${branch}`, { cwd: root, stdio: "pipe" });
	}

	for (const tag of tags) {
		execSync(`git tag ${tag}`, { cwd: root, stdio: "pipe" });
	}

	for (let i = 0; i < extraCommits; i++) {
		fs.appendFileSync(path.join(root, "README"), `commit ${i}\n`);
		execSync("git add README", { cwd: root, stdio: "pipe" });
		execSync(`git commit -m "extra ${i}"`, { cwd: root, stdio: "pipe" });
	}

	return root;
}

function run(args, root) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		env: { ...process.env, VERSION_SYNC_ROOT: root },
		encoding: "utf8",
	});
}

function readVersion(root) {
	const content = fs.readFileSync(
		path.join(root, "meteor/server/migration/currentSystemVersion.ts"),
		"utf8",
	);
	return /'([^']+)'/.exec(content)[1];
}

afterEach(() => {
	while (fixtures.length > 0) {
		fs.rmSync(fixtures.pop(), { recursive: true, force: true });
	}
});

describe("release line calendar", () => {
	const cases = [
		{ in: { yy: 26, mm: 1 }, want: { yy: 25, mm: 11 } },
		{ in: { yy: 26, mm: 2 }, want: { yy: 26, mm: 2 } },
		{ in: { yy: 26, mm: 3 }, want: { yy: 26, mm: 2 } },
		{ in: { yy: 26, mm: 4 }, want: { yy: 26, mm: 2 } },
		{ in: { yy: 26, mm: 5 }, want: { yy: 26, mm: 5 } },
		{ in: { yy: 26, mm: 6 }, want: { yy: 26, mm: 5 } },
		{ in: { yy: 26, mm: 7 }, want: { yy: 26, mm: 5 } },
		{ in: { yy: 26, mm: 8 }, want: { yy: 26, mm: 8 } },
		{ in: { yy: 26, mm: 9 }, want: { yy: 26, mm: 8 } },
		{ in: { yy: 26, mm: 10 }, want: { yy: 26, mm: 8 } },
		{ in: { yy: 26, mm: 11 }, want: { yy: 26, mm: 11 } },
		{ in: { yy: 26, mm: 12 }, want: { yy: 26, mm: 11 } },
	];

	for (const { in: input, want } of cases) {
		it(`month ${input.mm} → ${want.yy}.${want.mm}`, () => {
			const line = getBaseReleaseFromDate(input);
			assert.equal(line.yy, want.yy);
			assert.equal(line.mm, want.mm);
			assert.equal(line.pp, 0);
		});
	}
});

describe("version string helpers", () => {
	it("parses YYMM and YYMMDD dates", () => {
		assert.deepEqual(getDateFromDateString("2605"), { yy: 26, mm: 5, dd: undefined });
		assert.deepEqual(getDateFromDateString("260604"), { yy: 26, mm: 6, dd: 4 });
	});

	it("formats marketing and file versions", () => {
		assert.equal(marketingFromRelease({ yy: 26, mm: 5, pp: 0 }), "26.05");
		assert.equal(marketingFromRelease({ yy: 26, mm: 5, pp: 2 }), "26.05.02");
		assert.equal(fileVersionFromRelease({ yy: 26, mm: 5, pp: 2 }), "26.5.2");
		assert.equal(
			migrationFileBaseFromRelease({ yy: 26, mm: 5, pp: 2 }),
			"26_05_02",
		);
	});

	it("formats nightly version from date", () => {
		assert.equal(
			nightlyVersionFromDate({ yy: 26, mm: 6, dd: 4 }),
			"0.0.0-nightly.260604",
		);
	});

	it("infers today in a timezone", () => {
		const d = inferTodayYymmdd("UTC");
		assert.ok(d.yy >= 0 && d.yy <= 99);
		assert.ok(d.mm >= 1 && d.mm <= 12);
		assert.ok(d.dd >= 1 && d.dd <= 31);
	});
});

describe("branch and mode helpers", () => {
	it("parses release branches", () => {
		assert.deepEqual(testing.parseReleaseBranch("release/26.05"), {
			yy: 26,
			mm: 5,
			dd: undefined,
		});
		assert.equal(testing.parseReleaseBranch("release26.05"), undefined);
		assert.equal(testing.parseReleaseBranch("main"), undefined);
	});

	it("infers mode from branch name", () => {
		assert.equal(testing.inferModeFromBranch("main"), "nightly");
		assert.equal(testing.inferModeFromBranch("release/26.05"), "patch");
		assert.equal(testing.inferModeFromBranch("feature/foo"), undefined);
	});

	it("builds release branch names", () => {
		assert.equal(
			testing.releaseBranchName({ yy: 26, mm: 5, pp: 2 }),
			"release/26.05",
		);
	});

	it("matches release lines", () => {
		assert.equal(
			testing.releaseLinesMatch({ yy: 26, mm: 5 }, { yy: 26, mm: 5 }),
			true,
		);
		assert.equal(
			testing.releaseLinesMatch({ yy: 26, mm: 5 }, { yy: 26, mm: 8 }),
			false,
		);
		assert.equal(
			testing.branchMatchesReleaseLine("release/26.05", { yy: 26, mm: 5 }),
			true,
		);
	});
});

describe("parseArgs", () => {
	it("parses all flags", () => {
		const opts = testing.parseArgs([
			"--mode",
			"patch",
			"--date",
			"260604",
			"--patch",
			"3",
			"--timezone",
			"UTC",
			"--dry-run",
			"--check",
			"--commit",
			"--github-output",
		]);
		assert.equal(opts.mode, "patch");
		assert.equal(opts.date, "260604");
		assert.equal(opts.patch, 3);
		assert.equal(opts.timezone, "UTC");
		assert.equal(opts.dryRun, true);
		assert.equal(opts.check, true);
		assert.equal(opts.commit, true);
		assert.equal(opts.githubOutput, true);
	});

	it("rejects invalid patch", () => {
		assert.throws(
			() => testing.parseArgs(["--patch", "nope"]),
			/--patch must be a non-negative integer/,
		);
	});

	it("rejects --github-output combined with --print-tag", () => {
		assert.throws(
			() =>
				testing.parseArgs(["--mode", "stable", "--github-output", "--print-tag"]),
			/--github-output cannot be combined/,
		);
	});
});

describe("github output payload", () => {
	it("stable release", () => {
		const payload = testing.githubOutputPayload(
			{
				mode: "stable",
				marketing: "v26.05",
				fileVersion: "26.5.0",
				release: { yy: 26, mm: 5, pp: 0 },
				floatingTag: "latest",
			},
			{ skipped: false },
		);
		assert.deepEqual(payload, {
			mode: "stable",
			tag: "v26.05",
			floatingTag: "latest",
			skipped: false,
			branch: "release/26.05",
		});
	});

	it("nightly on main", () => {
		const payload = testing.githubOutputPayload(
			{
				mode: "nightly",
				fileVersion: "0.0.0-nightly.260604",
				branch: "main",
				floatingTag: "nightly",
			},
			{ skipped: true },
		);
		assert.equal(payload.tag, "0.0.0-nightly.260604");
		assert.equal(payload.branch, "main");
		assert.equal(payload.skipped, true);
	});
});

describe("commit messages and tags", () => {
	it("uses version tag for stable, patch, and nightly", () => {
		assert.equal(
			testing.gitTagFromTarget({
				mode: "stable",
				marketing: "v26.05",
				fileVersion: "26.5.0",
			}),
			"v26.05",
		);
		assert.equal(
			testing.gitTagFromTarget({
				mode: "nightly",
				fileVersion: "0.0.0-nightly.260604",
			}),
			"0.0.0-nightly.260604",
		);
	});

	it("formats commit messages", () => {
		assert.equal(
			testing.commitMessageForTarget({
				mode: "patch",
				marketing: "v26.05.02",
				fileVersion: "26.5.2",
			}),
			"chore(release): v26.05.02 [skip ci]",
		);
		assert.equal(
			testing.commitMessageForTarget({
				mode: "nightly",
				fileVersion: "0.0.0-nightly.260604",
			}),
			"chore(nightly): 0.0.0-nightly.260604 [skip ci]",
		);
	});

	it("parses patch from tag", () => {
		assert.equal(testing.patchFromTag("v26.05.07"), 7);
	});
});

describe("CLI print flags", () => {
	it("--print-branch on stable", () => {
		const root = createRepo({ branch: "main" });
		const r = run(
			["--mode", "stable", "--date", "2605", "--print-branch"],
			root,
		);
		assert.equal(r.status, 0);
		assert.equal(r.stdout.trim(), "release/26.05");
	});

	it("--print-tag on stable", () => {
		const root = createRepo({ branch: "main" });
		const r = run(["--mode", "stable", "--date", "2605", "--print-tag"], root);
		assert.equal(r.status, 0);
		assert.equal(r.stdout.trim(), "v26.05");
	});

	it("--print-version on patch branch", () => {
		const root = createRepo({
			branch: "release/26.05",
			currentVersion: "26.5.1",
		});
		const r = run(["--mode", "patch", "--print-version"], root);
		assert.equal(r.status, 0);
		assert.equal(r.stdout.trim(), "26.5.2");
	});

	it("--print-branch rejects nightly", () => {
		const root = createRepo();
		const r = run(["--mode", "nightly", "--date", "260604", "--print-branch"], root);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /--print-branch is not available for nightly/);
	});
});

describe("mode inference", () => {
	it("infers nightly on main", () => {
		const root = createRepo();
		const r = run(["--date", "260604", "--dry-run"], root);
		assert.equal(r.status, 0);
		assert.match(r.stdout + r.stderr, /mode: nightly/);
	});

	it("infers patch on release branch", () => {
		const root = createRepo({ branch: "release/26.05" });
		const r = run(["--dry-run"], root);
		assert.equal(r.status, 0);
		assert.match(r.stdout + r.stderr, /mode: patch/);
	});

	it("fails on unrecognized branch without --mode", () => {
		const root = createRepo({ branch: "feature/x" });
		const r = run(["--dry-run"], root);
		assert.notEqual(r.status, 0);
	});
});

describe("--dry-run and --check", () => {
	it("--dry-run does not write version files", () => {
		const root = createRepo({ currentVersion: "26.3.0" });
		const before = readVersion(root);
		const r = run(
			["--mode", "stable", "--date", "2605", "--dry-run"],
			root,
		);
		assert.equal(r.status, 0);
		assert.equal(readVersion(root), before);
		assert.match(r.stdout + r.stderr, /dry-run complete/);
	});

	it("--check exits 1 when out of sync", () => {
		const root = createRepo({ currentVersion: "26.3.0" });
		const r = run(["--mode", "stable", "--date", "2605", "--check"], root);
		assert.equal(r.status, 1);
	});

	it("--check exits 0 when in sync", () => {
		const root = createRepo({
			branch: "release/26.05",
			currentVersion: "26.5.2",
			meteorVersion: "26.5.2",
			lernaVersion: "26.5.2",
		});
		const r = run(["--mode", "patch", "--patch", "2", "--check"], root);
		assert.equal(r.status, 0);
		assert.match(r.stdout + r.stderr, /check passed/);
	});

	it("--check does not write files", () => {
		const root = createRepo({ currentVersion: "1.0.0" });
		const before = readVersion(root);
		run(["--mode", "stable", "--date", "2605", "--check"], root);
		assert.equal(readVersion(root), before);
	});
});

describe("patch resolution", () => {
	it("increments from currentSystemVersion on matching release line", () => {
		const root = createRepo({
			branch: "release/26.05",
			currentVersion: "26.5.1",
		});
		const r = run(["--mode", "patch", "--print-tag"], root);
		assert.equal(r.stdout.trim(), "v26.05.02");
	});

	it("increments from latest tag when version is on another line", () => {
		const root = createRepo({
			branch: "release/26.05",
			currentVersion: "26.3.0",
			tags: ["v26.05.01"],
		});
		const r = run(["--mode", "patch", "--print-tag"], root);
		assert.equal(r.stdout.trim(), "v26.05.02");
	});

	it("starts at patch 1 with no prior tag or version on line", () => {
		const root = createRepo({
			branch: "release/26.05",
			currentVersion: "26.3.0",
		});
		const r = run(["--mode", "patch", "--print-tag"], root);
		assert.equal(r.stdout.trim(), "v26.05.01");
	});

	it("honours --patch override", () => {
		const root = createRepo({
			branch: "release/26.05",
			currentVersion: "26.5.9",
		});
		const r = run(
			["--mode", "patch", "--patch", "4", "--print-tag"],
			root,
		);
		assert.equal(r.stdout.trim(), "v26.05.04");
	});

	it("refuses auto patch 0 when release line already has patch > 0", () => {
		const root = createRepo({
			branch: "release/26.05",
			currentVersion: "26.5.2",
		});
		const r = run(["--mode", "stable", "--print-tag"], root);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /refusing to automatically set patch 0/);
	});

	it("allows stable --patch 0 override", () => {
		const root = createRepo({
			branch: "release/26.05",
			currentVersion: "26.5.2",
		});
		const r = run(
			["--mode", "stable", "--patch", "0", "--print-tag"],
			root,
		);
		assert.equal(r.status, 0);
		assert.equal(r.stdout.trim(), "v26.05");
	});
});

describe("nightly mode", () => {
	it("scheduled nightly on main without branch suffix", () => {
		const root = createRepo();
		const r = run(
			["--mode", "nightly", "--date", "260604", "--print-version"],
			root,
		);
		assert.equal(r.status, 0);
		assert.equal(r.stdout.trim(), "0.0.0-nightly.260604");
	});

	it("branch nightly includes branch and hash suffix", () => {
		const root = createRepo({ branch: "release/26.05" });
		const r = run(
			["--mode", "nightly", "--date", "260604", "--print-version"],
			root,
		);
		assert.equal(r.status, 0);
		assert.match(r.stdout.trim(), /^0\.0\.0-nightly\.260604-release\/26\.05-[0-9a-f]+$/);
	});

	it("rejects nightly without day when date is YYMM only", () => {
		const root = createRepo();
		const r = run(["--mode", "nightly", "--date", "2606", "--print-version"], root);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /Nightly versions require/);
	});

	it("rejects --commit on non-main nightly", () => {
		const root = createRepo({ branch: "release/26.05" });
		const r = run(
			["--mode", "nightly", "--date", "260604", "--commit", "--dry-run"],
			root,
		);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /--commit is only valid for scheduled nightly/);
	});
});

describe("--github-output", () => {
	it("prints only JSON on success", () => {
		const root = createRepo();
		const r = run(
			[
				"--mode",
				"nightly",
				"--date",
				"260604",
				"--dry-run",
				"--github-output",
			],
			root,
		);
		assert.equal(r.status, 0);
		assert.equal(r.stderr.trim(), "");
		const payload = JSON.parse(r.stdout.trim());
		assert.equal(payload.mode, "nightly");
		assert.equal(payload.tag, "0.0.0-nightly.260604");
		assert.equal(payload.floatingTag, "nightly");
		assert.equal(payload.branch, "main");
		assert.equal(payload.skipped, false);
	});

	it("flushes buffered logs on failure", () => {
		const root = createRepo({ branch: "feature/x" });
		const r = run(["--github-output", "--dry-run"], root);
		assert.notEqual(r.status, 0);
		const out = r.stdout + r.stderr;
		assert.match(out, /version-sync:/);
		assert.match(out, /cannot infer --mode/);
	});
});

describe("release skip and tag scenarios", () => {
	it("skips --commit when target tag already exists", () => {
		const root = createRepo({
			tags: ["0.0.0-nightly.260604"],
			currentVersion: "0.0.0-nightly.260604",
			meteorVersion: "0.0.0-nightly.260604",
			lernaVersion: "0.0.0-nightly.260604",
		});
		const r = run(
			[
				"--mode",
				"nightly",
				"--date",
				"260604",
				"--commit",
				"--dry-run",
				"--github-output",
			],
			root,
		);
		assert.equal(r.status, 0);
		const payload = JSON.parse(r.stdout.trim());
		assert.equal(payload.skipped, true);
	});

	it("skips --commit when HEAD already has release tag", () => {
		const root = createRepo({
			tags: ["v26.05.01"],
			currentVersion: "26.5.1",
			meteorVersion: "26.5.1",
			lernaVersion: "26.5.1",
		});
		execSync("git checkout -b release/26.05", { cwd: root, stdio: "pipe" });
		const r = run(
			["--mode", "patch", "--commit", "--dry-run", "--github-output"],
			root,
		);
		assert.equal(r.status, 0);
		const payload = JSON.parse(r.stdout.trim());
		assert.equal(payload.skipped, true);
	});

	it("skips --commit when no commits since tag and versions already match", () => {
		const root = createRepo({
			tags: ["0.0.0-nightly.260603"],
			currentVersion: "0.0.0-nightly.260603",
			meteorVersion: "0.0.0-nightly.260603",
			lernaVersion: "0.0.0-nightly.260603",
		});
		const r = run(
			[
				"--mode",
				"nightly",
				"--date",
				"260603",
				"--commit",
				"--dry-run",
				"--github-output",
			],
			root,
		);
		assert.equal(r.status, 0);
		const payload = JSON.parse(r.stdout.trim());
		assert.equal(payload.skipped, true);
	});

	it("does not skip nightly when calendar date advances but versions lag", () => {
		const root = createRepo({
			tags: ["0.0.0-nightly.260603"],
			currentVersion: "0.0.0-nightly.260603",
			meteorVersion: "0.0.0-nightly.260603",
			lernaVersion: "0.0.0-nightly.260603",
		});
		const r = run(
			[
				"--mode",
				"nightly",
				"--date",
				"260604",
				"--commit",
				"--dry-run",
				"--github-output",
			],
			root,
		);
		assert.equal(r.status, 0);
		const payload = JSON.parse(r.stdout.trim());
		assert.equal(payload.skipped, false);
	});

	it("does not skip nightly with new commits when versions lag behind target date", () => {
		const root = createRepo({
			tags: ["0.0.0-nightly.260603"],
			currentVersion: "0.0.0-nightly.260603",
			meteorVersion: "0.0.0-nightly.260603",
			lernaVersion: "0.0.0-nightly.260603",
			extraCommits: 1,
		});
		const r = run(
			[
				"--mode",
				"nightly",
				"--date",
				"260604",
				"--commit",
				"--dry-run",
				"--github-output",
			],
			root,
		);
		assert.equal(r.status, 0);
		const payload = JSON.parse(r.stdout.trim());
		assert.equal(payload.skipped, false);
	});
});

describe("stable migration and flags", () => {
	it("stable dry-run logs migration rotation when X_X_X has steps", () => {
		const root = createRepo({
			branch: "main",
			withMigrationStep: true,
		});
		const r = run(
			["--mode", "stable", "--date", "2605", "--dry-run"],
			root,
		);
		assert.equal(r.status, 0);
		assert.match(r.stdout + r.stderr, /rotating X_X_X\.ts/);
		assert.match(r.stdout + r.stderr, /would rename X_X_X/);
	});

	it("patch dry-run skips migration rotation", () => {
		const root = createRepo({
			branch: "release/26.05",
			withMigrationStep: true,
		});
		const r = run(["--mode", "patch", "--dry-run"], root);
		assert.equal(r.status, 0);
		assert.match(r.stdout + r.stderr, /skipping migration rotation/);
	});

	it("rejects --commit with --check", () => {
		const root = createRepo();
		const r = run(
			["--mode", "nightly", "--date", "260604", "--commit", "--check"],
			root,
		);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /--commit cannot be used with --check/);
	});

	it("rejects --patch on stable when not zero", () => {
		const root = createRepo();
		const r = run(
			["--mode", "stable", "--date", "2605", "--patch", "2"],
			root,
		);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /--patch requires --mode patch/);
	});
});

describe("--commit dry-run git operations", () => {
	it("logs commit and tags for patch without writing", () => {
		const root = createRepo({
			branch: "release/26.05",
			currentVersion: "26.5.0",
			meteorVersion: "26.5.0",
			lernaVersion: "26.5.0",
			extraCommits: 1,
		});
		const r = run(
			["--mode", "patch", "--commit", "--dry-run"],
			root,
		);
		assert.equal(r.status, 0);
		const out = r.stdout + r.stderr;
		assert.match(out, /\[dry-run\] git commit/);
		assert.match(out, /\[dry-run\] git tag v26\.05\.01/);
		assert.match(out, /\[dry-run\] git tag -f latest HEAD/);
		assert.equal(readVersion(root), "26.5.0");
	});

	it("logs nightly tag-only flow when versions already match", () => {
		const root = createRepo({
			currentVersion: "0.0.0-nightly.260604",
			meteorVersion: "0.0.0-nightly.260604",
			lernaVersion: "0.0.0-nightly.260604",
			extraCommits: 1,
		});
		const r = run(
			[
				"--mode",
				"nightly",
				"--date",
				"260604",
				"--commit",
				"--dry-run",
			],
			root,
		);
		assert.equal(r.status, 0);
		const out = r.stdout + r.stderr;
		assert.match(out, /tagging HEAD as 0\.0\.0-nightly\.260604/);
		assert.match(out, /\[dry-run\] git tag -f nightly HEAD/);
		assert.doesNotMatch(out, /\[dry-run\] git commit/);
	});
});
