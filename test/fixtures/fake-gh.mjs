#!/usr/bin/env node
// A fake `gh` for tests: `gh api -H … repos/<owner>/<name>/contents/<path>[?ref=<ref>]`.
// Files come from FAKE_GH_FILES (JSON: {"owner/name:path@ref": "content"}; no
// ref, the default branch: "owner/name:path").
// FAKE_GH_SIGNED_OUT=1: answers like a gh with no login.
const args = process.argv.slice(2);
if (process.env.FAKE_GH_SIGNED_OUT === "1") {
  process.stderr.write("Welcome to GitHub CLI!\n\nTo authenticate, please run `gh auth login`.\n");
  process.exit(4);
}
const target = args.at(-1) ?? "";
const match = /^repos\/([^/]+\/[^/]+)\/contents\/([^?]+)(?:\?ref=(.+))?$/.exec(target);
const files = JSON.parse(process.env.FAKE_GH_FILES ?? "{}");
if (args[0] !== "api" || match === null) {
  process.stderr.write(`fake gh: unsupported ${args.join(" ")}\n`);
  process.exit(2);
}
const key = `${match[1]}:${decodeURIComponent(match[2])}${match[3] === undefined ? "" : `@${decodeURIComponent(match[3])}`}`;
if (!(key in files)) {
  process.stderr.write("gh: Not Found (HTTP 404)\n");
  process.exit(1);
}
process.stdout.write(files[key]);
