import { AVAILABILITY_SCRIPT, IDENTITY_SCRIPT } from "../src/providers/ownmac/probe.ts";
import { GITHUB_LOGIN_SCRIPT, GITHUB_CLEANUP_SCRIPT, CREDENTIAL_CLEANUP_SCRIPT } from "../src/credentials.ts";
import { CODEX_HEALTH_SCRIPT } from "../src/codex-health.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CHAINED_HOOKS, chainedHook, githubAccessSnippet, githubLogin, prepareRepo, prePushHook, shipScript, type RepoProvider } from "../src/sandbox-repos.ts";
import { BOOTSTRAP_PREP_SCRIPT, GITHUB_SECRET_PROBE_SCRIPT } from "../src/providers/instabox/provider.ts";
import { BOOTSTRAP } from "../src/providers/scaleway/provider.ts";
import { shipSnapshotScript } from "../src/ship-interaction.ts";
import { evidenceInstallScript } from "../src/evidence.ts";
import { sinceApprovalScript } from "../src/ship-approval.ts";
import { probeScript } from "../src/memory.ts";
import type { CheckoutMode } from "../src/providers/types.ts";

async function scripts(): Promise<Map<string, string>> {
  const result = new Map<string, string>([
    ["Your Mac identity", IDENTITY_SCRIPT],
    ["Your Mac availability", AVAILABILITY_SCRIPT],
    ["Scaleway bootstrap", BOOTSTRAP],
    ["GitHub credential delivery", GITHUB_LOGIN_SCRIPT],
    ["Credential cleanup", CREDENTIAL_CLEANUP_SCRIPT],
    ["Plugin GitHub cleanup", GITHUB_CLEANUP_SCRIPT],
    ["Codex health", CODEX_HEALTH_SCRIPT],
    ["Instabox bootstrap", BOOTSTRAP_PREP_SCRIPT],
    ["Instabox beforeRepo", GITHUB_SECRET_PROBE_SCRIPT],
    ["ship snapshot", shipSnapshotScript([{ path: "/tmp/web", baseBranch: "main" }])],
    ["evidence install", evidenceInstallScript("console.log('ready');", ["BOAT_TEST_CONFIG"])],
    ["since approval", sinceApprovalScript({ path: "/tmp/web", baseBranch: "main", head: "abc1234", base: "def5678" })],
    ["memory probe", probeScript()],
    ["memory probe with options", probeScript({ task: "task-check", since: 100, stopSampler: true, klog: { mode: "sudo", bootId: null } })],
    ["pre-push", prePushHook()],
    ...CHAINED_HOOKS.map(hook => [hook, chainedHook(hook)] as [string, string]),
    ["ship", shipScript([{ path: "/tmp/web", baseBranch: "main" }])],
  ]);
  for (const retry of [false, true]) {
    result.set(`access retry=${retry}`, githubAccessSnippet(retry));
    const modes: CheckoutMode[] = [
      { kind: "new-branch", branch: "task/check", base: "main" },
      { kind: "existing-branch", branch: "task/check" },
      { kind: "pull-request", pr: "42" },
      { kind: "default-branch" },
    ];
    for (const mode of modes) {
      const provider: RepoProvider = {
        retryGithubAccess: retry,
        async exec(_id, script) {
          result.set(`prepare ${mode.kind} retry=${retry}`, script);
          return { exitCode: 0, stdout: "BOAT_ACCESS ok push=true\nBOAT_SETUP path=/tmp/web branch=task/check base=main", stderr: "" };
        },
      };
      await prepareRepo(provider, "machine", "acme/web", mode);
    }
  }
  await githubLogin({ async exec(_id, script) {
    result.set("GitHub login", script);
    return { exitCode: 0, stdout: "BOAT_LOGIN ok", stderr: "" };
  } }, "machine");
  return result;
}

function check(shell: string, args: string[], name: string, script: string): void {
  const checked = spawnSync(shell, args, { input: script, encoding: "utf8" });
  assert.equal(checked.error, undefined, `${shell}: ${checked.error}`);
  assert.equal(checked.status, 0, `${name} (${shell} ${args.join(" ")}): ${checked.stderr}`);
}

// Generated shell uses case headers and ;; arm terminators. Check the text
// after each boundary, including inline/nested cases and hooks in heredocs.
// Syntax checks alone on modern bash accept the original bash 3.2 regression.
function assertBalancedCasePatterns(name: string, script: string): void {
  const shell = script.replace(/^\s*#.*$/gm, "");
  for (const boundary of shell.matchAll(/\bcase\s+[^\n;]*?\s+in\b|;;/g)) {
    const arm = shell.slice(boundary.index! + boundary[0].length).trimStart();
    if (/^esac\b/.test(arm)) continue;
    assert.ok(arm.startsWith("("), `${name}: case arm must start with (: ${arm.split("\n")[0]}`);
  }
}

test("every generated Mac script uses balanced case patterns", async () => {
  for (const [name, script] of await scripts()) assertBalancedCasePatterns(name, script);
});

test("static guard rejects the original access snippet even on modern bash", () => {
  // The original snippet's only difference was the missing leading parens.
  const original = githubAccessSnippet(false).replace(/^(\s*)\(/gm, "$1");
  check("bash", ["--posix", "-n"], "original access snippet", original);
  assert.throws(() => assertBalancedCasePatterns("original access snippet", original), /case arm must start with/);
  // Cover later arms, inline arms and nested cases as well as the first arm.
  for (const script of [
    'case "$x" in (a) : ;; b) : ;; esac',
    'case "$x" in (*) case "$y" in a) : ;; esac ;; esac',
  ]) assert.throws(() => assertBalancedCasePatterns("unbalanced", script), /case arm must start with/);
});

test("generated repo scripts parse in POSIX-mode bash; hooks also parse as sh", async () => {
  for (const [name, script] of await scripts()) {
    check("bash", ["--posix", "-n"], name, script);
    if (script.startsWith("#!/bin/sh")) check("/bin/sh", ["-n"], name, script);
  }
});

// Linux's modern bash does not reproduce every bash 3.2 parser bug. On a Mac
// use its system shell; an explicit binary also lets Linux verify the old parser.
const systemVersion = spawnSync("/bin/bash", ["-c", 'printf %s "$BASH_VERSION"'], { encoding: "utf8" }).stdout;
const bash3 = process.env.BOAT_TEST_BASH3 ?? (systemVersion?.startsWith("3.") ? "/bin/bash" : undefined);
test("generated repo scripts parse with bash 3.x", { skip: !bash3 }, async () => {
  const version = spawnSync(bash3!, ["-c", 'printf %s "$BASH_VERSION"'], { encoding: "utf8" });
  assert.match(version.stdout, /^3\./);
  for (const [name, script] of await scripts()) check(bash3!, ["-n"], name, script);
});
