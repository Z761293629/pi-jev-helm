#!/usr/bin/env node
// Strict release-tag validation for the Pi Jev Helm Release Gate.
//
// The Release Gate workflow (`.github/workflows/release.yml`) runs this before
// any release work: every other job in the workflow depends on the job that
// invokes this script, so a tag that is not exactly `v<package-version>` fails
// the workflow before a single test or install step starts.
//
// Usage:
//   node scripts/validate-release-tag.mjs [tag] [packageJsonPath]
//
// The tag defaults to GITHUB_REF_NAME (the ref a tag-push workflow ran for);
// the manifest defaults to the repository's package.json. Exit status is the
// only output contract: 0 means the tag may be released, 1 means it must not.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Strict semantic version: no leading zeros, optional prerelease and build
// metadata (https://semver.org/#backus-naur-form-grammar-for-valid-semver-versions).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`[release-gate] ${message}`);
  process.exit(1);
}

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag) fail("no tag to validate: set GITHUB_REF_NAME or pass the tag as the first argument");

const manifestPath = process.argv[3] ?? fileURLToPath(new URL("../package.json", import.meta.url));
let version;
try {
  version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
} catch (error) {
  fail(`cannot read the package version from ${manifestPath}: ${error.message}`);
}
if (typeof version !== "string" || !SEMVER.test(version)) {
  fail(`package.json "version" is not a strict semantic version: ${JSON.stringify(version)}`);
}

if (!tag.startsWith("v")) {
  fail(`tag ${JSON.stringify(tag)} does not start with "v"; a release tag must be "v<package-version>"`);
}
if (!SEMVER.test(tag.slice(1))) {
  fail(`tag ${JSON.stringify(tag)} is not "v" plus a strict semantic version`);
}
if (tag !== `v${version}`) {
  fail(
    `tag ${JSON.stringify(tag)} does not equal "v<package-version>": package.json declares ${JSON.stringify(version)}`,
  );
}

console.log(`[release-gate] tag ${tag} equals v<package-version> (package.json ${version})`);
