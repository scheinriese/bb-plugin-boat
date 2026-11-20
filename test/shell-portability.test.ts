import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CHAINED_HOOKS, chainedHook, githubAccessSnippet, githubLogin, prepareRepo, prePushHook, shipScript, type RepoProvider } from "../src/sandbox-repos.ts";
import { BOOTSTRAP_PREP_SCRIPT } from "../src/providers/instabox/provider.ts";
import { BOOTSTRAP } from "../src/providers/scaleway/provider.ts";
import type { CheckoutMode } from "../src/providers/types.ts";

async function scripts(): Promise<Map<string, string>> {
  const result = new Map<string, string>([
    ["Scaleway bootstrap", BOOTSTRAP],
    ["Instabox bootstrap", BOOTSTRAP_PREP_SCRIPT],
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
