// Updating bb on a woken sandbox safely: what Boat looks at, what it decides, the
// fresh-prefix install and swap (the real scripts, run here on a copy with a fake npm and
// systemctl), failures that keep the old bb, and a hung update handed to the wake guard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoatApi } from "../src/providers/boat/api.ts";
import type { BoatCli } from "../src/providers/boat/cli.ts";
import {
  BB_UPDATES_KEY,
  BbUpdateHung,
  compareVersions,
  createBbUpdater,
  decideBbUpdate,
  hostSlug,
  inspectScript,
  installFailureText,
  installScript,
  parseInspection,
  parseInstall,
  setAsideScript,
  updateBackoffMs,
  type BbInstall,
  type HostPrep,
} from "../src/bb-update.ts";
import { registerBoatMachine } from "../src/providers/boat/machine.ts";
import { retriesLater } from "../src/wake-diagnosis.ts";
import { WakePacer } from "../src/wake-pacer.ts";
import { createWakeGuard } from "../src/wake-retry.ts";
import { defaultSettings, makeService } from "./fakes.ts";

const HOST = "host_7f3a.9c";
const SERVER = "bb.example.com";

/** A sandbox's home as bb leaves it: its unit, data dir, an install and maybe a download. */
function sandboxHome(t: { after(fn: () => void): void }, options: { installed?: string | null; tgz?: string | null; bin?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "boat-bb-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const data = join(home, ".bb-machines", SERVER);
  const bin = join(root, "bin");
  const fake = join(root, "fake");
  mkdirSync(bin, { recursive: true });
  mkdirSync(fake, { recursive: true });
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  const unit = `bb-host-daemon-${SERVER.replace(/\./g, "-")}-${hostSlug(HOST)}.service`;
  writeFileSync(
    join(home, ".config", "systemd", "user", unit),
    `[Service]\nExecStart="/opt/node/bin/node" "${data}/npm/bin/bb-app" host-daemon --auto-update --host-daemon-port "7777" --server-url "https://${SERVER}"\nEnvironment="BB_APP_NPM_PREFIX=${data}/npm"\nEnvironment="BB_DATA_DIR=${data}"\nRestart=always\n`,
  );
  const install = (prefix: string, version: string) => {
    const pkg = join(prefix, "lib", "node_modules", "bb-app");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "host-daemon", "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), `{\n  "name": "bb-app",\n  "version": "${version}",\n  "dependencies": {\n    "npm": { "version": "9.9.9" }\n  }\n}\n`);
    writeFileSync(join(pkg, "dist", "bb-app.js"), "// bb-app\n");
    writeFileSync(join(pkg, "host-daemon", "dist", "daemon-bundle.mjs"), "// daemon\n");
  };
  if (options.installed !== null) {
    install(join(data, "npm"), options.installed ?? "0.49.0");
    if (options.bin !== false) {
      mkdirSync(join(data, "npm", "bin"), { recursive: true });
      symlinkSync("../lib/node_modules/bb-app/dist/bb-app.js", join(data, "npm", "bin", "bb-app"));
    }
  } else mkdirSync(data, { recursive: true });
  let tgzFile: string | null = null;
  if (options.tgz !== null) {
    const stage = join(root, "stage", "package");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "package.json"), `{\n  "name": "bb-app",\n  "version": "${options.tgz ?? "0.50.1"}"\n}\n`);
    mkdirSync(join(data, "host-package-download"), { recursive: true });
    tgzFile = join(data, "host-package-download", "bb-app.tgz");
    execFileSync("tar", ["-czf", tgzFile, "-C", join(root, "stage"), "package"]);
  }
  // systemctl --user: the unit's state lives in a file; every call is logged.
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/bash
echo "systemctl $*" >> "${fake}/log"
case "$*" in
  *" show "*"--value"*) cat "${fake}/active" 2>/dev/null || echo inactive ;;
  *" show "*) echo "ActiveState=$(cat "${fake}/active" 2>/dev/null || echo inactive)"; echo "SubState=\${FAKE_SUB:-dead}"; echo "Result=\${FAKE_RESULT:-success}"; echo "NRestarts=\${FAKE_RESTARTS:-0}"; echo "StateChangeTimestampMonotonic=1000000" ;;
  *" stop "*) echo "\${FAKE_STOP_TO:-inactive}" > "${fake}/active" ;;
  *" start "*) echo active > "${fake}/active" ;;
esac
exit 0
`,
  );
  writeFileSync(join(bin, "journalctl"), `#!/bin/bash\necho "journalctl $*" >> "${fake}/log"\ncat "${fake}/journal" 2>/dev/null\nexit 0\n`);
  // ps: the listing, then (when a test asks) a change to procfs right after the first look.
  writeFileSync(join(bin, "ps"), `#!/bin/bash\ncat "${fake}/ps" 2>/dev/null\n[ -f "${fake}/ps-after" ] && { (sleep 0.3; bash "${fake}/ps-after") & }\nexit 0\n`);
  // npm pack --pack-destination <dir> bb-app@<v>: the registry's bb-app-<v>.tgz (or fails, hangs or
  // sends another version, as told). npm install -g --prefix <dir> <tgz>: makes bb-app at the tgz's
  // version (or fails, or makes another version, as told).
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/bash
echo "npm $* cache=$npm_config_cache" >> "${fake}/log"
if [ "$1" = pack ]; then
  dest=; spec=
  while [ $# -gt 0 ]; do case "$1" in --pack-destination) dest=$2; shift 2 ;; *) spec=$1; shift ;; esac; done
  [ -n "\${FAKE_PACK_HANG:-}" ] && exec sleep 600
  # Something else happens on the sandbox while the registry answers (bb repairs itself, say).
  [ -f "${fake}/pack-hook" ] && bash "${fake}/pack-hook"
  if [ -n "\${FAKE_PACK_FAIL:-}" ]; then echo "npm error code $FAKE_PACK_FAIL" >&2; exit 1; fi
  v=\${FAKE_PACK_VERSION:-\${spec#bb-app@}}
  s=$(mktemp -d); mkdir -p "$s/package"
  printf '{\\n  "name": "bb-app",\\n  "version": "%s"\\n}\\n' "$v" > "$s/package/package.json"
  tar -czf "$dest/bb-app-$v.tgz" -C "$s" package; rm -rf "$s"
  echo "bb-app-$v.tgz"
  exit 0
fi
prefix=; last=
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix=$2; shift 2 ;; *) last=$1; shift ;; esac; done
if [ -n "\${FAKE_NPM_FAIL:-}" ]; then echo "npm error code $FAKE_NPM_FAIL" >&2; exit 1; fi
v=\${FAKE_NPM_VERSION:-$(tar -xzOf "$last" package/package.json | sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' | head -n 1)}
p="$prefix/lib/node_modules/bb-app"
mkdir -p "$p/dist" "$p/host-daemon/dist" "$prefix/bin" "$p/node_modules/node-pty" "$p/node_modules/@parcel/watcher"
printf '{\\n  "name": "bb-app",\\n  "version": "%s"\\n}\\n' "$v" > "$p/package.json"
echo 'module.exports = {};' > "$p/node_modules/node-pty/index.js"
[ -n "\${FAKE_NO_NATIVE:-}" ] || echo 'module.exports = {};' > "$p/node_modules/@parcel/watcher/index.js"
touch "$p/dist/bb-app.js" "$p/host-daemon/dist/daemon-bundle.mjs"
ln -s ../lib/node_modules/bb-app/dist/bb-app.js "$prefix/bin/bb-app"
exit 0
`,
  );
  for (const name of ["systemctl", "journalctl", "ps", "npm"]) chmodSync(join(bin, name), 0o755);
  writeFileSync(join(fake, "active"), "active\n");
  const run = (script: string, env: Record<string, string> = {}) =>
    execFileSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: root, TMPDIR: root, ...env } });
  return {
    root, home, data, unit, fake, tgzFile, run,
    log: () => (existsSync(join(fake, "log")) ? readFileSync(join(fake, "log"), "utf8") : ""),
    set: (name: "journal" | "ps" | "active", text: string) => writeFileSync(join(fake, name), text),
    version: (prefix = "npm") => /"version": "([^"]+)"/.exec(readFileSync(join(data, prefix, "lib", "node_modules", "bb-app", "package.json"), "utf8"))?.[1] ?? null,
  };
}

function seen(overrides: Partial<BbInstall> = {}): BbInstall {
  return {
    complete: true, dataDir: "/home/user/.bb-machines/bb.example.com", unit: "bb-host-daemon-x.service", node: "/opt/node/bin/node",
    installed: "0.49.0", bin: "ok", lacks: [], tgz: "0.50.1", state: { active: "active", sub: "running", result: "success", restarts: 0, sinceSeconds: 40 },
    moduleNotFound: false, zombies: [], blocked: [], live: [], ...overrides,
  };
}

test("versions compare like semver, nightlies before their release", () => {
  assert.ok(compareVersions("0.49.0", "0.50.1") < 0);
  assert.ok(compareVersions("0.50.1", "0.50.1") === 0);
  assert.ok(compareVersions("0.50.10", "0.50.9") > 0);
  assert.ok(compareVersions("0.50.2-nightly.44376331299.1", "0.50.2") < 0);
  assert.ok(compareVersions("0.50.2-nightly.44378277800.1", "0.50.2-nightly.44376331299.1") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
});

test("the update decision: the server's version, the download's, and a broken install", () => {
  // The incident: 0.49.0 installed, the server on 0.50.1, its build downloaded but not installed.
  assert.deepEqual(decideBbUpdate(seen(), "0.50.1"), { kind: "update", to: "0.50.1", from: "0.49.0", broken: false });
  // Without the server's version, the download is what the server sent.
  assert.deepEqual(decideBbUpdate(seen(), null), { kind: "update", to: "0.50.1", from: "0.49.0", broken: false });
  assert.equal(decideBbUpdate(seen({ installed: "0.50.1" }), "0.50.1").kind, "none", "current");
  // No download of the server's version there (none, unreadable, or a stale one, which is never
  // installed): that exact version from the npm registry instead.
  const npm = { kind: "update", to: "0.50.1", from: "0.49.0", broken: false, npm: true };
  assert.deepEqual(decideBbUpdate(seen({ tgz: "none" }), "0.50.1"), npm);
  assert.deepEqual(decideBbUpdate(seen({ tgz: "unreadable" }), "0.50.1"), npm);
  assert.deepEqual(decideBbUpdate(seen({ tgz: "0.50.0" }), "0.50.1"), npm);
  // The server's version unknown: nothing to ask the registry for (never "latest").
  assert.deepEqual(decideBbUpdate(seen({ tgz: "none" }), null), { kind: "none", why: "Boat couldn't tell which bb the server needs" });
  assert.equal(decideBbUpdate(seen({ tgz: "unreadable" }), null).kind, "none");
  assert.equal(decideBbUpdate(seen({ installed: "0.51.0", tgz: "none" }), "0.50.1").kind, "none", "newer: bb's setup decides");
  assert.equal(decideBbUpdate(seen({ installed: "unreadable" }), "0.50.1").kind, "none", "an unreadable file is not a missing one");
  assert.equal(decideBbUpdate(seen({ complete: false }), "0.50.1").kind, "none");
  assert.equal(decideBbUpdate(seen({ dataDir: null }), "0.50.1").kind, "none", "bb not there yet: bb's setup installs it");
  // Broken: the bin is missing, or the service fails with MODULE_NOT_FOUND.
  assert.deepEqual(decideBbUpdate(seen({ bin: "missing" }), "0.50.1"), { kind: "update", to: "0.50.1", from: "0.49.0", broken: true });
  assert.deepEqual(decideBbUpdate(seen({ installed: "0.50.1", moduleNotFound: true, state: { active: "activating", sub: "auto-restart", result: "exit-code", restarts: 40, sinceSeconds: 1 } }), "0.50.1"), { kind: "update", to: "0.50.1", from: "0.50.1", broken: true });
  assert.equal(decideBbUpdate(seen({ installed: "0.50.1", moduleNotFound: true }), "0.50.1").kind, "none", "an old MODULE_NOT_FOUND line while the service runs isn't broken");
  // Broken without a download of the server's version: repaired from the npm registry.
  assert.deepEqual(decideBbUpdate(seen({ bin: "missing", tgz: "none" }), "0.50.1"), { kind: "update", to: "0.50.1", from: "0.49.0", broken: true, npm: true });
  assert.deepEqual(decideBbUpdate(seen({ lacks: ["dist/bb-app.js"], tgz: "0.50.0" }), "0.50.1"), { kind: "update", to: "0.50.1", from: "0.49.0", broken: true, npm: true });
  assert.deepEqual(decideBbUpdate(seen({ bin: "missing", installed: "none", tgz: "unreadable" }), "0.50.1"), { kind: "update", to: "0.50.1", from: null, broken: true, npm: true });
  assert.equal(decideBbUpdate(seen({ bin: "missing", tgz: "none" }), null).kind, "set-aside", "broken, nothing to install from: bb's setup installs into an empty prefix");
  // A hung update of bb's own: not fought. A zombie needs a VM restart; a wait on the disk needs time.
  assert.deepEqual(decideBbUpdate(seen({ zombies: ["812 3600"] }), "0.50.1"), { kind: "hung", detail: "npm install left a zombie: pid 812" });
  assert.equal(decideBbUpdate(seen({ state: { active: "deactivating", sub: "stop-sigterm", result: "success", restarts: 0, sinceSeconds: 600 } }), "0.50.1").kind, "waiting");
  assert.equal(decideBbUpdate(seen({ state: { active: "deactivating", sub: "stop-sigterm", result: "success", restarts: 0, sinceSeconds: 3 } }), "0.50.1").kind, "update", "just stopping isn't held up");
  assert.deepEqual(decideBbUpdate(seen({ blocked: ["640 300"] }), "0.50.1"), { kind: "waiting", detail: "bb's npm install is waiting on a file not restored yet (pid 640, 300s)" });
  assert.equal(decideBbUpdate(seen({ blocked: ["640 20"] }), "0.50.1").kind, "busy", "a read that waits a moment: bb's own update is running");
  assert.deepEqual(decideBbUpdate(seen({ live: ["4242 20"] }), "0.50.1"), { kind: "busy", detail: "bb's own update is running: npm install, pid 4242" });
});

test("the look finds bb's unit, data dir, versions and download (the real script, here on a copy)", (t) => {
  const box = sandboxHome(t);
  const install = parseInspection(box.run(inspectScript(HOST)));
  assert.equal(install.complete, true);
  assert.equal(install.dataDir, box.data);
  assert.equal(install.unit, box.unit);
  assert.equal(install.node, "/opt/node/bin/node");
  assert.equal(install.installed, "0.49.0", "the top-level version, not a dependency's");
  assert.equal(install.bin, "ok");
  assert.deepEqual(install.lacks, []);
  assert.equal(install.tgz, "0.50.1");
  assert.equal(install.state?.active, "active");
  assert.equal(install.moduleNotFound, false);
  assert.deepEqual(install.zombies, []);
  assert.equal(decideBbUpdate(install, "0.50.1").kind, "update");
  // Another host's id: the only unit there still counts.
  assert.equal(parseInspection(box.run(inspectScript("host_other"))).dataDir, box.data);
  // No bb there at all.
  const empty = mkdtempSync(join(tmpdir(), "boat-bb-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const none = parseInspection(execFileSync("bash", ["-c", inspectScript(HOST)], { encoding: "utf8", env: { ...process.env, HOME: empty } }));
  assert.equal(none.complete, true);
  assert.equal(none.dataDir, null);
  assert.equal(decideBbUpdate(none, "0.50.1").kind, "none");
});

test("a missing bin, a MODULE_NOT_FOUND service and a zombie npm install are seen as such", (t) => {
  const box = sandboxHome(t, { bin: false });
  let install = parseInspection(box.run(inspectScript(HOST)));
  assert.equal(install.bin, "missing");
  assert.deepEqual(decideBbUpdate(install, "0.50.1"), { kind: "update", to: "0.50.1", from: "0.49.0", broken: true });
  // The bin is there, but bb's service keeps failing on a module that's gone.
  const cut = sandboxHome(t, { installed: "0.50.1" });
  rmSync(join(cut.data, "npm", "lib", "node_modules", "bb-app", "host-daemon"), { recursive: true });
  cut.set("journal", "node:internal/modules/cjs/loader:1228\nError: Cannot find module '/x/bb-app/dist/chunk.js'\n  code: 'MODULE_NOT_FOUND'\n");
  cut.set("active", "activating\n");
  install = parseInspection(cut.run(inspectScript(HOST)));
  assert.equal(install.moduleNotFound, true);
  assert.match(cut.log(), /journalctl --user -b -u /, "this boot's lines only");
  assert.deepEqual(install.lacks, ["host-daemon/dist/daemon-bundle.mjs"]);
  assert.deepEqual(decideBbUpdate(install, "0.50.1"), { kind: "update", to: "0.50.1", from: "0.50.1", broken: true });
  // A zombie of bb's own npm install (ps's words) and one stuck reading the disk, both still so
  // 5 s later (procfs, faked here: the zombie, and a read that made no progress). The script's own
  // process never matches itself.
  box.set("ps", `  812 Zl    3600 [npm install -g ] <defunct>\n  640 D      300 npm install -g --prefix ${box.data}/npm ${box.data}/host-package-download/bb-app.tgz\n  641 D      300 npm install -g --prefix ${box.data}/npm ${box.data}/host-package-download/bb-app.tgz\n  642 D      300 npm install -g --prefix /elsewhere/npm left-pad\n  700 D      300 node /x/other.js\n  900 S       1 bash -c whatever\n`);
  const proc = join(box.root, "proc");
  const task = (pid: number, state: string, rchar: number) => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), "status"), `Name:\tnpm install -g \nState:\t${state} (whatever)\n`);
    writeFileSync(join(proc, String(pid), "io"), `rchar: ${rchar}\nwchar: 0\n`);
  };
  task(812, "Z", 0);
  task(640, "D", 4096);
  task(641, "S", 8192);
  task(642, "D", 1);
  install = parseInspection(box.run(inspectScript(HOST, { proc, sampleSeconds: 0 })));
  assert.deepEqual(install.zombies, ["812 3600"]);
  assert.deepEqual(install.blocked, ["640 300"]);
  assert.deepEqual(install.live, ["641 300"], "641 was only waiting a moment: it runs again; 642 isn't bb's");
  // A read that makes progress between the looks isn't stuck.
  writeFileSync(join(box.fake, "ps-after"), `echo "rchar: 999999" > "${join(proc, "640", "io")}"\n`);
  assert.deepEqual(parseInspection(box.run(inspectScript(HOST, { proc, sampleSeconds: 2 }))).blocked, []);
  rmSync(join(box.fake, "ps-after"));
  assert.equal(decideBbUpdate(install, "0.50.1").kind, "hung");
  rmSync(join(box.fake, "ps"));
  const live = execFileSync("bash", ["-c", inspectScript(HOST, { sampleSeconds: 0 }).replace(/timeout 5 ps /, "timeout 5 /bin/ps ")], { encoding: "utf8", env: { ...process.env, HOME: box.home } });
  assert.deepEqual(parseInspection(live).zombies, [], "the real ps: nothing stuck here, and not the script itself");
});

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the fresh-prefix install swaps the new bb in, keeps the old one, writes bb's digest and starts the unit again", async (t) => {
  const box = sandboxHome(t);
  const digest = createHash("sha256").update(readFileSync(box.tgzFile!)).digest("hex");
  const result = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0" })));
  assert.deepEqual(result, { kind: "done", version: "0.50.1", unit: "active" });
  assert.equal(box.version(), "0.50.1");
  const old = readdirSync(box.data).filter((name) => name.startsWith("npm.old-"));
  assert.equal(old.length, 1);
  assert.match(old[0]!, /^npm\.old-0\.49\.0-\d+$/);
  assert.equal(box.version(old[0]), "0.49.0", "the old install stays next to it");
  assert.equal(existsSync(join(box.data, "npm.new")), false);
  assert.equal(readFileSync(join(box.data, "host-artifact.sha256"), "utf8").trim(), digest, "bb's setup then sees the identical build (304) and doesn't install again");
  await until(() => !existsSync(box.tgzFile!));
  const log = box.log().trim().split("\n");
  const stop = log.findIndex((line) => line.startsWith(`systemctl --user stop ${box.unit}`));
  const npm = log.findIndex((line) => line.startsWith("npm install -g"));
  const start = log.findIndex((line) => line.startsWith(`systemctl --user start ${box.unit}`));
  assert.ok(stop >= 0 && npm > stop && start > npm, log.join("\n"));
  assert.ok(log.some((line) => line.startsWith(`systemctl --user reset-failed ${box.unit}`)));
  assert.match(log[npm]!, new RegExp(`--prefix ${box.data}/npm\\.new `));
  assert.match(log[npm]!, /--no-audit --no-fund --allow-scripts=better-sqlite3,node-pty,@parcel\/watcher/);
  assert.match(log[npm]!, /boat-bb-update\.[A-Za-z0-9]+\/bb-app\.tgz cache=.*boat-bb-update\.[A-Za-z0-9]+\/cache$/, "the copied download, and a cache of its own");
  assert.deepEqual(readdirSync(box.root).filter((name) => name.startsWith("boat-bb-update.")), [], "its work dir goes");
  // A second update later: only the newest old install is kept.
  const again = sandboxHome(t, { installed: "0.50.1", tgz: "0.51.0" });
  mkdirSync(join(again.data, "npm.old-0.48.0-1"));
  mkdirSync(join(again.data, "npm.new", "lib"), { recursive: true });
  assert.equal(parseInstall(again.run(installScript({ dataDir: again.data, unit: again.unit, node: null, version: "0.51.0", from: "0.50.1" }))).kind, "done");
  // Cleaned up in the background, once bb runs again: older installs and half-made ones from earlier tries.
  await until(() => readdirSync(again.data).filter((name) => /^npm\.(old|trash)-/.test(name)).length === 1);
  assert.deepEqual(readdirSync(again.data).filter((name) => /^npm\.(old|trash)-/.test(name)).map((name) => name.replace(/-\d+$/, "")), ["npm.old-0.50.1"]);
  const order = again.log().trim().split("\n");
  assert.ok(order.findIndex((line) => line.startsWith("systemctl --user start")) > order.findIndex((line) => line.startsWith("npm install")), "bb starts again right after the swap");
});

test("a failed install keeps the old bb, removes the half-made one and starts the unit again", (t) => {
  for (const [env, reason, detail] of [
    [{ FAKE_NPM_FAIL: "ETIMEDOUT" }, "npm", "ETIMEDOUT"],
    [{ FAKE_NO_NATIVE: "1" }, "native", null],
  ] as const) {
    const box = sandboxHome(t);
    const result = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0" }), env));
    assert.deepEqual(result, { kind: "fail", reason, detail, old: "intact" });
    assert.equal(box.version(), "0.49.0", "the old install is untouched");
    assert.equal(existsSync(join(box.data, "npm.new")), false);
    assert.equal(existsSync(join(box.data, "host-artifact.sha256")), false);
    assert.equal(readFileSync(join(box.fake, "active"), "utf8").trim(), "active", "bb's service runs again");
    assert.ok(box.log().includes(`systemctl --user start ${box.unit}`));
  }
  assert.equal(installFailureText({ kind: "fail", reason: "npm", detail: "ETIMEDOUT", old: "intact" }), "npm install failed (ETIMEDOUT)");
  assert.equal(installFailureText({ kind: "fail", reason: "npm", detail: "timeout", old: "intact" }), "npm install took longer than 4 minutes");
  // A download of another version than planned is never installed.
  const other = sandboxHome(t, { tgz: "0.50.0" });
  assert.deepEqual(parseInstall(other.run(installScript({ dataDir: other.data, unit: other.unit, node: null, version: "0.50.1", from: "0.49.0" }))), { kind: "fail", reason: "version", detail: "0.50.0", old: "intact" });
  assert.equal(other.log().includes("npm install"), false);
  assert.equal(other.log().includes("systemctl --user stop"), false, "nothing stopped before the download checks out");
});

test("a unit that won't stop: nothing is installed", (t) => {
  const box = sandboxHome(t);
  const result = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0" }), { FAKE_STOP_TO: "deactivating" }));
  assert.deepEqual(result, { kind: "stuck", detail: "deactivating" });
  assert.equal(box.log().includes("npm install"), false);
  assert.equal(box.version(), "0.49.0");
});

test("bb's own in-place update running right now (an S-state npm install) is never stopped half way", (t) => {
  const box = sandboxHome(t);
  const proc = join(box.root, "proc");
  mkdirSync(join(proc, "4242"), { recursive: true });
  writeFileSync(join(proc, "4242", "status"), "Name:\tnpm install -g \nState:\tS (sleeping)\n");
  writeFileSync(join(proc, "4242", "io"), "rchar: 100\n");
  box.set("ps", `   4242 Sl     20 npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher --prefix ${box.data}/npm ${box.data}/host-package-download/bb-app.tgz\n`);
  // The look sees it, and the plan waits for it instead of updating.
  const install = parseInspection(box.run(inspectScript(HOST, { proc, sampleSeconds: 0 })));
  assert.deepEqual(install.live, ["4242 20"]);
  assert.deepEqual(decideBbUpdate(install, "0.50.1"), { kind: "busy", detail: "bb's own update is running: npm install, pid 4242" });
  // Started after the look: the install script backs off before stopping anything.
  const result = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0", proc })));
  assert.deepEqual(result, { kind: "busy", pid: "4242" });
  assert.equal(box.log().includes("systemctl --user stop"), false);
  assert.equal(box.log().includes("npm install"), false);
  // Started during Boat's copy and checks (here: while gzip tests the download): still caught,
  // since the check runs right before the stop. The old order checked before the copy and missed it.
  rmSync(join(box.fake, "ps"));
  const gzip = execFileSync("bash", ["-c", "command -v gzip"], { encoding: "utf8" }).trim();
  writeFileSync(join(box.root, "bin", "gzip"), `#!/bin/bash\n"${gzip}" "$@"; rc=$?\nprintf '%s\\n' "   4242 Sl     20 npm install -g --prefix ${box.data}/npm ${box.data}/host-package-download/bb-app.tgz" > "${box.fake}/ps"\nexit $rc\n`);
  chmodSync(join(box.root, "bin", "gzip"), 0o755);
  const late = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0", proc })));
  assert.deepEqual(late, { kind: "busy", pid: "4242" });
  assert.equal(box.log().includes("systemctl --user stop"), false, "nothing stopped");
  assert.equal(box.log().includes("npm install"), false);
  assert.equal(box.version(), "0.49.0");
  rmSync(join(box.root, "bin", "gzip"));
  // Found by the unit it runs in, too (its arguments may not name the folder).
  box.set("ps", "   4243 Sl     20 npm install\n");
  mkdirSync(join(proc, "4243"), { recursive: true });
  writeFileSync(join(proc, "4243", "status"), "State:\tR (running)\n");
  writeFileSync(join(proc, "4243", "cgroup"), `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${box.unit}\n`);
  assert.deepEqual(parseInspection(box.run(inspectScript(HOST, { proc, sampleSeconds: 0 }))).live, ["4243 20"]);
});

test("a failure after the stop says what became of the old install, and never calls a broken one kept", (t) => {
  // bb's own npm, killed by the stop half way through writing the old prefix: it's gone aside, and said so.
  const box = sandboxHome(t);
  writeFileSync(join(box.root, "bin", "systemctl-stop-hook"), `#!/bin/bash\nrm -f "${box.data}/npm/bin/bb-app"\n`);
  chmodSync(join(box.root, "bin", "systemctl-stop-hook"), 0o755);
  const systemctl = readFileSync(join(box.root, "bin", "systemctl"), "utf8").replace('*" stop "*) echo', '*" stop "*) systemctl-stop-hook; echo');
  writeFileSync(join(box.root, "bin", "systemctl"), systemctl);
  writeFileSync(join(box.data, "host-artifact.sha256"), "b".repeat(64));
  const broken = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0" }), { FAKE_NPM_FAIL: "ETIMEDOUT" }));
  assert.deepEqual(broken, { kind: "fail", reason: "npm", detail: "ETIMEDOUT", old: "set-aside" });
  assert.equal(existsSync(join(box.data, "npm")), false);
  assert.equal(readdirSync(box.data).filter((name) => name.startsWith("npm.broken-")).length, 1);
  assert.equal(existsSync(join(box.data, "host-artifact.sha256")), false, "bb's setup installs the server's build again");
  // Its version changed under it (bb's own npm got further): broken too.
  const changed = sandboxHome(t);
  const pkg = join(changed.data, "npm", "lib", "node_modules", "bb-app", "package.json");
  writeFileSync(join(changed.root, "bin", "systemctl-stop-hook"), `#!/bin/bash\nsed -i 's/0.49.0/0.50.1/' "${pkg}"\n`);
  chmodSync(join(changed.root, "bin", "systemctl-stop-hook"), 0o755);
  writeFileSync(join(changed.root, "bin", "systemctl"), readFileSync(join(changed.root, "bin", "systemctl"), "utf8").replace('*" stop "*) echo', '*" stop "*) systemctl-stop-hook; echo'));
  assert.equal((parseInstall(changed.run(installScript({ dataDir: changed.data, unit: changed.unit, node: null, version: "0.50.1", from: "0.49.0" }), { FAKE_NO_NATIVE: "1" })) as { old: string }).old, "set-aside");
  // Already broken before Boat touched it (the look said so): never "kept".
  const before = sandboxHome(t, { bin: false });
  assert.equal((parseInstall(before.run(installScript({ dataDir: before.data, unit: before.unit, node: null, version: "0.50.1", from: "0.49.0", broken: true }), { FAKE_NPM_FAIL: "E404" })) as { old: string }).old, "set-aside");
});

test("the install's worst case stays inside its limit, bb's restart included", async (t) => {
  // npm hangs: every step gets what's left of the limit less the reserve for restarting bb.
  const box = sandboxHome(t);
  writeFileSync(join(box.root, "bin", "npm"), "#!/bin/bash\nexec sleep 600\n");
  chmodSync(join(box.root, "bin", "npm"), 0o755);
  const started = Date.now();
  const result = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0", seconds: 76 })));
  const took = (Date.now() - started) / 1000;
  assert.deepEqual(result, { kind: "fail", reason: "npm", detail: "timeout", old: "intact" });
  assert.ok(took < 76, `took ${took}s`);
  assert.equal(readFileSync(join(box.fake, "active"), "utf8").trim(), "active", "bb's service runs again inside the limit");
  // The limit itself leaves the exec a minute: 300 s of script, 360 s of exec.
  assert.match(installScript({ dataDir: "/d", unit: null, node: null, version: "1.0.0" }), /^L=300$/m);
  assert.match(installScript({ dataDir: "/d", unit: null, node: null, version: "1.0.0" }), /^RES=70$/m);
  assert.match(installScript({ dataDir: "/d", unit: null, node: null, version: "1.0.0" }), /--allow-scripts=better-sqlite3,node-pty,@parcel\/watcher /);
});

test("without a download there, bb-app at the server's exact version comes from the npm registry: fetched before the stop, then the same install and swap, bb's digest left as it was", async (t) => {
  const box = sandboxHome(t, { tgz: null });
  // bb's digest of the build it installed last: not the npm build's, and Boat can't make that one.
  writeFileSync(join(box.data, "host-artifact.sha256"), `${"c".repeat(64)}\n`);
  const plan = decideBbUpdate(parseInspection(box.run(inspectScript(HOST))), "0.50.1");
  assert.deepEqual(plan, { kind: "update", to: "0.50.1", from: "0.49.0", broken: false, npm: true }, "download missing: npm");
  const result = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0", npm: true })));
  assert.deepEqual(result, { kind: "done", version: "0.50.1", unit: "active" });
  assert.equal(box.version(), "0.50.1");
  const old = readdirSync(box.data).filter((name) => name.startsWith("npm.old-"));
  assert.deepEqual(old.map((name) => name.replace(/-\d+$/, "")), ["npm.old-0.49.0"], "the old install stays next to it");
  assert.equal(box.version(old[0]), "0.49.0");
  assert.equal(existsSync(join(box.data, "npm.new")), false);
  assert.equal(readFileSync(join(box.data, "host-artifact.sha256"), "utf8"), `${"c".repeat(64)}\n`, "no fake digest: the file stays as it was");
  const log = box.log().trim().split("\n");
  const pack = log.findIndex((line) => line.startsWith("npm pack"));
  const stop = log.findIndex((line) => line.startsWith(`systemctl --user stop ${box.unit}`));
  const npm = log.findIndex((line) => line.startsWith("npm install -g"));
  const start = log.findIndex((line) => line.startsWith(`systemctl --user start ${box.unit}`));
  assert.ok(pack >= 0 && stop > pack && npm > stop && start > npm, log.join("\n"));
  assert.match(log[pack]!, /^npm pack --ignore-scripts --registry=https:\/\/registry\.npmjs\.org\/ --pack-destination \S+\/boat-bb-update\.[A-Za-z0-9]+\/pack bb-app@0\.50\.1 cache=\S+\/boat-bb-update\.[A-Za-z0-9]+\/cache$/, "the exact version, from npm's own registry");
  assert.match(log[npm]!, new RegExp(`--allow-scripts=better-sqlite3,node-pty,@parcel/watcher --registry=https://registry\\.npmjs\\.org/ --prefix ${box.data}/npm\\.new \\S+/boat-bb-update\\.[A-Za-z0-9]+/bb-app\\.tgz cache=`));
  assert.deepEqual(readdirSync(box.root).filter((name) => name.startsWith("boat-bb-update.")), [], "its work dir goes");
  // A download there that can't be read: the look says so, and npm installs the server's version.
  const unreadable = sandboxHome(t, { installed: "0.49.0" });
  writeFileSync(unreadable.tgzFile!, "not a tarball");
  const seenThere = parseInspection(unreadable.run(inspectScript(HOST)));
  assert.equal(seenThere.tgz, "unreadable");
  assert.deepEqual(decideBbUpdate(seenThere, "0.50.1"), { kind: "update", to: "0.50.1", from: "0.49.0", broken: false, npm: true });
  assert.equal(parseInstall(unreadable.run(installScript({ dataDir: unreadable.data, unit: unreadable.unit, node: null, version: "0.50.1", from: "0.49.0", npm: true }))).kind, "done");
  assert.equal(unreadable.version(), "0.50.1");
  assert.equal(unreadable.log().includes(unreadable.tgzFile!), false, "the unreadable download isn't read");
  await until(() => !existsSync(unreadable.tgzFile!));
  // Never a range, a tag or "latest".
  assert.throws(() => installScript({ dataDir: "/d", unit: null, node: null, version: "latest", npm: true }), /not a bb version/);
});

test("the npm registry fails (a version it doesn't have, unreachable, a timeout): nothing stopped, the old bb untouched, in plain words", (t) => {
  for (const [env, detail, text] of [
    [{ FAKE_PACK_FAIL: "ETARGET" }, "ETARGET", "the npm registry doesn't have bb-app 0.50.1 (ETARGET)"],
    [{ FAKE_PACK_FAIL: "E404" }, "E404", "the npm registry doesn't have bb-app 0.50.1 (E404)"],
    [{ FAKE_PACK_FAIL: "ENOTFOUND" }, "ENOTFOUND", "the npm registry couldn't be reached (ENOTFOUND)"],
    [{ FAKE_PACK_HANG: "1" }, "timeout", "fetching bb-app 0.50.1 from the npm registry took longer than 2 minutes"],
  ] as const) {
    const box = sandboxHome(t, { tgz: null });
    writeFileSync(join(box.data, "host-artifact.sha256"), "d".repeat(64));
    const started = Date.now();
    // For the hang, a short limit: the fetch's own share of it is a second.
    const result = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0", npm: true, seconds: "FAKE_PACK_HANG" in env ? 10 : undefined }), env));
    assert.ok(Date.now() - started < 15_000);
    assert.deepEqual(result, { kind: "fail", reason: "registry", detail, old: "intact" });
    assert.equal(installFailureText(result as Extract<typeof result, { kind: "fail" }>, "0.50.1"), text);
    assert.equal(box.version(), "0.49.0", "the old install is untouched");
    assert.equal(box.log().includes("systemctl --user stop"), false, "bb's service never stopped");
    assert.equal(box.log().includes("npm install"), false);
    assert.equal(readFileSync(join(box.fake, "active"), "utf8").trim(), "active");
    assert.equal(readFileSync(join(box.data, "host-artifact.sha256"), "utf8"), "d".repeat(64));
    assert.deepEqual(readdirSync(box.data).filter((name) => /^npm\./.test(name)), []);
  }
  assert.equal(installFailureText({ kind: "fail", reason: "registry", detail: "E500", old: "intact" }, "0.50.1"), "fetching bb-app 0.50.1 from the npm registry failed (E500)");
  assert.equal(installFailureText({ kind: "fail", reason: "registry", detail: "no-package", old: "intact" }, "0.50.1"), "npm fetched nothing for bb-app 0.50.1 from the npm registry");
});

test("bb-app from the npm registry at another version than the server's is never swapped in", (t) => {
  // npm installs another version than it was given: the new install goes, the old one starts again.
  const box = sandboxHome(t, { tgz: null });
  const installed = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0", npm: true }), { FAKE_NPM_VERSION: "0.50.0" }));
  assert.deepEqual(installed, { kind: "fail", reason: "installed", detail: "0.50.0", old: "intact" });
  assert.equal(installFailureText(installed as Extract<typeof installed, { kind: "fail" }>), "npm installed bb-app 0.50.0 instead");
  assert.equal(box.version(), "0.49.0", "not swapped in");
  assert.equal(existsSync(join(box.data, "npm.new")), false);
  assert.deepEqual(readdirSync(box.data).filter((name) => name.startsWith("npm.old-")), []);
  assert.equal(readFileSync(join(box.fake, "active"), "utf8").trim(), "active", "bb's service runs again");
  // The registry sends another version: caught before anything stops.
  const sent = sandboxHome(t, { tgz: null });
  const fetched = parseInstall(sent.run(installScript({ dataDir: sent.data, unit: sent.unit, node: null, version: "0.50.1", from: "0.49.0", npm: true }), { FAKE_PACK_VERSION: "0.50.0" }));
  assert.deepEqual(fetched, { kind: "fail", reason: "fetched", detail: "0.50.0", old: "intact" });
  assert.equal(installFailureText(fetched as Extract<typeof fetched, { kind: "fail" }>), "the npm registry sent bb-app 0.50.0");
  assert.equal(sent.log().includes("systemctl --user stop"), false);
  assert.equal(sent.version(), "0.49.0");
});

test("a broken install with nothing to install from is moved aside for bb's setup", (t) => {
  const box = sandboxHome(t, { bin: false, tgz: null });
  writeFileSync(join(box.data, "host-artifact.sha256"), "a".repeat(64));
  assert.match(box.run(setAsideScript({ dataDir: box.data, unit: box.unit })), /BOAT_BBFIX moved/);
  assert.equal(existsSync(join(box.data, "npm")), false);
  assert.equal(readdirSync(box.data).filter((name) => name.startsWith("npm.broken-")).length, 1);
  assert.equal(existsSync(join(box.data, "host-artifact.sha256")), false, "bb's setup installs the server's build again");
  assert.match(box.run(setAsideScript({ dataDir: box.data, unit: box.unit })), /BOAT_BBFIX none/);
});

/** boat's exec, answering the look and the install from fixtures. */
function fakeExec(answers: { inspect: () => string; install?: () => string; setAside?: () => string }) {
  const scripts: string[] = [];
  return {
    scripts,
    boat: {
      async exec(_sandboxId: string, script: string) {
        scripts.push(script);
        if (script.includes("say end")) return { exitCode: 0, stdout: answers.inspect(), stderr: "" };
        if (script.includes("BOAT_BBUP")) return { exitCode: 0, stdout: answers.install?.() ?? "", stderr: "" };
        if (script.includes("BOAT_BBFIX")) return { exitCode: 0, stdout: answers.setAside?.() ?? "", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

const INSPECTED = ["BOAT_BB dir /home/user/.bb-machines/bb.example.com", "BOAT_BB unit bb-host-daemon-bb-example-com-host_1.service", "BOAT_BB node /home/user/.nvm/versions/node/v24.11.1/bin/node", "BOAT_BB installed 0.49.0", "BOAT_BB bin ok", "BOAT_BB tgz 0.50.1", "BOAT_BB state ActiveState=active SubState=running Result=success NRestarts=0 StateChangeTimestampMonotonic=5000000", "BOAT_BB uptime 60", "BOAT_BB end"].join("\n");

function kvStore() {
  const values = new Map<string, unknown>();
  return { values, async get<T>(key: string) { return values.get(key) as T | undefined; }, async set(key: string, value: unknown) { values.set(key, structuredClone(value)); } };
}

function prep(overrides: Partial<HostPrep> = {}): HostPrep & { steps: string[]; logs: string[] } {
  const steps: string[] = [];
  const logs: string[] = [];
  return { sandboxId: "bx_one", hostId: "host_1", woke: true, signal: new AbortController().signal, report: { step: (text) => steps.push(text), log: (text) => logs.push(text) }, steps, logs, ...overrides };
}

test("the updater installs the server's version, says so, and never reads the old install first", async () => {
  let installed = INSPECTED;
  const exec = fakeExec({ inspect: () => installed, install: () => "BOAT_BBUP done 0.50.1 active\n" });
  const prefetched: unknown[] = [];
  const kv = kvStore();
  const update = createBbUpdater({ boat: exec.boat, kv, serverVersion: async () => "0.50.1", prefetch: async (_id, request) => { prefetched.push(request); } });
  const step = prep();
  assert.deepEqual(await update(step), { kind: "updated", from: "0.49.0", to: "0.50.1" });
  assert.equal(exec.scripts.length, 2, "one look, one install");
  assert.match(exec.scripts[1]!, /V='0\.50\.1'/);
  assert.match(exec.scripts[1]!, /D='\/home\/user\/\.bb-machines\/bb\.example\.com'/);
  assert.match(exec.scripts[1]!, /N='\/home\/user\/\.nvm\/versions\/node\/v24\.11\.1\/bin\/node'/, "bb's own node and npm");
  assert.doesNotMatch(exec.scripts[1]!, /npm pack|registry/, "the download there: nothing from the npm registry");
  assert.match(exec.scripts[1]!, /host-artifact\.sha256\.boat/, "and bb's digest of it written");
  assert.deepEqual(prefetched, [{ dataDir: "/home/user/.bb-machines/bb.example.com", node: "/home/user/.nvm/versions/node/v24.11.1/bin/node", skipInstall: true }], "the install about to be replaced isn't read");
  assert.ok(step.steps.some((text) => /Updating bb on the sandbox to 0\.50\.1/.test(text)));
  assert.ok(step.logs.some((text) => /Updated bb on the sandbox from 0\.49\.0 to 0\.50\.1/.test(text)));
  // Current now: nothing to install, and no prefetch on a sandbox that was already up.
  installed = INSPECTED.replace("installed 0.49.0", "installed 0.50.1");
  assert.equal((await update(prep({ woke: false }))).kind, "none");
  assert.equal(exec.scripts.length, 3);
  assert.equal(prefetched.length, 1);
  // The server's version can't be read: the download's own version counts.
  const unknown = createBbUpdater({ boat: fakeExec({ inspect: () => INSPECTED, install: () => "BOAT_BBUP done 0.50.1 active" }).boat, kv: kvStore(), serverVersion: async () => { throw new Error("offline"); } });
  assert.equal((await unknown(prep())).kind, "updated");
});

test("a failed update keeps the old bb, tells the tasks in plain words, and backs off", async () => {
  let at = Date.parse("2026-11-19T02:00:00Z");
  let answer = "BOAT_BBOLD intact\nBOAT_BBUP fail npm ETIMEDOUT\n";
  const exec = fakeExec({ inspect: () => INSPECTED, install: () => answer });
  const told: string[] = [];
  const kv = kvStore();
  const update = createBbUpdater({ boat: exec.boat, kv, serverVersion: async () => "0.50.1", tell: (_id, text) => told.push(text), now: () => at });
  const first = await update(prep());
  assert.equal(first.kind, "failed", "the wake goes on to bb's own setup");
  assert.equal((first as { text: string }).text, "Boat couldn't update bb on this sandbox to 0.50.1: npm install failed (ETIMEDOUT). It kept the bb that was there, and bb's own setup goes ahead. Boat tries the update again after 02:30 UTC.");
  assert.deepEqual(told, [(first as { text: string }).text]);
  assert.equal((kv.values.get(BB_UPDATES_KEY) as Record<string, { failures: number }>).bx_one!.failures, 1);
  // Within the backoff: no install at all.
  at += 10 * 60_000;
  assert.equal((await update(prep())).kind, "held");
  assert.equal(exec.scripts.filter((script) => script.includes("BOAT_BBUP")).length, 1);
  // After it: once more, and a failure doubles the wait.
  at += 25 * 60_000;
  assert.equal((await update(prep())).kind, "failed");
  assert.equal((kv.values.get(BB_UPDATES_KEY) as Record<string, { retryAt: number }>).bx_one!.retryAt, at + updateBackoffMs(2));
  assert.equal(updateBackoffMs(2), 60 * 60_000);
  assert.equal(updateBackoffMs(30), 6 * 3_600_000);
  // boat's exec failing is the same: the old bb stays, the wake goes on.
  at += 2 * 3_600_000;
  const broken = createBbUpdater({ boat: { exec: async (_id: string, script: string) => { if (script.includes("BOAT_BBUP")) throw new Error("boat exec: connection reset"); return { exitCode: 0, stdout: INSPECTED, stderr: "" }; } }, kv: kvStore(), serverVersion: async () => "0.50.1" });
  assert.match(((await broken(prep())) as { text: string }).text, /boat's exec failed \(boat exec: connection reset\)/);
  // A success clears the backoff.
  answer = "BOAT_BBUP done 0.50.1 active";
  assert.equal((await update(prep())).kind, "updated");
  assert.equal((kv.values.get(BB_UPDATES_KEY) as Record<string, unknown>).bx_one, undefined);
});

test("bb's own update running: Boat waits for it (bounded), looks again, and never stops it", async () => {
  let at = Date.parse("2026-11-19T02:00:00Z");
  const running = INSPECTED.replace("BOAT_BB end", "BOAT_BB live 4242 20\nBOAT_BB end");
  const looks: string[] = [];
  let next: string[] = [];
  const exec = fakeExec({ inspect: () => { const said = next.shift() ?? looks.at(-1) ?? running; looks.push(said); return said; }, install: () => "BOAT_BBUP done 0.50.1 active" });
  const sleeps: number[] = [];
  const update = createBbUpdater({ boat: exec.boat, kv: kvStore(), serverVersion: async () => "0.50.1", now: () => at, sleep: async (ms) => { sleeps.push(ms); at += ms; } });
  // It finishes: bb 0.50.1 is installed, nothing for Boat to do.
  next = [running, running, INSPECTED.replace("installed 0.49.0", "installed 0.50.1")];
  const step = prep();
  assert.deepEqual(await update(step), { kind: "none", why: "bb 0.50.1 is installed" });
  assert.deepEqual(sleeps, [10_000, 10_000]);
  assert.ok(step.steps.some((text) => text === "Waiting for bb's own update on the sandbox to finish (npm install, pid 4242)"));
  assert.equal(exec.scripts.some((script) => script.includes("BOAT_BBUP")), false, "no install, no stop");
  // Still running after 3 minutes: Boat's wake retries take it (waiting on the disk).
  next = [];
  looks.length = 0;
  looks.push(running);
  const error = (await update(prep()).catch((caught: unknown) => caught)) as BbUpdateHung;
  assert.ok(error instanceof BbUpdateHung);
  assert.equal(error.wakeDiagnosis.kind, "disk-restoring");
  assert.match(error.wakeDiagnosis.detail!, /^bb's own update is running: npm install, pid 4242, for more than 3 minutes$/);
  // It starts between the look and Boat's install: the install backs off, Boat waits, then looks again.
  let installs = 0;
  const raced = fakeExec({ inspect: () => (installs === 0 ? INSPECTED : INSPECTED.replace("installed 0.49.0", "installed 0.50.1")), install: () => { installs += 1; return "BOAT_BBUP busy 4242"; } });
  const again = createBbUpdater({ boat: raced.boat, kv: kvStore(), serverVersion: async () => "0.50.1", now: () => at, sleep: async (ms) => { at += ms; } });
  assert.deepEqual(await again(prep()), { kind: "none", why: "bb 0.50.1 is installed" });
  assert.equal(installs, 1);
});

test("a failure's words follow the old install as the script found it", async () => {
  const say = async (old: string | null) => {
    const exec = fakeExec({ inspect: () => INSPECTED, install: () => `${old ? `BOAT_BBOLD ${old}\n` : ""}BOAT_BBUP fail npm ETIMEDOUT\n` });
    const update = createBbUpdater({ boat: exec.boat, kv: kvStore(), serverVersion: async () => "0.50.1", now: () => Date.parse("2026-11-19T02:00:00Z") });
    return ((await update(prep())) as { text: string }).text.replace(/^Boat couldn't update bb on this sandbox to 0\.50\.1: npm install failed \(ETIMEDOUT\)\. /, "").replace(/ Boat tries the update again after 02:30 UTC\.$/, "");
  };
  assert.equal(await say("intact"), "It kept the bb that was there, and bb's own setup goes ahead.");
  assert.equal(await say("set-aside"), "The bb that was there isn't complete any more, so Boat moved it aside and bb's own setup installs it again.");
  assert.equal(await say("broken"), "The bb that was there isn't complete; bb's own setup installs it again.");
  assert.equal(await say("unknown"), "Boat couldn't check the bb that was there (its files aren't readable yet); bb's own setup goes ahead.");
  assert.equal(await say(null), "bb's own setup goes ahead and checks the bb that's there.", "no word on it: no claim either way");
});

test("without a download of the server's version, the updater installs it from the npm registry and says so; a failure keeps bb and backs off", async () => {
  let at = Date.parse("2026-11-19T02:00:00Z");
  const noDownload = INSPECTED.replace("BOAT_BB tgz 0.50.1", "BOAT_BB tgz none");
  let answer = "BOAT_BBUP done 0.50.1 active\n";
  const exec = fakeExec({ inspect: () => noDownload, install: () => answer, setAside: () => "BOAT_BBFIX moved" });
  const told: string[] = [];
  const prefetched: { skipInstall: boolean }[] = [];
  const kv = kvStore();
  const update = createBbUpdater({ boat: exec.boat, kv, serverVersion: async () => "0.50.1", tell: (_id, text) => told.push(text), now: () => at, prefetch: async (_id, request) => { prefetched.push(request); } });
  const step = prep();
  assert.deepEqual(await update(step), { kind: "updated", from: "0.49.0", to: "0.50.1", npm: true });
  assert.equal(prefetched[0]!.skipInstall, false, "the registry may not come through: the intact install is still read first, as before");
  assert.match(exec.scripts[1]!, /npm pack --ignore-scripts --registry=https:\/\/registry\.npmjs\.org\/ --pack-destination "\$W\/pack" "bb-app@\$V"/);
  assert.match(exec.scripts[1]!, /^V='0\.50\.1'$/m, "the server's exact version");
  assert.doesNotMatch(exec.scripts[1]!, /host-artifact\.sha256\.boat/, "no digest written for a build from npm");
  assert.ok(step.steps.includes("Updating bb on the sandbox to 0.50.1 from the npm registry: a fresh install next to the old one"), step.steps.join("\n"));
  assert.ok(step.logs.includes("Updated bb on the sandbox from 0.49.0 to 0.50.1, installed from the npm registry"), step.logs.join("\n"));
  // The registry doesn't have that version: the old bb kept, the tasks told, the same backoff.
  answer = "BOAT_BBOLD intact\nBOAT_BBUP fail registry ETARGET\n";
  const failed = (await update(prep())) as { kind: string; text: string };
  assert.equal(failed.kind, "failed");
  assert.equal(failed.text, "Boat couldn't update bb on this sandbox to 0.50.1: the npm registry doesn't have bb-app 0.50.1 (ETARGET). It kept the bb that was there, and bb's own setup goes ahead. Boat tries the update again after 02:30 UTC.");
  assert.deepEqual(told, [failed.text]);
  assert.equal((kv.values.get(BB_UPDATES_KEY) as Record<string, { failures: number; detail: string }>).bx_one!.failures, 1);
  assert.equal(exec.scripts.some((script) => script.includes("BOAT_BBFIX")), false, "an install that isn't broken stays where it is");
  at += 10 * 60_000;
  assert.equal((await update(prep())).kind, "held");
  assert.equal(exec.scripts.filter((script) => script.includes("BOAT_BBUP")).length, 2, "no fetch while held");
  // A timeout after it: the wait doubles.
  at += 25 * 60_000;
  answer = "BOAT_BBOLD intact\nBOAT_BBUP fail registry timeout\n";
  assert.match(((await update(prep())) as { text: string }).text, /: fetching bb-app 0\.50\.1 from the npm registry took longer than 2 minutes\. It kept the bb that was there/);
  assert.equal((kv.values.get(BB_UPDATES_KEY) as Record<string, { retryAt: number }>).bx_one!.retryAt, at + updateBackoffMs(2));
  // The server's version unknown: nothing asked of the registry (never "latest").
  const blind = fakeExec({ inspect: () => noDownload });
  assert.deepEqual(await createBbUpdater({ boat: blind.boat, kv: kvStore(), serverVersion: async () => null })(prep()), { kind: "none", why: "Boat couldn't tell which bb the server needs" });
  assert.equal(blind.scripts.some((script) => script.includes("BOAT_BBUP")), false);
});

test("a broken install the npm registry couldn't replace still goes aside for bb's setup, as without the fallback", async () => {
  let at = Date.parse("2026-11-19T02:00:00Z");
  const broken = INSPECTED.replace("BOAT_BB tgz 0.50.1", "BOAT_BB tgz none").replace("BOAT_BB bin ok", "BOAT_BB bin missing");
  const exec = fakeExec({ inspect: () => broken, install: () => "BOAT_BBOLD broken\nBOAT_BBUP fail registry ENOTFOUND\n", setAside: () => "BOAT_BBFIX moved" });
  const prefetched: { skipInstall: boolean }[] = [];
  const update = createBbUpdater({ boat: exec.boat, kv: kvStore(), serverVersion: async () => "0.50.1", now: () => at, prefetch: async (_id, request) => { prefetched.push(request); } });
  const failed = (await update(prep())) as { kind: string; text: string };
  assert.equal(prefetched[0]!.skipInstall, true, "a broken install isn't read: it's replaced or goes aside");
  assert.equal(failed.text, "Boat couldn't update bb on this sandbox to 0.50.1: the npm registry couldn't be reached (ENOTFOUND). bb's install there was already broken, so Boat moved it aside and bb's own setup installs it again. Boat tries the update again after 02:30 UTC.");
  assert.deepEqual(exec.scripts.map((script) => (script.includes("say end") ? "look" : script.includes("BOAT_BBUP") ? "install" : script.includes("BOAT_BBFIX") ? "set aside" : "other")), ["look", "install", "look", "set aside"], "looked at again after the failed fetch, before anything stops");
  assert.match(exec.scripts[3]!, /BOAT_BBFIX busy/, "and the set-aside checks once more right before the stop");
  // Held after that: no fetch, and a broken install there again goes aside again.
  at += 10 * 60_000;
  const step = prep();
  assert.deepEqual(await update(step), { kind: "set-aside" });
  assert.equal(exec.scripts.filter((script) => script.includes("BOAT_BBUP")).length, 1);
  assert.equal(exec.scripts.filter((script) => script.includes("BOAT_BBFIX")).length, 2);
  assert.deepEqual(step.logs, ["bb's install on the sandbox was broken (npm/bin/bb-app is missing); Boat moved it aside so bb's setup installs it again"]);
});

/** The updater over the real scripts, run on a sandbox copy (procfs and the look's 5 s sample faked). */
function realUpdater(box: ReturnType<typeof sandboxHome>, env: Record<string, string>, options: { proc: string; now?: () => number; sleep?: (ms: number) => Promise<unknown>; kv?: ReturnType<typeof kvStore>; prefetch?: () => void }) {
  const told: string[] = [];
  const update = createBbUpdater({
    boat: { exec: async (_id: string, script: string) => ({ exitCode: 0, stdout: box.run(script.replace(/^PR='\/proc'$/m, `PR='${options.proc}'`).replace(/^  sleep 5$/m, "  sleep 0"), env), stderr: "" }) },
    kv: options.kv ?? kvStore(),
    prefetch: options.prefetch && (async () => options.prefetch!()),
    serverVersion: async () => "0.50.1",
    tell: (_id, text) => told.push(text),
    now: options.now,
    sleep: options.sleep,
  });
  return { update, told };
}

test("bb repairs its broken install while the npm registry answers: after the failed fetch Boat looks again and leaves it alone", async (t) => {
  // The reviewer's case, with the real scripts: the bin is missing at the look; during the fetch
  // bb's own setup puts back a complete 0.50.1; then the registry says E404.
  const box = sandboxHome(t, { tgz: null, bin: false });
  const pkg = join(box.data, "npm", "lib", "node_modules", "bb-app");
  writeFileSync(join(box.fake, "pack-hook"), `mkdir -p "${box.data}/npm/bin"\nln -sf ../lib/node_modules/bb-app/dist/bb-app.js "${box.data}/npm/bin/bb-app"\nsed -i 's/0.49.0/0.50.1/' "${pkg}/package.json"\n`);
  const { update, told } = realUpdater(box, { FAKE_PACK_FAIL: "E404" }, { proc: join(box.root, "proc") });
  const result = (await update(prep({ hostId: HOST, woke: false }))) as { kind: string; text: string };
  assert.equal(result.kind, "failed");
  assert.match(result.text, /^Boat couldn't update bb on this sandbox to 0\.50\.1: the npm registry doesn't have bb-app 0\.50\.1 \(E404\)\. Meanwhile bb's install there became complete again, so Boat kept it; bb's own setup goes ahead\. Boat tries the update again after /);
  assert.deepEqual(told, [result.text]);
  assert.equal(box.log().includes("systemctl --user stop"), false, "bb's service never stopped");
  assert.equal(box.version(), "0.50.1", "the repaired install stays where it is");
  assert.deepEqual(readdirSync(box.data).filter((name) => /^npm\./.test(name)), [], "nothing moved aside");
  // Still broken after the fetch: then, and only then, it goes aside, as before.
  const still = sandboxHome(t, { tgz: null, bin: false });
  writeFileSync(join(still.data, "host-artifact.sha256"), "a".repeat(64));
  const second = realUpdater(still, { FAKE_PACK_FAIL: "E404" }, { proc: join(still.root, "proc") });
  assert.match(((await second.update(prep({ hostId: HOST, woke: false }))) as { text: string }).text, /bb's install there was already broken, so Boat moved it aside and bb's own setup installs it again/);
  assert.equal(existsSync(join(still.data, "npm")), false);
  assert.equal(readdirSync(still.data).filter((name) => name.startsWith("npm.broken-")).length, 1);
});

test("bb's own update starts while the npm registry answers: Boat waits for it after the failed fetch, and never stops it or moves its install", async (t) => {
  let at = Date.parse("2026-11-19T02:00:00Z");
  const sleeps: number[] = [];
  // It's still running after the 3 minutes: left to Boat's wake retries, nothing touched.
  const box = sandboxHome(t, { tgz: null, bin: false });
  const proc = join(box.root, "proc");
  mkdirSync(join(proc, "4242"), { recursive: true });
  writeFileSync(join(proc, "4242", "status"), "Name:\tnpm install -g \nState:\tS (sleeping)\n");
  writeFileSync(join(proc, "4242", "io"), "rchar: 100\n");
  const running = `   4242 Sl     20 npm install -g --prefix ${box.data}/npm ${box.data}/host-package-download/bb-app.tgz\n`;
  writeFileSync(join(box.fake, "pack-hook"), `printf '%s' '${running}' > "${box.fake}/ps"\n`);
  const { update, told } = realUpdater(box, { FAKE_PACK_FAIL: "ENOTFOUND" }, { proc, now: () => at, sleep: async (ms) => { sleeps.push(ms); at += ms; } });
  const error = (await update(prep({ hostId: HOST, woke: false })).catch((caught: unknown) => caught)) as BbUpdateHung;
  assert.ok(error instanceof BbUpdateHung, String(error));
  assert.equal(error.wakeDiagnosis.kind, "disk-restoring", "Boat's wake retries take it, as for any update of bb's own that won't end");
  assert.ok(sleeps.length >= 18 && sleeps.every((ms) => ms === 10_000), "it waited, looking again every 10 s");
  assert.equal(told.length, 1);
  assert.match(told[0]!, /: the npm registry couldn't be reached \(ENOTFOUND\)\. bb's own update was running there, so Boat left its install alone\. Boat tries the update again after /);
  assert.equal(box.log().includes("systemctl --user stop"), false);
  assert.ok(existsSync(join(box.data, "npm")), "its install stays where bb's update writes it");
  assert.deepEqual(readdirSync(box.data).filter((name) => /^npm\./.test(name)), []);
  // It ends during the wait and leaves the install complete: nothing more to do, nothing moved.
  const waits: number[] = [];
  const ends = sandboxHome(t, { tgz: null, bin: false });
  const proc2 = join(ends.root, "proc");
  mkdirSync(join(proc2, "4242"), { recursive: true });
  writeFileSync(join(proc2, "4242", "status"), "Name:\tnpm install -g \nState:\tS (sleeping)\n");
  writeFileSync(join(proc2, "4242", "io"), "rchar: 100\n");
  writeFileSync(join(ends.fake, "pack-hook"), `printf '%s' '${running.replaceAll(box.data, ends.data)}' > "${ends.fake}/ps"\n`);
  const done = realUpdater(ends, { FAKE_PACK_FAIL: "ENOTFOUND" }, {
    proc: proc2,
    now: () => at,
    sleep: async (ms) => {
      waits.push(ms);
      at += ms;
      rmSync(join(ends.fake, "ps"), { force: true });
      mkdirSync(join(ends.data, "npm", "bin"), { recursive: true });
      if (!existsSync(join(ends.data, "npm", "bin", "bb-app"))) symlinkSync("../lib/node_modules/bb-app/dist/bb-app.js", join(ends.data, "npm", "bin", "bb-app"));
    },
  });
  assert.match(((await done.update(prep({ hostId: HOST, woke: false }))) as { text: string }).text, /Meanwhile bb's install there became complete again, so Boat kept it/);
  assert.deepEqual(waits, [10_000]);
  assert.equal(ends.log().includes("systemctl --user stop"), false);
  assert.deepEqual(readdirSync(ends.data).filter((name) => /^npm\./.test(name)), []);
});

/** bb puts back a complete install (its bin, and package.json at this version), as its own setup would. */
function repair(box: ReturnType<typeof sandboxHome>, version: string): string {
  const pkg = join(box.data, "npm", "lib", "node_modules", "bb-app", "package.json");
  return `mkdir -p "${box.data}/npm/bin"\nln -sfn ../lib/node_modules/bb-app/dist/bb-app.js "${box.data}/npm/bin/bb-app"\nsed -i 's/"version": "[^"]*"/"version": "${version}"/' "${pkg}"\n`;
}

test("a repair during the prefetch, with an update held by its backoff: the cleanup looks again and leaves the complete install, and bb's service, as they are", async (t) => {
  // The re-review's first case, with the real scripts: a backoff holds the update, the look finds
  // the bin missing, and bb's setup puts back a complete 0.50.1 while Boat reads bb's files.
  const at = Date.parse("2026-11-19T02:00:00Z");
  const held = () => {
    const kv = kvStore();
    kv.values.set(BB_UPDATES_KEY, { bx_one: { failures: 1, retryAt: at + 20 * 60_000, detail: "npm install failed (ENOTFOUND)", at } });
    return kv;
  };
  const box = sandboxHome(t, { tgz: null, bin: false });
  const { update } = realUpdater(box, {}, { proc: join(box.root, "proc"), now: () => at, kv: held(), prefetch: () => box.run(repair(box, "0.50.1")) });
  assert.deepEqual(await update(prep({ hostId: HOST })), { kind: "none", why: "bb's install there is complete again" });
  assert.equal(box.log().includes("systemctl --user stop"), false, "bb's service never stopped");
  assert.equal(readFileSync(join(box.fake, "active"), "utf8").trim(), "active", "and it runs");
  assert.equal(box.version(), "0.50.1", "the repaired install stays where it is");
  assert.deepEqual(readdirSync(box.data).filter((name) => /^npm\./.test(name)), []);
  // bb's own npm install starts during the prefetch: Boat waits for it (never stops it), then looks again.
  const busy = sandboxHome(t, { tgz: null, bin: false });
  const proc = join(busy.root, "proc");
  mkdirSync(join(proc, "4242"), { recursive: true });
  writeFileSync(join(proc, "4242", "status"), "Name:\tnpm install -g \nState:\tS (sleeping)\n");
  writeFileSync(join(proc, "4242", "io"), "rchar: 100\n");
  let clock = at;
  const waits: number[] = [];
  const second = realUpdater(busy, {}, {
    proc,
    now: () => clock,
    kv: held(),
    prefetch: () => busy.set("ps", `   4242 Sl     20 npm install -g --prefix ${busy.data}/npm ${busy.data}/host-package-download/bb-app.tgz\n`),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
      rmSync(join(busy.fake, "ps"), { force: true });
      busy.run(repair(busy, "0.50.1"));
    },
  });
  assert.deepEqual(await second.update(prep({ hostId: HOST })), { kind: "none", why: "bb's install there is complete again" });
  assert.deepEqual(waits, [10_000]);
  assert.equal(busy.log().includes("systemctl --user stop"), false);
  assert.deepEqual(readdirSync(busy.data).filter((name) => /^npm\./.test(name)), []);
  // Still broken after the prefetch: it goes aside, as before.
  const still = sandboxHome(t, { tgz: null, bin: false });
  const third = realUpdater(still, {}, { proc: join(still.root, "proc"), now: () => at, kv: held(), prefetch: () => undefined });
  assert.deepEqual(await third.update(prep({ hostId: HOST })), { kind: "set-aside" });
  assert.equal(readdirSync(still.data).filter((name) => name.startsWith("npm.broken-")).length, 1);
});

test("a repair during a fetch that worked, then a failed fresh-prefix install: the rollback keeps the complete install and starts bb's service again", async (t) => {
  // The re-review's second case, with the real scripts: the bin is missing at the look; during the
  // fetch bb's setup puts back a complete 0.50.1; the fetch works; npm install would fail. Right
  // before the stop the install is the server's version already: nothing stopped or installed.
  const box = sandboxHome(t, { tgz: null, bin: false });
  writeFileSync(join(box.fake, "pack-hook"), repair(box, "0.50.1"));
  const { update, told } = realUpdater(box, { FAKE_NPM_FAIL: "ENOTFOUND" }, { proc: join(box.root, "proc") });
  assert.deepEqual(await update(prep({ hostId: HOST, woke: false })), { kind: "none", why: "bb 0.50.1 is installed" });
  assert.deepEqual(told, []);
  assert.equal(box.log().includes("systemctl --user stop"), false);
  assert.equal(box.log().includes("npm install"), false);
  assert.equal(readFileSync(join(box.fake, "active"), "utf8").trim(), "active");
  assert.equal(box.version(), "0.50.1");
  assert.deepEqual(readdirSync(box.data).filter((name) => /^npm\./.test(name)), []);
  // Repaired to another version: Boat goes on, the install fails, and the rollback keeps what was
  // there right before the stop (complete, 0.49.0) and starts bb's service again.
  const other = sandboxHome(t, { tgz: null, bin: false });
  writeFileSync(join(other.fake, "pack-hook"), repair(other, "0.49.0"));
  const second = realUpdater(other, { FAKE_NPM_FAIL: "ENOTFOUND" }, { proc: join(other.root, "proc") });
  const failed = (await second.update(prep({ hostId: HOST, woke: false }))) as { kind: string; text: string };
  assert.equal(failed.kind, "failed");
  assert.match(failed.text, /: npm install failed \(ENOTFOUND\)\. Meanwhile bb's install there became complete again, so Boat kept it; bb's own setup goes ahead\./);
  assert.ok(other.log().includes(`systemctl --user stop ${other.unit}`));
  assert.ok(other.log().includes(`systemctl --user start ${other.unit}`), "started again");
  assert.equal(readFileSync(join(other.fake, "active"), "utf8").trim(), "active");
  assert.equal(other.version(), "0.49.0", "the complete install stays");
  assert.deepEqual(readdirSync(other.data).filter((name) => /^npm\./.test(name)), [], "nothing moved aside");
  assert.equal(existsSync(join(other.data, "npm", "bin", "bb-app")), true);
});

test("the npm install script reads the old install again right before the stop, and its rollback goes by that reading", (t) => {
  // Intact at the look (0.49.0), updated in place by bb meanwhile (0.50.0): the rollback keeps that
  // one. On the old reading its version "changed under it", and it went aside.
  const box = sandboxHome(t, { tgz: null });
  writeFileSync(join(box.fake, "pack-hook"), repair(box, "0.50.0"));
  const result = parseInstall(box.run(installScript({ dataDir: box.data, unit: box.unit, node: null, version: "0.50.1", from: "0.49.0", npm: true }), { FAKE_NPM_FAIL: "ENOTFOUND" }));
  assert.deepEqual(result, { kind: "fail", reason: "npm", detail: "ENOTFOUND", old: "intact" });
  assert.equal(box.version(), "0.50.0");
  assert.equal(readFileSync(join(box.fake, "active"), "utf8").trim(), "active");
  // Broken only by a module it couldn't load (its files complete): its service tells. Still failing
  // right before the stop: broken, and it goes aside after a failed install, as before.
  const module = sandboxHome(t, { tgz: null, installed: "0.50.1" });
  module.set("active", "activating\n");
  const broken = { dataDir: module.data, unit: module.unit, node: null, version: "0.50.1", from: "0.50.1", broken: true, brokenBy: "service" as const, npm: true };
  assert.deepEqual(parseInstall(module.run(installScript(broken), { FAKE_NPM_FAIL: "ENOTFOUND" })), { kind: "fail", reason: "npm", detail: "ENOTFOUND", old: "set-aside" });
  // Running again by then (bb repaired it): it's the server's version, so nothing is stopped or installed.
  const up = sandboxHome(t, { tgz: null, installed: "0.50.1" });
  assert.deepEqual(parseInstall(up.run(installScript({ ...broken, dataDir: up.data, unit: up.unit }), { FAKE_NPM_FAIL: "ENOTFOUND" })), { kind: "current", version: "0.50.1" });
  assert.equal(up.log().includes("systemctl --user stop"), false);
  // Files still missing right before the stop, and the install fails: aside, as before.
  const gone = sandboxHome(t, { tgz: null, bin: false });
  assert.equal((parseInstall(gone.run(installScript({ dataDir: gone.data, unit: gone.unit, node: null, version: "0.50.1", from: "0.49.0", broken: true, brokenBy: "files", npm: true }), { FAKE_NPM_FAIL: "ENOTFOUND" })) as { old: string }).old, "set-aside");
});

test("the set-aside after a failed fetch checks once more right before the stop: bb's own npm install, or an install complete again, is left alone", (t) => {
  const box = sandboxHome(t, { tgz: null, bin: false });
  box.set("ps", `   4242 Sl     20 npm install -g --prefix ${box.data}/npm ${box.data}/host-package-download/bb-app.tgz\n`);
  assert.match(box.run(setAsideScript({ dataDir: box.data, unit: box.unit, recheck: "files", proc: join(box.root, "proc") })), /^BOAT_BBFIX busy 4242$/m);
  rmSync(join(box.fake, "ps"));
  mkdirSync(join(box.data, "npm", "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/bb-app/dist/bb-app.js", join(box.data, "npm", "bin", "bb-app"));
  assert.match(box.run(setAsideScript({ dataDir: box.data, unit: box.unit, recheck: "files" })), /^BOAT_BBFIX intact$/m);
  // Broken only by a module it couldn't load: its service running again counts as repaired.
  assert.match(box.run(setAsideScript({ dataDir: box.data, unit: box.unit, recheck: "service" })), /^BOAT_BBFIX intact$/m);
  assert.equal(box.log().includes("systemctl --user stop"), false);
  assert.ok(existsSync(join(box.data, "npm")));
  // Still broken and nobody at it: moved aside.
  rmSync(join(box.data, "npm", "bin", "bb-app"));
  assert.match(box.run(setAsideScript({ dataDir: box.data, unit: box.unit, recheck: "files" })), /^BOAT_BBFIX moved$/m);
  assert.equal(existsSync(join(box.data, "npm")), false);
});

test("backoffs of sandboxes long gone are dropped, and a removed machine's goes at once", async () => {
  let at = Date.parse("2026-11-19T02:00:00Z");
  const kv = kvStore();
  kv.values.set(BB_UPDATES_KEY, { bx_gone: { failures: 2, retryAt: at - 2 * 86_400_000, detail: "npm install failed (E404)", at: at - 3 * 86_400_000 }, bx_recent: { failures: 1, retryAt: at + 60_000, detail: "x", at } });
  const exec = fakeExec({ inspect: () => INSPECTED, install: () => "BOAT_BBOLD intact\nBOAT_BBUP fail npm ETIMEDOUT" });
  const update = createBbUpdater({ boat: exec.boat, kv, serverVersion: async () => "0.50.1", now: () => at });
  await update(prep({ sandboxId: "bx_one" }));
  assert.deepEqual(Object.keys(kv.values.get(BB_UPDATES_KEY) as object).sort(), ["bx_one", "bx_recent"]);
  await update.forget("bx_recent");
  assert.deepEqual(Object.keys(kv.values.get(BB_UPDATES_KEY) as object), ["bx_one"]);
});

test("bb's own update hung there: nothing is stopped or installed, and the wake fails already diagnosed", async () => {
  const zombie = INSPECTED.replace("BOAT_BB end", "BOAT_BB zombie 812 3600\nBOAT_BB end");
  let inspected = zombie;
  let install = "BOAT_BBUP done 0.50.1 active";
  const exec = fakeExec({ inspect: () => inspected, install: () => install });
  const prefetched: unknown[] = [];
  const update = createBbUpdater({ boat: exec.boat, kv: kvStore(), serverVersion: async () => "0.50.1", prefetch: async (_id, request) => { prefetched.push(request); } });
  // A zombie npm install: bb's daemon is broken, a repair under Needs you (it goes only with a VM restart).
  const hung = await update(prep()).catch((caught: unknown) => caught);
  assert.ok(hung instanceof BbUpdateHung);
  assert.equal(hung.message, "bb's own update hangs on this sandbox (npm install left a zombie: pid 812); only a restart of the sandbox clears it.");
  assert.deepEqual(hung.wakeDiagnosis, {
    kind: "daemon-broken", detail: "npm install left a zombie: pid 812", checked: true,
    daemon: { dir: "/home/user/.bb-machines/bb.example.com", unit: "bb-host-daemon-bb-example-com-host_1.service", zombie: true, dirs: ["/home/user/.bb-machines/bb.example.com"], units: ["bb-host-daemon-bb-example-com-host_1.service"] },
  });
  assert.equal(exec.scripts.length, 1, "only the look: no stop, no install");
  assert.deepEqual(prefetched, [], "nothing read while it hangs");
  // An npm install waiting on the disk: boat.dev is still restoring it, so Boat's retries later.
  inspected = INSPECTED.replace("BOAT_BB end", "BOAT_BB blocked 640 300\nBOAT_BB end");
  const waiting = (await update(prep()).catch((caught: unknown) => caught)) as BbUpdateHung;
  assert.equal(waiting.wakeDiagnosis.kind, "disk-restoring");
  assert.equal(retriesLater(waiting.wakeDiagnosis.kind), true);
  assert.match(waiting.message, /^bb's own update on this sandbox is waiting on its disk, which boat\.dev is still restoring \(bb's npm install is waiting on a file not restored yet \(pid 640, 300s\)\)\.$/);
  // bb's service won't stop for Boat's install: the same, nothing installed.
  inspected = INSPECTED;
  install = "BOAT_BBUP stuck deactivating";
  const stopping = (await update(prep()).catch((caught: unknown) => caught)) as BbUpdateHung;
  assert.equal(stopping.wakeDiagnosis.kind, "disk-restoring");
});

/** A Boat sandbox machine with the real wake guard and updater, over the fake boat. */
function machine(options: { inspect: () => string }) {
  let at = Date.parse("2026-11-19T02:00:00Z");
  const pacer = new WakePacer({ now: () => at, sleep: async (ms) => { at += ms; } });
  const kvValues = new Map<string, unknown>();
  const kv = { values: kvValues, async get<T>(key: string) { return kvValues.get(key) as T | undefined; }, async set(key: string, value: unknown) { kvValues.set(key, structuredClone(value)); }, async delete(key: string) { kvValues.delete(key); } };
  let wakes: ReturnType<typeof createWakeGuard> | null = null;
  const fake = makeService({ wakes: { pacer, forget: (sandboxId) => wakes!.forget(sandboxId) } });
  wakes = createWakeGuard({ pacer, kv, boat: fake.boat as never, store: fake.store, now: () => at, moves: { forkCheck: false } });
  fake.boat.limitsValue = { ...fake.boat.limitsValue, maxActiveSandboxes: 10 };
  const order: string[] = [];
  const execBefore = fake.boat.exec.bind(fake.boat);
  fake.boat.exec = async (sandboxId, script, execOptions) => {
    if (script.includes("say end")) {
      order.push("look");
      return { exitCode: 0, stdout: options.inspect(), stderr: "" };
    }
    if (script.includes("BOAT_PREFETCH")) order.push("prefetch");
    if (script.includes("update-motd.d")) order.push("login scripts");
    return execBefore(sandboxId, script, execOptions);
  };
  const prepareHost = createBbUpdater({ boat: fake.boat as never, kv, serverVersion: async () => "0.50.1", now: () => at, prefetch: async () => { order.push("prefetch"); } });
  let provider: { create(args: unknown): Promise<{ status: string; resource?: { sandboxId: string; key: string }; message?: string }>; resume(args: unknown): Promise<unknown> } | null = null;
  const bb = {
    experimental_machines: { register: (definition: typeof provider) => { provider = definition; }, bootstrap: async () => { order.push("bootstrap"); return { hostId: "host_1" }; } },
    experimental_environments: { register: () => undefined },
    storage: { kv },
  } as unknown as BbPluginApi;
  registerBoatMachine(bb, { boat: fake.boat as unknown as BoatApi, cli: { binary: async () => "/bin/boat" } as unknown as BoatCli, service: fake.service, settings: async () => defaultSettings(), wakes, prepareHost });
  const report = { steps: [] as string[], step(text: string) { this.steps.push(text); }, log: () => undefined };
  return {
    ...fake, wakes, order, report, kv,
    advance: (ms: number) => { at += ms; },
    now: () => at,
    async stopped() {
      const created = await provider!.create({ inputs: {}, key: "k", checkpoint: async () => undefined, report, signal: new AbortController().signal });
      assert.equal(created.status, "created", created.message);
      fake.boat.sandboxes.get(created.resource!.sandboxId)!.state = "stopped";
      order.length = 0;
      return created.resource!;
    },
    resume: (resource: unknown) => provider!.resume({ resource, report, signal: new AbortController().signal, hostId: "host_1" }),
  };
}

test("a resume reads bb's files and updates bb after the login scripts are off, before bb's setup", async () => {
  const env = machine({ inspect: () => INSPECTED.replace("installed 0.49.0", "installed 0.50.1") });
  const resource = await env.stopped();
  await env.resume(resource);
  assert.deepEqual(env.order, ["login scripts", "look", "prefetch", "bootstrap"]);
});

test("a zombie on a woken machine: no bb setup, the daemon repair under Needs you, nothing forced", async () => {
  const env = machine({ inspect: () => INSPECTED.replace("BOAT_BB end", "BOAT_BB zombie 812 3600\nBOAT_BB end") });
  const resource = await env.stopped();
  const sandboxId = resource.sandboxId;
  env.store.addOrchestrator("thr_orch");
  const first = (await env.resume(resource).catch((error: unknown) => error)) as Error;
  assert.equal(first.message, "bb's daemon on this sandbox broke during an update (npm install left a zombie: pid 812), so bb can't start there. It needs a repair by hand; the steps are under Needs you.");
  assert.equal(env.order.includes("bootstrap"), false, "bb's setup never ran into the hung update");
  assert.deepEqual(env.boat.calls.filter((call) => call.startsWith("stop ")), [], "Boat doesn't stop or force anything itself");
  const plan = await env.wakes.scheduled(sandboxId);
  assert.equal(plan?.kind, "daemon-broken");
  const decision = env.store.decisions({ statuses: ["open"], limit: 10 }).find((entry) => entry.id === plan?.decisionId);
  assert.equal(decision?.orchestratorThreadId, "thr_orch");
  assert.match(decision!.context ?? "", /bb-host-daemon-bb-example-com-host_1\.service/, "the repair names this machine's unit");
  assert.match(decision!.recommendation, /VM restart/);
});

test("an update waiting on the disk of a woken machine: Boat's own retries, as for a disk still restoring", async () => {
  const env = machine({ inspect: () => INSPECTED.replace("BOAT_BB end", "BOAT_BB blocked 640 300\nBOAT_BB end") });
  const resource = await env.stopped();
  const error = (await env.resume(resource).catch((caught: unknown) => caught)) as Error;
  assert.match(error.message, /^boat\.dev is still restoring this sandbox's disk \(files bb needs there aren't readable yet\)\. Boat will retry at \d\d:\d\d UTC; pressing Resume earlier won't help\.$/);
  const plan = await env.wakes.scheduled(resource.sandboxId);
  assert.equal(plan?.kind, "disk-restoring");
  assert.equal(plan?.failures, 1);
  assert.notEqual(plan?.retryAt, null);
  assert.equal(env.order.includes("bootstrap"), false);
});
