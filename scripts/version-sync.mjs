#!/usr/bin/env node
/**
 * Single source of truth for Sofie Core version synchronization.
 *
 * All version forms derive from one calendar date (--date YYMM or YYMMDD, or inferred).
 *
 * Usage:
 *   node scripts/version-sync.mjs --mode stable|patch|nightly [--date YYMM|YYMMDD] [--dry-run]
 *   node scripts/version-sync.mjs --mode stable --print-branch|--print-tag|--print-version
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const METEOR_PKG = path.join(REPO_ROOT, "meteor/package.json");
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
	console.log(`Usage: node scripts/version-sync.mjs --mode <stable|patch|nightly> [options]

Options:
  --date YYMM|YYMMDD  Calendar date; inferred from branch or clock when omitted
  --patch N           With --mode patch: set patch explicitly (default: auto-increment)
  --timezone TZ       Used when inferring date (default Europe/Oslo)
  --dry-run           Print actions without writing files
  --check             Exit 1 if repo would change (for CI)
  --print-branch      Print release branch name and exit
  --print-tag         Print git tag name and exit
  --print-version     Print file/npm version string and exit

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

// manual date specified, if no day specified, it defaults to the first of the month
export function getDateFromDateString(dateArg) {
	const yy = Number(dateArg.slice(0, 2)) + 2000;
	const mm = dateArg.slice(2, 4);
	const dd = dateArg.length == 6 ? dateArg.slice(2, 4) : 1;

	return { yy, mm, dd };
}

// get the name of the current branch
function getCurrentGitBranch() {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: REPO_ROOT,
			encoding: "utf8",
		}).trim();
	} catch {
		return undefined;
	}
}

// get YYMM dateArg fom the release branch name
function dateFromReleaseBranch(branch) {
	const result = /^release\/(\d{2})\.(\d{2})$/.exec(branch);
	if (!result) return undefined;
	return getDateFromDateString(`${result[1]}${result[2]}`);
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
	if (content === updated) return false;
	if (!dryRun) fs.writeFileSync(CURRENT_VERSION_TS, updated);
	return true;
}

function updateMeteorPackageVersion(version, dryRun) {
	const pkg = JSON.parse(fs.readFileSync(METEOR_PKG, "utf8"));
	if (pkg.version === version) return false;
	pkg.version = version;
	if (!dryRun)
		fs.writeFileSync(METEOR_PKG, `${JSON.stringify(pkg, null, "\t")}\n`);
	return true;
}

// update all versions in the packages directory
function runLernaSetVersion(version, dryRun) {
	if (dryRun) {
		console.log(
			`[dry-run] cd packages && yarn set-version ${version} --force-publish`,
		);
		return;
	}
	execSync(`yarn set-version ${version} --force-publish`, {
		cwd: path.join(REPO_ROOT, "packages"),
		stdio: "inherit",
		env: { ...process.env, CI: "true" },
	});
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

function resolvePatchNumber(mode, explicitPatch) {
	if (mode === "stable") {
		if (explicitPatch !== undefined && explicitPatch !== 0) {
			throw new Error(
				"--patch is only valid with --mode patch (stable releases always use patch 0)",
			);
		}
		return 0;
	}

	if (explicitPatch !== undefined) {
		return explicitPatch;
	}

	const currentSystemVersion = readCurrentSystemVersion();

	const currentRelease = releaseFromSystemVersion(currentSystemVersion);

	if (currentRelease) {
		return currentRelease.pp + 1;
	}

	const latestTag = getLatestTagForMarketing(marketing);
	if (latestTag) {
		return patchFromTag(latestTag) + 1;
	}

	// if this is a nightly version there is no patch number
	return undefined;
}

export function nightlyVersionFromVersionDate(versionDate) {
	if (versionDate.day === undefined) {
		throw new Error(
			"Nightly versions require --date YYMMDD (or inferred full calendar date)",
		);
	}

	const branch = getCurrentGitBranch();
	const hash = execSync("git rev-parse --short HEAD").toString().trim();

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
	const branch = getCurrentGitBranch();

	let versionDate = inferTodayYymmdd(opts.timeZone);
	const dateRaw = opts.date;
	if (dateRaw) {
		versionDate = getDateFromDateString(dateRaw);
	}

	if (mode === "nightly") {
		const fileVersion = nightlyVersionFromVersionDate(versionDate);
		return {
			mode,
			marketing: fileVersion.replace("0.0.0-", "").replace(".", ""),
			fileVersion,
			branch,
			floatingTag: "nightly",
		};
	}

	if (opts.patch !== undefined && mode !== "patch") {
		throw new Error("--patch requires --mode patch");
	}

	const versionDateFromBranch = dateFromReleaseBranch(branch) ?? versionDate;
	const baseRelease = getBaseReleaseFromDate(versionDateFromBranch);
	const release = { ...baseRelease, pp: resolvePatchNumber(mode, opts.patch) };
	const marketing = `v${marketingFromRelease(release)}`;
	const fileVersion = fileVersionFromRelease(release);

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
	if (!fs.existsSync(X_X_X_FILE)) return false;
	if (!hasMigrationSteps(X_X_X_FILE)) {
		console.log(
			"X_X_X.ts has no migration steps; skipping migration file rename",
		);
		return false;
	}

	const base = `${release.yy}_${release.mm}_${release.pp ?? 0}`;
	const destFile = path.join(MIGRATION_DIR, `${base}.ts`);
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
	} else {
		console.log(`[dry-run] rename X_X_X.ts -> ${base}.ts`);
		console.log(`[dry-run] recreate X_X_X.ts stub`);
	}
	return true;
}

function versionSync(target, opts) {
	const { dryRun } = opts;
	let changed = false;

	changed = updateCurrentSystemVersion(target.fileVersion, dryRun) || changed;
	changed = updateMeteorPackageVersion(target.fileVersion, dryRun) || changed;

	if (!dryRun) {
		runLernaSetVersion(target.fileVersion, false);
		changed = true;
	} else {
		console.log(`[dry-run] lerna set-version ${target.fileVersion}`);
		changed = true;
	}

	if (target.mode === "stable") {
		changed = rotateMigrations(target.release, dryRun) || changed;
	}

	return changed;
}
