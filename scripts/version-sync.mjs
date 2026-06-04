#!/usr/bin/env node
/**
 * Single source of truth for Sofie Core version synchronization.
 *
 * All version forms derive from one calendar date (--date YYMM or YYMMDD, or inferred).
 *
 * Usage:
 *   node scripts/version-sync.mjs [--mode stable|patch|nightly] [--date YYMM|YYMMDD] [--dry-run] [--commit]
 *   node scripts/version-sync.mjs --github-output   # CI: one JSON line on success; info logs only if it fails
 *
 * Mode is inferred from the current branch when omitted: main → nightly,
 * release/YY.MM → patch. CI release-cut passes --mode stable explicitly.
 * --commit on main nightly: bump versions (no X_X_X seal), commit if needed, tag. Stable/patch seal + commit.
 * Rolling git tags: latest (stable/patch), nightly (scheduled main only). Moved with git tag -f.
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOG_PREFIX = "version-sync";

/** When set, info logs are buffered (machine-readable console.log output stays clean). */
let bufferLogs = false;
const logBuffer = [];

/** Verbose progress via console.log; buffered when output must stay clean. */
function log(message) {
	const line = `${LOG_PREFIX}: ${message}`;
	if (bufferLogs) {
		logBuffer.push(line);
	} else {
		console.log(line);
	}
}

function logError(message) {
	console.error(`${LOG_PREFIX}: ${message}`);
}

function flushLogs() {
	for (const line of logBuffer) {
		console.log(line);
	}
	logBuffer.length = 0;
}

function exitWithStatus(code) {
	if (bufferLogs && code !== 0) {
		flushLogs();
	}
	process.exit(code);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.VERSION_SYNC_ROOT
	? path.resolve(process.env.VERSION_SYNC_ROOT)
	: path.resolve(__dirname, "..");
const METEOR_PKG = path.join(REPO_ROOT, "meteor/package.json");
const LERNA_JSON = path.join(REPO_ROOT, "packages/lerna.json");
const CURRENT_VERSION_TS = path.join(
	REPO_ROOT,
	"meteor/server/migration/currentSystemVersion.ts",
);
const MIGRATIONS_TS = path.join(
	REPO_ROOT,
	"meteor/server/migration/migrations.ts",
);
const MIGRATION_DIR = path.join(REPO_ROOT, "meteor/server/migration");
const X_X_X_FILE = path.join(MIGRATION_DIR, "X_X_X.ts");

const X_X_X_STUB = `import { addMigrationSteps } from './databaseMigration'
import { CURRENT_SYSTEM_VERSION } from './currentSystemVersion'

/*
 * **************************************************************************************
 *
 *  These migrations are destined for the next release
 *
 * (This file is to be renamed to the correct version number when doing the release)
 *
 * **************************************************************************************
 */

export const addSteps = addMigrationSteps(CURRENT_SYSTEM_VERSION, [
	// Add your migration here
])
`;

function printHelp() {
	console.log(`Usage: node scripts/version-sync.mjs [--mode stable|patch|nightly] [options]

Options:
  --mode stable|patch|nightly
                      Omitted: main → nightly, release/YY.MM → patch
  --date YYMM|YYMMDD  Calendar date; inferred from branch or clock when omitted
  --patch N           Override patch (patch mode, or stable --patch 0); never auto-lowers to 0
                      on a release branch that already has patch > 0 unless --patch is set
  --timezone TZ       Used when inferring date (default Europe/Oslo)
  --dry-run           Print actions without writing files
  --check             Exit 1 if repo would change (for CI); does not write files
  --commit            Stable/patch: version bump, seal migrations, tag, move latest. Nightly on main: bump + tag.
  --github-output     Run fully; on success one JSON line via console.log (info buffered; errors on failure)
  --print-branch      Print release branch name and exit (local/debug)
  --print-tag         Print git tag name and exit (local/debug)
  --print-version     Print file/npm version string and exit (local/debug)

Release line from calendar month (vYY.MM.PP tags, release/YY.MM branches):
  Nov–Dec     → vYY.11.PP
  Jan         → v(YY−1).11.PP
  Feb–Apr     → vYY.02.PP
  May–Jul     → vYY.05.PP
  Aug–Oct     → vYY.08.PP
`);
}

function consumeOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`Missing value for ${optionName}`);
	}
	return value;
}

function parseArgs(argv) {
	const opts = {
		mode: undefined,
		date: undefined,
		patch: undefined,
		timezone: "Europe/Oslo",
		dryRun: false,
		check: false,
		commit: false,
		githubOutput: false,
		printBranch: false,
		printTag: false,
		printVersion: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		switch (arg) {
			case "--mode":
				opts.mode = consumeOptionValue(argv, i, arg);
				i++;
				break;
			case "--date":
				opts.date = consumeOptionValue(argv, i, arg);
				i++;
				break;
			case "--patch":
				opts.patch = parseInt(consumeOptionValue(argv, i, arg), 10);
				if (Number.isNaN(opts.patch) || opts.patch < 0) {
					throw new Error("--patch must be a non-negative integer");
				}
				i++;
				break;
			case "--timezone":
				opts.timezone = consumeOptionValue(argv, i, arg);
				i++;
				break;
			case "--dry-run":
				opts.dryRun = true;
				break;
			case "--check":
				opts.check = true;
				opts.dryRun = true;
				break;
			case "--commit":
				opts.commit = true;
				break;
			case "--github-output":
				opts.githubOutput = true;
				break;
			case "--print-branch":
				opts.printBranch = true;
				break;
			case "--print-tag":
				opts.printTag = true;
				break;
			case "--print-version":
				opts.printVersion = true;
				break;
			case "-h":
			case "--help":
				printHelp();
				process.exit(0);
				break;
			default:
				break;
		}
	}

	if (opts.githubOutput) {
		const printFlags = [
			opts.printBranch && "--print-branch",
			opts.printTag && "--print-tag",
			opts.printVersion && "--print-version",
		].filter(Boolean);
		if (printFlags.length > 0) {
			throw new Error(
				`--github-output cannot be combined with ${printFlags.join(", ")}`,
			);
		}
	}

	return opts;
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

export function getBaseReleaseFromDate({ yy, mm }) {
	switch (mm) {
		case 2:
		case 3:
		case 4:
			mm = 2;
			break;
		case 5:
		case 6:
		case 7:
			mm = 5;
			break;
		case 8:
		case 9:
		case 10:
			mm = 8;
			break;
		case 11:
		case 12:
			mm = 11;
			break;
		case 1:
			yy--;
			mm = 11;
			break;
		default:
			break;
	}

	return { yy: yy % 100, mm, pp: 0 };
}

export function inferTodayYymmdd(timezone = "Europe/Oslo") {
	const formatter = new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		year: "2-digit",
		month: "2-digit",
		day: "2-digit",
	});
	const dateParts = formatter.formatToParts(new Date());
	const getDatePart = (type) =>
		dateParts.find((part) => part.type === type)?.value;

	const yy = Number(getDatePart("year"));
	const mm = Number(getDatePart("month"));
	const dd = Number(getDatePart("day"));

	return { yy, mm, dd };
}

// tags for nightly releases
export function nightlyVersionFromDate({ yy, mm, dd }) {
	return `0.0.0-nightly.${pad2(yy)}${pad2(mm)}${pad2(dd)}`;
}

// used for tags and branch name
export function marketingFromRelease({ yy, mm, pp = 0 }) {
	if (pp <= 0) {
		return `${yy}.${pad2(mm)}`;
	}
	return `${yy}.${pad2(mm)}.${pad2(pp)}`;
}

// semver compatible version string
export function fileVersionFromRelease({ yy, mm, pp = 0 }) {
	return `${yy}.${mm}.${pp}`;
}

export function migrationFileBaseFromRelease({ yy, mm, pp = 0 }) {
	return `${pad2(yy)}_${pad2(mm)}_${pad2(pp)}`;
}

// manual date specified; YYMM has no day (nightly needs YYMMDD or inferred clock date)
export function getDateFromDateString(dateArg) {
	const yy = Number(dateArg.slice(0, 2));
	const mm = Number(dateArg.slice(2, 4));
	const dd = dateArg.length >= 6 ? Number(dateArg.slice(4, 6)) : undefined;

	return { yy, mm, dd };
}

/** release/26.05 */
function parseReleaseBranch(branch) {
	const result = /^release\/(\d{2})\.(\d{2})$/.exec(branch ?? "");
	if (!result) return undefined;
	return getDateFromDateString(`${result[1]}${result[2]}`);
}

function inferModeFromBranch(branch) {
	if (branch === "main") return "nightly";
	if (parseReleaseBranch(branch)) return "patch";
	return undefined;
}

// get the name of the current branch
function getCurrentGitBranch() {
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: REPO_ROOT,
			encoding: "utf8",
		}).trim();
		log(`current git branch: ${branch}`);
		return branch;
	} catch {
		log("could not determine git branch (not a git repo?)");
		return undefined;
	}
}

function getLatestTagForMarketing(marketing) {
	try {
		const tags = execSync('git tag -l "v*.*.*" --sort=-v:refname', {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.filter(Boolean);
		const prefix = `v${marketing}.`;
		const match = tags.find((t) => t.startsWith(prefix)) ?? null;
		log(
			match
				? `latest tag for v${marketing}.*: ${match}`
				: `no existing tags matching v${marketing}.*`,
		);
		return match;
	} catch {
		log("could not list git tags");
		return null;
	}
}

function patchFromTag(tag) {
	const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	if (!m) throw new Error(`Invalid tag: ${tag}`);
	return parseInt(m[3], 10);
}

function dateFromReleaseBranch(branch) {
	return parseReleaseBranch(branch);
}

function readCurrentSystemVersion() {
	const content = fs.readFileSync(CURRENT_VERSION_TS, "utf8");
	const m = /export const CURRENT_SYSTEM_VERSION = '([^']+)'/.exec(content);
	if (!m) throw new Error("Could not parse CURRENT_SYSTEM_VERSION");
	return m[1];
}

function updateCurrentSystemVersion(version, dryRun) {
	const content = fs.readFileSync(CURRENT_VERSION_TS, "utf8");
	const updated = content.replace(
		/export const CURRENT_SYSTEM_VERSION = '[^']+'/,
		`export const CURRENT_SYSTEM_VERSION = '${version}'`,
	);
	if (content === updated) {
		log(`currentSystemVersion.ts already at ${version}`);
		return false;
	}
	if (dryRun) {
		log(`[dry-run] would set CURRENT_SYSTEM_VERSION to ${version}`);
	} else {
		fs.writeFileSync(CURRENT_VERSION_TS, updated);
		log(`updated currentSystemVersion.ts → ${version}`);
	}
	return true;
}

function updateMeteorPackageVersion(version, dryRun) {
	const pkg = JSON.parse(fs.readFileSync(METEOR_PKG, "utf8"));
	if (pkg.version === version) {
		log(`meteor/package.json already at ${version}`);
		return false;
	}
	pkg.version = version;
	if (dryRun) {
		log(`[dry-run] would set meteor/package.json version to ${version}`);
	} else {
		fs.writeFileSync(METEOR_PKG, `${JSON.stringify(pkg, null, "\t")}\n`);
		log(`updated meteor/package.json → ${version}`);
	}
	return true;
}

// update all versions in the packages directory
function runLernaSetVersion(version, dryRun) {
	if (dryRun) {
		log(
			`[dry-run] would run in packages/: yarn set-version ${version} --force-publish`,
		);
		return;
	}
	log(`running yarn set-version ${version} --force-publish in packages/`);
	execSync(`yarn set-version ${version} --force-publish`, {
		cwd: path.join(REPO_ROOT, "packages"),
		stdio: "inherit",
		env: { ...process.env, CI: "true" },
	});
	log("lerna set-version finished");
}

function lernaVersionOutOfSync(targetVersion) {
	const lerna = JSON.parse(fs.readFileSync(LERNA_JSON, "utf8"));
	return lerna.version !== targetVersion;
}

function hasMigrationSteps(filePath) {
	if (!fs.existsSync(filePath)) return false;
	const content = fs.readFileSync(filePath, "utf8");
	return /\bid:\s*`/.test(content);
}

function releaseFromSystemVersion(currentSystemVersion) {
	if (!currentSystemVersion.startsWith("0.0.0-nightly.")) {
		const currentRelease = String(currentSystemVersion).split(".");
		const yy = currentRelease[0];
		const mm = currentRelease[1];
		const pp = currentRelease[2];

		return { yy, mm, pp };
	}

	return undefined;
}

function releaseLinesMatch(a, b) {
	return Number(a.yy) === Number(b.yy) && Number(a.mm) === Number(b.mm);
}

function branchMatchesReleaseLine(branch, baseRelease) {
	const branchDate = parseReleaseBranch(branch);
	if (!branchDate) return false;
	return releaseLinesMatch(getBaseReleaseFromDate(branchDate), baseRelease);
}

/** Highest known patch on this release line when branch matches (from version file or tags). */
function getEstablishedPatchForReleaseLine(baseRelease, branch) {
	if (!branchMatchesReleaseLine(branch, baseRelease)) {
		return undefined;
	}

	const currentSystemVersion = readCurrentSystemVersion();
	const fromVersion = releaseFromSystemVersion(currentSystemVersion);
	if (
		fromVersion &&
		releaseLinesMatch(
			{ yy: Number(fromVersion.yy), mm: Number(fromVersion.mm) },
			baseRelease,
		)
	) {
		const pp = Number(fromVersion.pp);
		log(
			`established patch ${pp} from currentSystemVersion on branch release line`,
		);
		return pp;
	}

	const marketing = marketingFromRelease({
		yy: baseRelease.yy,
		mm: baseRelease.mm,
		pp: 0,
	});
	const latestTag = getLatestTagForMarketing(marketing);
	if (latestTag) {
		const pp = patchFromTag(latestTag);
		log(`established patch ${pp} from tag ${latestTag} on branch release line`);
		return pp;
	}

	return 0;
}

function assertNoAutoPatchDecrementToZero(
	proposedPatch,
	baseRelease,
	branch,
	explicitPatch,
) {
	if (explicitPatch !== undefined) {
		return proposedPatch;
	}
	if (proposedPatch !== 0) {
		return proposedPatch;
	}

	const established = getEstablishedPatchForReleaseLine(baseRelease, branch);
	if (established === undefined || established === 0) {
		return proposedPatch;
	}

	const line = marketingFromRelease({ ...baseRelease, pp: 0 });
	throw new Error(
		`refusing to automatically set patch 0: ${line} already has patch ${established} (branch ${branch}). Pass --patch to override.`,
	);
}

function resolvePatchNumber(mode, explicitPatch, baseRelease, branch) {
	let patch;

	if (mode === "stable") {
		if (explicitPatch !== undefined && explicitPatch !== 0) {
			throw new Error(
				"--patch is only valid with --mode patch (stable releases always use patch 0)",
			);
		}
		patch = explicitPatch ?? 0;
		log(
			explicitPatch === undefined
				? "patch 0 (stable release)"
				: `patch ${patch} (stable release, from --patch)`,
		);
	} else if (explicitPatch !== undefined) {
		patch = explicitPatch;
		log(`patch ${patch} (from --patch)`);
	} else {
		const currentSystemVersion = readCurrentSystemVersion();
		log(`current system version: ${currentSystemVersion}`);

		const currentRelease = releaseFromSystemVersion(currentSystemVersion);

		if (
			currentRelease &&
			releaseLinesMatch(
				{
					yy: Number(currentRelease.yy),
					mm: Number(currentRelease.mm),
				},
				baseRelease,
			)
		) {
			patch = Number(currentRelease.pp) + 1;
			log(
				`patch ${patch} (increment from currentSystemVersion ${currentSystemVersion})`,
			);
		} else {
			const marketing = marketingFromRelease({
				yy: baseRelease.yy,
				mm: baseRelease.mm,
				pp: 0,
			});
			const latestTag = getLatestTagForMarketing(marketing);
			if (latestTag) {
				patch = patchFromTag(latestTag) + 1;
				log(`patch ${patch} (increment from tag ${latestTag})`);
			} else {
				patch = 1;
				log("patch 1 (no prior release version or tag on this line)");
			}
		}
	}

	return assertNoAutoPatchDecrementToZero(
		patch,
		baseRelease,
		branch,
		explicitPatch,
	);
}

export function nightlyVersionFromVersionDate(versionDate) {
	if (versionDate.dd === undefined) {
		throw new Error(
			"Nightly versions require --date YYMMDD (or inferred full calendar date)",
		);
	}

	const branch = getCurrentGitBranch();
	const hash = execSync("git rev-parse --short HEAD", {
		cwd: REPO_ROOT,
		encoding: "utf8",
	}).trim();

	let suffix = "";

	// Only add metadata if not on main
	if (branch !== "main") {
		suffix = `-${branch}-${hash}`;
	}

	return `0.0.0-nightly.${pad2(versionDate.yy)}${pad2(versionDate.mm)}${pad2(versionDate.dd)}${suffix}`;
}

function resolveTarget(opts) {
	const mode = opts.mode;
	if (!mode || !["stable", "patch", "nightly"].includes(mode)) {
		throw new Error("--mode is required (stable | patch | nightly)");
	}
	log(`mode: ${mode}`);
	const branch = getCurrentGitBranch();

	let versionDate = inferTodayYymmdd(opts.timezone);
	const dateRaw = opts.date;
	if (dateRaw) {
		versionDate = getDateFromDateString(dateRaw);
		log(`version date from --date ${dateRaw}: ${JSON.stringify(versionDate)}`);
	} else {
		log(
			`version date inferred (${opts.timezone}): ${JSON.stringify(versionDate)}`,
		);
	}

	if (mode === "nightly") {
		const fileVersion = nightlyVersionFromVersionDate(versionDate);
		const scheduledNightly = branch === "main";
		log(`resolved nightly fileVersion=${fileVersion}`);
		if (!scheduledNightly) {
			log(
				`branch-specific nightly (not on main); version sync only, not eligible for --commit`,
			);
		}
		return {
			mode,
			marketing: fileVersion.replace("0.0.0-", "").replace(".", ""),
			fileVersion,
			branch,
			floatingTag: "nightly",
			scheduledNightly,
		};
	}

	if (
		opts.patch !== undefined &&
		mode !== "patch" &&
		!(mode === "stable" && opts.patch === 0)
	) {
		throw new Error("--patch requires --mode patch");
	}

	const versionDateFromBranch = dateFromReleaseBranch(branch);
	if (versionDateFromBranch) {
		log(
			`version date from branch ${branch}: ${JSON.stringify(versionDateFromBranch)}`,
		);
	} else if (branch?.startsWith("release/")) {
		log(`branch ${branch} is not release/YY.MM; using inferred date`);
	}
	const effectiveDate = versionDateFromBranch ?? versionDate;
	const baseRelease = getBaseReleaseFromDate(effectiveDate);
	log(
		`release line: ${baseRelease.yy}.${pad2(baseRelease.mm)} (patch resolved next)`,
	);
	const release = {
		...baseRelease,
		pp: resolvePatchNumber(mode, opts.patch, baseRelease, branch),
	};
	const marketing = `v${marketingFromRelease(release)}`;
	const fileVersion = fileVersionFromRelease(release);
	log(`resolved tag=${marketing} fileVersion=${fileVersion}`);

	return {
		mode,
		marketing,
		fileVersion,
		release,
		branch,
		floatingTag: `latest`,
	};
}

function rotateMigrations(release, dryRun) {
	if (!fs.existsSync(X_X_X_FILE)) {
		log("X_X_X.ts not found; skipping migration rotation");
		return false;
	}
	if (!hasMigrationSteps(X_X_X_FILE)) {
		log("X_X_X.ts has no migration steps; skipping migration file rename");
		return false;
	}

	const fileVersion = fileVersionFromRelease(release);
	const base = `${release.yy}_${release.mm}_${release.pp ?? 0}`;
	const destFile = path.join(MIGRATION_DIR, `${base}.ts`);
	log(`rotating X_X_X.ts → ${base}.ts (version ${fileVersion})`);
	if (fs.existsSync(destFile)) {
		throw new Error(`Migration file already exists: ${destFile}`);
	}

	let content = fs.readFileSync(X_X_X_FILE, "utf8");
	content = content.replace(
		/import \{ CURRENT_SYSTEM_VERSION \} from '\.\/currentSystemVersion'\n/,
		"",
	);
	content = content.replace(
		/addMigrationSteps\(CURRENT_SYSTEM_VERSION,/,
		`addMigrationSteps('${fileVersion}',`,
	);

	const importName = `addSteps${base}`;
	const oldImport = `import { addSteps as addStepsX_X_X } from './X_X_X'`;
	const newImport = `import { addSteps as ${importName} } from './${base}'`;
	let migrationsContent = fs.readFileSync(MIGRATIONS_TS, "utf8");
	migrationsContent = migrationsContent.replace(oldImport, newImport);
	migrationsContent = migrationsContent.replace(
		"addStepsX_X_X()",
		`${importName}()`,
	);

	if (!dryRun) {
		fs.writeFileSync(destFile, content);
		fs.unlinkSync(X_X_X_FILE);
		fs.writeFileSync(MIGRATIONS_TS, migrationsContent);
		fs.writeFileSync(X_X_X_FILE, X_X_X_STUB);
		log(`wrote ${destFile}, updated migrations.ts, recreated X_X_X.ts stub`);
	} else {
		log(`[dry-run] would rename X_X_X.ts → ${base}.ts`);
		log("[dry-run] would update migrations.ts and recreate X_X_X.ts stub");
	}
	return true;
}

function versionSync(target, opts) {
	const { dryRun, check } = opts;
	const readOnly = dryRun || check;
	log(
		`syncing version ${target.fileVersion}${readOnly ? (check ? " (check)" : " (dry-run)") : ""}`,
	);
	let changed = false;

	changed = updateCurrentSystemVersion(target.fileVersion, readOnly) || changed;
	changed = updateMeteorPackageVersion(target.fileVersion, readOnly) || changed;

	if (lernaVersionOutOfSync(target.fileVersion)) {
		runLernaSetVersion(target.fileVersion, readOnly);
		changed = true;
	} else {
		log(`packages/lerna.json already at ${target.fileVersion}`);
	}

	if (target.mode === "stable") {
		changed = rotateMigrations(target.release, readOnly) || changed;
	} else if (target.mode === "nightly") {
		log(
			"skipping X_X_X seal (nightly); version bump triggers full migration rerun including WIP steps",
		);
	} else {
		log(`skipping migration rotation (mode=${target.mode})`);
	}

	if (changed) {
		log(readOnly ? "repository would change" : "repository was updated");
	} else {
		log("no file changes required");
	}

	return changed;
}

function releaseBranchName(release) {
	return `release/${marketingFromRelease({ yy: release.yy, mm: release.mm, pp: 0 })}`;
}

function isScheduledNightly(target) {
	return target.mode === "nightly" && target.scheduledNightly === true;
}

function versionsAtTarget(target) {
	if (readCurrentSystemVersion() !== target.fileVersion) {
		return false;
	}
	const meteorVersion = JSON.parse(fs.readFileSync(METEOR_PKG, "utf8")).version;
	if (meteorVersion !== target.fileVersion) {
		return false;
	}
	return !lernaVersionOutOfSync(target.fileVersion);
}

function gitTagFromTarget(target) {
	return target.mode === "nightly" ? target.fileVersion : target.marketing;
}

function commitMessageForTarget(target) {
	const tag = gitTagFromTarget(target);
	const version = target.fileVersion;

	if (target.mode === "stable" || target.mode === "patch") {
		return `chore(release): ${tag} [skip ci]`;
	}
	if (target.mode === "nightly") {
		return `chore(nightly): ${tag} [skip ci]`;
	}
	return `chore(release): ${tag} [skip ci]`;
}

const VERSION_COMMIT_PATHS = [
	"meteor/package.json",
	"meteor/server/migration",
	"packages/lerna.json",
	"packages",
	"yarn.lock",
];

function runGit(args, readOnly) {
	if (readOnly) {
		log(`[dry-run] git ${args.join(" ")}`);
		return;
	}
	execFileSync("git", args, { cwd: REPO_ROOT, stdio: "inherit" });
}

function gitTagExists(tag) {
	try {
		execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
			cwd: REPO_ROOT,
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

function isReleaseTagName(tag, target) {
	if (target.mode === "nightly") {
		return /^0\.0\.0-nightly\./.test(tag);
	}
	return /^v\d+\.\d+\.\d+$/.test(tag);
}

function tagsPointingAtHead() {
	try {
		return execSync("git tag --points-at HEAD", {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}

function headHasReleaseTag(target) {
	const atHead = tagsPointingAtHead().filter((t) =>
		isReleaseTagName(t, target),
	);
	if (atHead.length > 0) {
		log(`HEAD already tagged: ${atHead.join(", ")}`);
		return true;
	}
	return false;
}

function getLatestNightlyTag() {
	try {
		const tags = execSync('git tag -l "0.0.0-nightly.*" --sort=-v:refname', {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.filter(Boolean);
		return tags[0] ?? null;
	} catch {
		return null;
	}
}

function previousReleaseTagForTarget(target) {
	if (target.mode === "nightly") {
		return getLatestNightlyTag();
	}
	if (target.release) {
		return getLatestTagForMarketing(
			marketingFromRelease({
				yy: target.release.yy,
				mm: target.release.mm,
				pp: 0,
			}),
		);
	}
	return null;
}

function commitCountSinceTag(tag) {
	const count = execSync(`git rev-list --count ${tag}..HEAD`, {
		cwd: REPO_ROOT,
		encoding: "utf8",
	}).trim();
	return parseInt(count, 10);
}

/** True when HEAD is already a release or has no commits since the prior release tag. */
function shouldSkipRelease(target) {
	if (gitTagExists(gitTagFromTarget(target))) {
		log(`target tag ${gitTagFromTarget(target)} already exists`);
		return true;
	}

	if (isScheduledNightly(target) && !versionsAtTarget(target)) {
		log("nightly version files not at target; release required");
		return false;
	}

	if (headHasReleaseTag(target)) {
		return true;
	}

	const previous = previousReleaseTagForTarget(target);
	if (!previous) {
		log("no previous release tag on this line");
		return false;
	}

	const commitsSince = commitCountSinceTag(previous);
	log(`${commitsSince} commit(s) since ${previous}`);
	if (commitsSince === 0) {
		log("no new commits since previous release tag");
		return true;
	}

	return false;
}

function hasStagedChanges() {
	try {
		execSync("git diff --cached --quiet", {
			cwd: REPO_ROOT,
			stdio: "pipe",
		});
		return false;
	} catch {
		return true;
	}
}

function shouldApplyFloatingTag(target) {
	if (target.mode === "nightly") {
		return target.scheduledNightly === true;
	}
	return target.mode === "stable" || target.mode === "patch";
}

function commitForFloatingTag(floating) {
	if (!gitTagExists(floating)) {
		return null;
	}
	return execSync(`git rev-parse ${floating}^{commit}`, {
		cwd: REPO_ROOT,
		encoding: "utf8",
	}).trim();
}

function moveFloatingTag(target, readOnly) {
	if (!shouldApplyFloatingTag(target)) {
		return;
	}

	const floating = target.floatingTag;
	const previous = commitForFloatingTag(floating);
	if (previous) {
		const head = execSync("git rev-parse HEAD", {
			cwd: REPO_ROOT,
			encoding: "utf8",
		}).trim();
		if (previous === head) {
			log(`floating tag ${floating} already on HEAD`);
			return;
		}
		log(
			`moving floating tag ${floating} from ${previous.slice(0, 7)} to HEAD (removes it from the prior release)`,
		);
	} else {
		log(`creating floating tag ${floating} on HEAD`);
	}

	runGit(["tag", "-f", floating, "HEAD"], readOnly);

	if (!readOnly) {
		log(
			`floating tag ${floating} updated — push with: git push origin ${gitTagFromTarget(target)} +${floating}`,
		);
	}
}

/** Tag HEAD when versions are already bumped (new commits since last nightly). */
function tagVersionOnHead(target, readOnly) {
	const tag = gitTagFromTarget(target);
	const message = commitMessageForTarget(target);

	if (gitTagExists(tag)) {
		throw new Error(`git tag already exists: ${tag}`);
	}

	log(`tagging HEAD as ${tag} (versions already at target)`);
	runGit(["tag", tag, "-m", message], readOnly);
	moveFloatingTag(target, readOnly);

	if (!readOnly) {
		log(`tagged HEAD as ${tag}`);
	}
}

function githubOutputPayload(target, { skipped }) {
	const payload = {
		mode: target.mode,
		tag: gitTagFromTarget(target),
		floatingTag: target.floatingTag,
		skipped,
	};
	if (target.release) {
		payload.branch = releaseBranchName(target.release);
	} else if (target.branch) {
		payload.branch = target.branch;
	}
	return payload;
}

function commitAndTag(target, readOnly) {
	const tag = gitTagFromTarget(target);
	const message = commitMessageForTarget(target);

	if (gitTagExists(tag)) {
		throw new Error(`git tag already exists: ${tag}`);
	}

	log("staging version files for commit");
	runGit(["add", "--", ...VERSION_COMMIT_PATHS], readOnly);

	if (!readOnly && !hasStagedChanges()) {
		throw new Error("nothing staged to commit after version sync");
	}

	log(`committing as: ${message}`);
	runGit(["commit", "-m", message], readOnly);

	log(`creating tag ${tag}`);
	runGit(["tag", tag, "-m", message], readOnly);
	moveFloatingTag(target, readOnly);

	if (!readOnly) {
		log(`committed and tagged ${tag}`);
	}
}

function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (
		opts.githubOutput ||
		opts.printBranch ||
		opts.printTag ||
		opts.printVersion
	) {
		bufferLogs = true;
	}

	if (!opts.mode) {
		const branch = getCurrentGitBranch();
		opts.mode = inferModeFromBranch(branch);
		if (!opts.mode) {
			log(
				`cannot infer --mode from branch "${branch ?? "(unknown)"}"; use --mode stable|patch|nightly`,
			);
			printHelp();
			exitWithStatus(1);
		}
		log(`inferred --mode ${opts.mode} from branch ${branch}`);
	}

	if (opts.commit && opts.check) {
		throw new Error("--commit cannot be used with --check");
	}

	log(
		`started with options: mode=${opts.mode} date=${opts.date ?? "(inferred)"} timezone=${opts.timezone}${opts.dryRun ? " dry-run" : ""}${opts.check ? " check" : ""}${opts.commit ? " commit" : ""}`,
	);

	const target = resolveTarget(opts);

	if (opts.printBranch) {
		if (!target.release) {
			throw new Error("--print-branch is not available for nightly mode");
		}
		console.log(releaseBranchName(target.release));
		return;
	}
	if (opts.printTag) {
		console.log(target.marketing);
		return;
	}
	if (opts.printVersion) {
		console.log(target.fileVersion);
		return;
	}

	log(
		`target: fileVersion=${target.fileVersion} tag=${target.marketing} floatingTag=${target.floatingTag}`,
	);
	if (target.release) {
		log(`release branch name: ${releaseBranchName(target.release)}`);
	}

	if (opts.commit && target.mode === "nightly" && !isScheduledNightly(target)) {
		throw new Error(
			`--commit is only valid for scheduled nightly releases on main (got ${target.fileVersion} on ${target.branch ?? "(unknown)"})`,
		);
	}

	let skipped = false;

	if (opts.commit && shouldSkipRelease(target)) {
		skipped = true;
		log("skipping release (--commit): nothing new since previous release tag");
	} else {
		const changed = versionSync(target, opts);

		if (opts.check && changed) {
			throw new Error("repository is out of sync");
		}

		if (opts.check && !changed) {
			log("check passed: versions are in sync");
		}

		if (opts.commit) {
			if (changed) {
				commitAndTag(target, opts.dryRun);
			} else if (isScheduledNightly(target)) {
				tagVersionOnHead(target, opts.dryRun);
			} else {
				log("no version file changes to commit");
			}
		}
	}

	if (opts.githubOutput) {
		console.log(JSON.stringify(githubOutputPayload(target, { skipped })));
		return;
	}

	if (opts.dryRun) {
		log("dry-run complete (no files written)");
	} else if (!opts.check) {
		log("done");
	}
}

/** @internal Exported for node --test only */
export const testing = {
	parseArgs,
	parseReleaseBranch,
	inferModeFromBranch,
	releaseBranchName,
	releaseLinesMatch,
	branchMatchesReleaseLine,
	gitTagFromTarget,
	commitMessageForTarget,
	githubOutputPayload,
	patchFromTag,
};

const isMain =
	process.argv[1] &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
	try {
		main();
	} catch (err) {
		if (bufferLogs) {
			flushLogs();
		}
		logError(err instanceof Error ? err.message : String(err));
		exitWithStatus(1);
	}
}
