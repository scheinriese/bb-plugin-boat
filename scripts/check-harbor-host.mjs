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
const command = process.argv.includes("--collision") ? ["plugin", "run", "harbor"] : ["harbor"];
for (const args of [
  ["--help"], ["task", "start", "--help"], ["help", "sandbox"], ["project", "list", "--json"],
  ["project", "list", "--unknown-option", "--json"],
]) {
  const expectedExit = args.includes("--unknown-option") ? 1 : 0;
  const harbor = run([...command, ...args], expectedExit);
  const boat = run(["boat", ...args], expectedExit);
  if (args.includes("--help") || args[0] === "help") {
    assert.match(harbor.stdout, /^bb harbor\b/);
    assert.match(boat.stdout, /^bb boat\b/);
    assert.equal(harbor.stdout.replaceAll("bb harbor", "bb boat"), boat.stdout);
  } else {
    assert.equal(harbor.stdout, boat.stdout, "JSON is unchanged");
  }
  assert.equal(harbor.stderr.replaceAll("bb harbor", "bb boat"), boat.stderr);
}
if (process.argv.includes("--collision")) {
  assert.equal(run(["harbor", "--help"]).stdout, "Collision fixture owns bb harbor.\n");
  assert.match(run(["plugin", "run", "harbor", "--help"]).stdout, /^bb harbor\b/);
  assert.equal(run(["plugin", "run", "harbor", "project", "list", "--json"]).stdout,
    run(["boat", "project", "list", "--json"]).stdout);
}
console.log("PASS: harbor help uses its own name; boat help and JSON are unchanged.");
