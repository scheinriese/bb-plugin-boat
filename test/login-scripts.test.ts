// Ubuntu's login message scripts are turned off over boat's exec API before bb's SSH setup.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QUIET_LOGIN_SCRIPT, createLoginQuieter, parseQuietLogin } from "../src/login-scripts.ts";

test("the script turns the scripts off inside the folder only, once, then changes nothing (run here on a copy, without sudo)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "boat-motd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, "update-motd.d");
  const outside = join(dir, "usr-share-landscape");
  mkdirSync(scripts);
  mkdirSync(outside);
  const script = (path: string) => {
    writeFileSync(path, "#!/bin/sh\necho hi\n");
    chmodSync(path, 0o755);
  };
  script(join(scripts, "00-header"));
  script(join(scripts, "90-updates-available"));
  // Ubuntu's 50-landscape-sysinfo is a link to a package file elsewhere.
  script(join(outside, "landscape-sysinfo.wrapper"));
  symlinkSync(join(outside, "landscape-sysinfo.wrapper"), join(scripts, "50-landscape-sysinfo"));
  symlinkSync(join(scripts, "00-header"), join(scripts, "10-help-text"));
  const local = (target: string) => QUIET_LOGIN_SCRIPT.replace("D=/etc/update-motd.d", `D=${target}`).replaceAll("sudo -n ", "");
  const run = (target: string) => execFileSync("bash", ["-c", local(target)], { encoding: "utf8" });
  assert.equal(parseQuietLogin(run(scripts)), "disabled");
  assert.equal(statSync(join(scripts, "90-updates-available")).mode & 0o111, 0);
  assert.equal(statSync(join(scripts, "00-header")).mode & 0o111, 0);
  assert.equal(statSync(join(outside, "landscape-sysinfo.wrapper")).mode & 0o111, 0o111, "the package file outside keeps its execute bit");
  assert.deepEqual(readdirSync(scripts).sort(), ["00-header", "10-help-text.disabled", "50-landscape-sysinfo.disabled", "90-updates-available"]);
  assert.equal(lstatSync(join(scripts, "50-landscape-sysinfo.disabled")).isSymbolicLink(), true, "the link is only renamed");
  // run-parts --lsbsysinit (what PAM's motd runs) runs none of them now, when it's here to ask.
  const runParts = spawnSync("run-parts", ["--test", "--lsbsysinit", scripts], { encoding: "utf8" });
  if (runParts.error === undefined) assert.equal(runParts.stdout, "");
  assert.equal(parseQuietLogin(run(scripts)), "off", "already off: nothing to do");
  assert.equal(parseQuietLogin(run(join(dir, "missing"))), "none");
  assert.equal(parseQuietLogin(""), "failed");
});

test("a .disabled name is one run-parts --lsbsysinit skips (a .boat-off name it would still run)", (t) => {
  const runParts = spawnSync("run-parts", ["--version"], { encoding: "utf8" });
  if (runParts.error !== undefined) return t.skip("run-parts isn't installed here");
  const dir = mkdtempSync(join(tmpdir(), "boat-runparts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["50-landscape-sysinfo.disabled", "50-landscape-sysinfo.boat-off"]) {
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), 0o755);
  }
  assert.equal(spawnSync("run-parts", ["--test", "--lsbsysinit", dir], { encoding: "utf8" }).stdout.trim(), join(dir, "50-landscape-sysinfo.boat-off"));
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
