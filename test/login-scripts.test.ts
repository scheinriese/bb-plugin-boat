// Ubuntu's login message scripts are turned off over boat's exec API before bb's SSH setup.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QUIET_LOGIN_SCRIPT, createLoginQuieter, parseQuietLogin } from "../src/login-scripts.ts";

test("the script takes the execute bit away once, then changes nothing (run here on a copy, without sudo)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "boat-motd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, "update-motd.d");
  mkdirSync(scripts);
  writeFileSync(join(scripts, "90-updates-available"), "#!/bin/sh\necho updates\n");
  chmodSync(join(scripts, "90-updates-available"), 0o755);
  symlinkSync(join(scripts, "90-updates-available"), join(scripts, "50-landscape-sysinfo"));
  const local = (target: string) => QUIET_LOGIN_SCRIPT.replace("D=/etc/update-motd.d", `D=${target}`).replace("sudo -n ", "");
  const run = (target: string) => execFileSync("bash", ["-c", local(target)], { encoding: "utf8" });
  assert.equal(parseQuietLogin(run(scripts)), "disabled");
  assert.equal(statSync(join(scripts, "90-updates-available")).mode & 0o111, 0);
  assert.equal(parseQuietLogin(run(scripts)), "off", "already off: nothing to do");
  assert.equal(parseQuietLogin(run(join(dir, "missing"))), "none");
  assert.equal(parseQuietLogin(""), "failed");
});

test("one plain exec per sandbox: never a login shell, never again once off, never failing the wake", async () => {
  const execs: { sandboxId: string; login: boolean | undefined }[] = [];
  let answer: () => string = () => "BOAT_MOTD disabled\n";
  const boat = {
    async exec(sandboxId: string, _script: string, options: { login?: boolean } = {}) {
      execs.push({ sandboxId, login: options.login });
      return { exitCode: 0, stdout: answer(), stderr: "" };
    },
  };
  const logs: string[] = [];
  const quiet = createLoginQuieter(boat as never, (line) => logs.push(line));
  assert.equal(await quiet("bx_one"), "disabled");
  assert.equal(await quiet("bx_one"), "off");
  assert.deepEqual(execs, [{ sandboxId: "bx_one", login: false }], "the second wake costs nothing");
  // No sudo there: it says so, bb's setup goes ahead, and the next wake tries again.
  answer = () => "BOAT_MOTD failed\n";
  assert.equal(await quiet("bx_two"), "failed");
  assert.equal(await quiet("bx_two"), "failed");
  assert.equal(execs.filter((entry) => entry.sandboxId === "bx_two").length, 2);
  // boat's exec failing doesn't fail the wake either.
  answer = () => { throw new Error("boat exec timed out"); };
  assert.equal(await quiet("bx_three"), "failed");
  assert.ok(logs.some((line) => line.includes("boat exec timed out")));
});
