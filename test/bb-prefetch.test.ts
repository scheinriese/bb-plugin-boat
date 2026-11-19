// Reading bb's own files right after a wake: only bb's data dir and its node, bounded in
// size and time, and never holding up the wake past its limit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PREFETCH_SECONDS, parsePrefetch, prefetchBbFiles, prefetchScript } from "../src/bb-prefetch.ts";

function home(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "boat-prefetch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, ".bb-machines", "bb.example.com");
  const node = join(root, ".nvm", "versions", "node", "v24.11.1");
  const file = (path: string, bytes: number) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 1));
  };
  file(join(data, "npm", "lib", "node_modules", "bb-app", "dist", "bb-app.js"), 1000);
  file(join(data, "state.db"), 8000);
  file(join(data, "npm.old-0.48.0-1700000000", "lib", "x.js"), 2000);
  file(join(data, "npm.new", "lib", "y.js"), 2000);
  file(join(data, "host-package-download", "bb-app.tgz"), 4000);
  file(join(node, "bin", "node"), 16000);
  // Older nodes and everything else in the home are left alone.
  file(join(root, ".nvm", "versions", "node", "v22.1.0", "bin", "node"), 64000);
  file(join(root, "work", "repo", "big.bin"), 32000);
  const run = (script: string) => parsePrefetch(execFileSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: root } }));
  return { root, data, node: join(node, "bin", "node"), run };
}

test("only bb's data dir and the node bb runs on are read, without old or half-made installs", (t) => {
  const box = home(t);
  assert.deepEqual({ ...box.run(prefetchScript({ dataDir: box.data, node: box.node, skipInstall: false })), seconds: 0 }, { kind: "done", bytes: 1000 + 8000 + 16000, seconds: 0 });
  // The install Boat is about to replace isn't read either.
  assert.equal((box.run(prefetchScript({ dataDir: box.data, node: box.node, skipInstall: true })) as { bytes: number }).bytes, 8000 + 16000);
  // A system node or a data dir outside the home is never read: bb's data dirs and nvm's newest node instead.
  assert.equal((box.run(prefetchScript({ dataDir: "/usr", node: "/usr/bin/node", skipInstall: false })) as { bytes: number }).bytes, 1000 + 8000 + 16000);
  // Unknown dirs: every bb data dir, and the newest node (v24, not the older v22).
  assert.equal((box.run(prefetchScript({ dataDir: null, node: null, skipInstall: false })) as { bytes: number }).bytes, 1000 + 8000 + 16000);
});

test("bounded per file and in total", (t) => {
  const box = home(t);
  assert.equal((box.run(prefetchScript({ dataDir: box.data, node: box.node, skipInstall: false }, { maxFileKb: 10 })) as { bytes: number }).bytes, 1000 + 8000, "files of 10 KiB or more are skipped");
  assert.equal((box.run(prefetchScript({ dataDir: box.data, node: box.node, skipInstall: false }, { maxBytes: 5000 })) as { bytes: number }).bytes, 5000, "it stops at the total");
  const empty = mkdtempSync(join(tmpdir(), "boat-prefetch-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.deepEqual(parsePrefetch(execFileSync("bash", ["-c", prefetchScript({ dataDir: null, node: null, skipInstall: false })], { encoding: "utf8", env: { ...process.env, HOME: empty } })), { kind: "none" });
});

test("a prefetch stuck on the disk stops holding up the wake at its limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let seen: AbortSignal | null = null;
  const boat = {
    exec: (_id: string, _script: string, options: { signal?: AbortSignal } = {}) => {
      seen = options.signal ?? null;
      // A read in D state on lazyfs: the exec never answers.
      return new Promise<never>(() => undefined);
    },
  };
  const logs: string[] = [];
  const running = prefetchBbFiles(boat as never, "bx_one", { dataDir: null, node: null, skipInstall: false }, { signal: new AbortController().signal, log: (line) => logs.push(line) });
  t.mock.timers.tick((PREFETCH_SECONDS + 15) * 1000);
  assert.deepEqual(await running, { kind: "timed-out" });
  assert.equal(seen!.aborted, true, "boat's exec is told to stop");
  assert.match(logs[0]!, /stopped waiting after 75s; bb's setup goes ahead/);
});

test("a failed prefetch never fails the wake; the wake's own abort still does", async () => {
  const failing = { exec: async () => { throw new Error("Input/output error"); } };
  assert.deepEqual(await prefetchBbFiles(failing as never, "bx_one", { dataDir: null, node: null, skipInstall: false }, { signal: new AbortController().signal }), { kind: "failed", detail: "Input/output error" });
  const odd = { exec: async () => ({ exitCode: 1, stdout: "", stderr: "bash: find: command not found" }) };
  assert.equal((await prefetchBbFiles(odd as never, "bx_one", { dataDir: null, node: null, skipInstall: false }, { signal: new AbortController().signal })).kind, "failed");
  const wake = new AbortController();
  wake.abort();
  await assert.rejects(prefetchBbFiles(failing as never, "bx_one", { dataDir: null, node: null, skipInstall: false }, { signal: wake.signal }));
});
