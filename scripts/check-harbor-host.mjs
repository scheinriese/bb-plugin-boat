// Read-only checks against the bb selected by BB_CLI and BB_SERVER_URL.
// Install the main plugin and its harbor companion before running this script.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(args, expectedExit = 0) {
  const result = spawnSync(process.env.BB_CLI || "bb", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedExit, result.stderr || result.stdout);
  console.log(`$ bb ${args.join(" ")}`);
  process.stdout.write(result.stdout);
  process.stdout.write(result.stderr);
  console.log(`[exit ${result.status}]\n`);
  return { stdout: result.stdout, stderr: result.stderr };
}

run(["--version"]);
for (const args of [
  ["--help"], ["task", "start", "--help"], ["project", "list", "--json"],
  ["task", "start", "--unknown-option", "--json"],
]) {
  const expectedExit = args.includes("--unknown-option") ? 1 : 0;
  assert.deepEqual(run(["harbor", ...args], expectedExit), run(["boat", ...args], expectedExit));
}
console.log("PASS: both names return identical help, read-only results and parser errors.");
