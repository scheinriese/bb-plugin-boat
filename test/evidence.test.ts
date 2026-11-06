// Screenshots and recordings outlive the sandbox: the uploader is installed
// in every task sandbox, workers are told to use it, and the orchestrator
// hears when a report mentions evidence without links.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EVIDENCE_NOTE, composeFollowupPrompt, composeHandoverPrompt, composeInitialPrompt } from "../src/briefs.ts";
import {
  BUILTIN_CONFIG_NAMES,
  DEFAULT_EVIDENCE_UPLOADER,
  EVIDENCE_BIN,
  EVIDENCE_LIB,
  bundledUploaderPath,
  createEvidenceSource,
  evidenceInstallScript,
  evidenceLinks,
  evidenceSourceProblem,
  evidenceStatus,
  evidenceWithoutLinks,
  installSummary,
  missingBuiltinConfig,
  parseEvidenceSource,
  parseInstallResult,
  readBundledUploader,
  uploaderWorks,
} from "../src/evidence.ts";
import { PLUGIN_SETTINGS } from "../src/settings.ts";
import { notificationText, taskDetail } from "../src/format.ts";
import { TaskError, clipResult } from "../src/service.ts";
import { contentsPath } from "../src/github.ts";
import { testTaskInput } from "../src/setup.ts";
import { makeService } from "./fakes.ts";

const LINK =
  "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/example-evidence/2026-11-05/web/boat-t_1/201500-ab12-header/header.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
/** An uploader source for the tests (the setting is off by default). */
const UPLOADER = "acme/tools:scripts/evidence-upload.mjs";

test("the uploader's source: builtin, or owner/repo:path, optionally @ref; empty turns it off", () => {
  assert.equal(parseEvidenceSource(DEFAULT_EVIDENCE_UPLOADER), null, "off by default");
  assert.deepEqual(parseEvidenceSource("builtin"), { kind: "builtin" });
  assert.deepEqual(parseEvidenceSource(" Builtin "), { kind: "builtin" });
  assert.deepEqual(parseEvidenceSource(UPLOADER), { kind: "github", repo: "acme/tools", path: "scripts/evidence-upload.mjs", ref: null });
  assert.deepEqual(parseEvidenceSource(" acme/tools:bin/up.mjs@0123abc "), { kind: "github", repo: "acme/tools", path: "bin/up.mjs", ref: "0123abc" });
  assert.equal(parseEvidenceSource("  "), null);
  assert.throws(() => parseEvidenceSource("scripts/evidence-upload.mjs"), /isn't builtin or owner\/repo:path/);
  // The setting refuses values the install couldn't use.
  assert.equal(evidenceSourceProblem("builtin"), null);
  assert.equal(evidenceSourceProblem(""), null);
  assert.match(evidenceSourceProblem("s3://bucket") ?? "", /isn't builtin/);
  const schema = PLUGIN_SETTINGS.evidenceUploader.experimental_schema;
  assert.equal(schema.safeParse("builtin").success, true);
  assert.equal(schema.safeParse(UPLOADER).success, true);
  assert.equal(schema.safeParse("nope").success, false);
  assert.equal(PLUGIN_SETTINGS.evidenceUploader.default, "");
  // The default branch: no ref in the API path (as `gh api …/contents/<path>`).
  assert.equal(contentsPath("acme/tools", "scripts/evidence-upload.mjs", null), "repos/acme/tools/contents/scripts/evidence-upload.mjs");
  assert.equal(contentsPath("a/b", "x y.md", "main"), "repos/a/b/contents/x%20y.md?ref=main");
});

test("the install script writes the uploader and its wrapper, and names the variables it finds without printing values", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-install-"));
  const uploader = `#!/usr/bin/env node\n// ünïcode and 'quotes' and $dollars \`ticks\`\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`;
  // Run the real script against a temp prefix, without sudo.
  const script = evidenceInstallScript(uploader, BUILTIN_CONFIG_NAMES).replaceAll("/usr/local", join(dir, "usr/local")).replaceAll("sudo ", "");
  writeFileSync(join(dir, "install.sh"), script);
  const out = execFileSync("bash", [join(dir, "install.sh")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      EVIDENCE_BUCKET: "example-evidence",
      EVIDENCE_ACCESS_KEY_ID: "fake_value_key_id",
      CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
      EVIDENCE_REGION: "",
    },
  });
  assert.doesNotMatch(out, /fake_value|example-evidence|ffffffff/);
  const result = parseInstallResult(out);
  assert.deepEqual(result?.present, ["EVIDENCE_BUCKET", "EVIDENCE_ACCESS_KEY_ID", "CLOUDFLARE_ACCOUNT_ID"]);
  assert.match(result?.node ?? "", /^v\d+/);
  assert.equal(installSummary(result!), "Installed evidence-upload, but missing EVIDENCE_SECRET_ACCESS_KEY in this sandbox's environment: uploads will fail");

  const lib = join(dir, EVIDENCE_LIB.slice(1));
  const bin = join(dir, EVIDENCE_BIN.slice(1));
  assert.equal(readFileSync(lib, "utf8"), uploader);
  assert.equal(readFileSync(bin, "utf8"), `#!/bin/sh\nexec node ${lib} "$@"\n`);
  assert.equal(statSync(bin).mode & 0o777, 0o755);
  assert.equal(statSync(lib).mode & 0o777, 0o644);
  // Arguments pass through intact.
  assert.equal(execFileSync(bin, ["shots/a b.png", "--name", "header"], { encoding: "utf8" }).trim(), JSON.stringify(["shots/a b.png", "--name", "header"]));
  // In the sandbox it's the fixed paths, with sudo.
  const real = evidenceInstallScript(uploader);
  assert.match(real, /sudo install -m 0644 "\$TMP" \/usr\/local\/lib\/evidence-upload\.mjs/);
  assert.match(real, /sudo install -m 0755 "\$TMP\.wrapper" \/usr\/local\/bin\/evidence-upload/);
  assert.match(real, /printf '%s\\n' '#!\/bin\/sh' 'exec node \/usr\/local\/lib\/evidence-upload\.mjs "\$@"'/);

  // A custom script's variables are its own: nothing is checked.
  const custom = evidenceInstallScript(uploader, []).replaceAll("/usr/local", join(dir, "custom/usr/local")).replaceAll("sudo ", "");
  writeFileSync(join(dir, "custom.sh"), custom);
  const customOut = execFileSync("bash", [join(dir, "custom.sh")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", EVIDENCE_BUCKET: "example-evidence" } });
  assert.deepEqual(parseInstallResult(customOut, [])?.present, []);
});

test("the task history says whether uploads will work", () => {
  const all = ["EVIDENCE_BUCKET", "EVIDENCE_ACCESS_KEY_ID", "EVIDENCE_SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID"];
  assert.equal(
    installSummary({ node: "v22.11.0", present: all }),
    "Installed evidence-upload (keys present: EVIDENCE_BUCKET, EVIDENCE_ACCESS_KEY_ID, EVIDENCE_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID)",
  );
  // No endpoint variable: AWS S3, and the history says so.
  assert.match(installSummary({ node: "v22.11.0", present: ["EVIDENCE_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] }), /keys present: .*; no EVIDENCE_ENDPOINT or CLOUDFLARE_ACCOUNT_ID, so AWS S3\)$/);
  assert.equal(
    installSummary({ node: "v18.2.0", present: ["EVIDENCE_BUCKET", "EVIDENCE_R2_ACCESS_KEY_ID"] }),
    "Installed evidence-upload, but node is v18.2.0 (needs 20+) and missing EVIDENCE_R2_SECRET_ACCESS_KEY in this sandbox's environment: uploads will fail",
  );
  assert.match(installSummary({ node: null, present: all }), /node isn't installed/);
  assert.match(installSummary({ node: "v22.1.0", present: [] }), /missing EVIDENCE_BUCKET, EVIDENCE_ACCESS_KEY_ID, EVIDENCE_SECRET_ACCESS_KEY in/);
  // A custom script: installed, its settings unchecked.
  const github = parseEvidenceSource(`${UPLOADER}@0123abc`)!;
  assert.equal(installSummary({ node: "v22.1.0", present: [] }, github), "Installed evidence-upload from acme/tools:scripts/evidence-upload.mjs@0123abc (its settings aren't checked)");
  for (const event of [installSummary({ node: "v22.1.0", present: all }), installSummary({ node: "v22.1.0", present: [] }, github), "Installed evidence-upload (keys present)"]) {
    assert.equal(uploaderWorks(event), true, event);
  }
  assert.equal(uploaderWorks(installSummary({ node: "v22.1.0", present: [] })), false);
  assert.equal(uploaderWorks("Couldn't install evidence-upload: gh: HTTP 502"), false);
  assert.equal(uploaderWorks(null), false);
  assert.equal(parseInstallResult("no marker"), null);
  // Only checked names are reported, whatever the output contains.
  assert.deepEqual(parseInstallResult("BOAT_EVIDENCE node=v22.1.0 present=EVIDENCE_BUCKET something-else")?.present, ["EVIDENCE_BUCKET"]);
});

test("the plugin's check and the uploader agree on what's missing", async () => {
  const uploader = (await import(pathToFileURL(bundledUploaderPath()).href)) as { readConfig(env: Record<string, string>): unknown };
  const values: Record<string, string> = {
    EVIDENCE_BUCKET: "example-evidence",
    EVIDENCE_ACCESS_KEY_ID: "fake_id",
    EVIDENCE_SECRET_ACCESS_KEY: "fake_secret",
    EVIDENCE_R2_ACCESS_KEY_ID: "fake_id",
    EVIDENCE_R2_SECRET_ACCESS_KEY: "fake_secret",
    AWS_ACCESS_KEY_ID: "fake_id",
    AWS_SECRET_ACCESS_KEY: "fake_secret",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  };
  const names = Object.keys(values);
  // Every subset of the variables.
  for (let mask = 0; mask < 1 << names.length; mask += 1) {
    const present = names.filter((_, index) => mask & (1 << index));
    const env = Object.fromEntries(present.map((name) => [name, values[name]!]));
    const missing = missingBuiltinConfig(present);
    let reported: string[] = [];
    try {
      uploader.readConfig(env);
    } catch (error) {
      reported = (error as Error).message.match(/^missing ([A-Z0-9_, ]+)/)?.[1]?.split(", ") ?? [];
    }
    assert.deepEqual(reported, missing, present.join(" "));
  }
});

test("the built-in uploader comes from the plugin's folder, in path and git installs", async () => {
  const real = bundledUploaderPath();
  assert.equal(real, fileURLToPath(new URL("../assets/evidence-upload.mjs", import.meta.url)));
  assert.match(readBundledUploader(), /^#!\/usr\/bin\/env node\n/);
  // A git install runs dist/server.js; a path install runs src/*.ts. Both find assets/ one folder up.
  const root = mkdtempSync(join(tmpdir(), "boat-plugin-layout-"));
  mkdirSync(join(root, "assets"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "assets", "evidence-upload.mjs"), "// bundled\n");
  for (const entry of ["dist/server.js", "src/evidence.ts"]) {
    assert.equal(bundledUploaderPath(pathToFileURL(join(root, entry)).href), join(root, "assets", "evidence-upload.mjs"), entry);
  }
  const empty = mkdtempSync(join(tmpdir(), "boat-plugin-empty-"));
  mkdirSync(join(empty, "dist"));
  assert.throws(() => bundledUploaderPath(pathToFileURL(join(empty, "dist", "server.js")).href), /built-in uploader \(assets\/evidence-upload\.mjs\) is missing/);
  // The builtin source reads it (no GitHub involved).
  const source = createEvidenceSource(async () => {
    throw new Error("no GitHub for builtin");
  });
  assert.equal(await source.script({ kind: "builtin" }), readFileSync(real, "utf8"));
  const broken = createEvidenceSource(async () => "", 0, undefined, () => " ");
  await assert.rejects(broken.script({ kind: "builtin" }), /empty/);
});

test("the uploader is fetched once, and the last good copy survives a GitHub outage", async () => {
  let reads = 0;
  let fail = false;
  const source = createEvidenceSource(async (repo, path, ref) => {
    reads += 1;
    assert.deepEqual([repo, path, ref], ["acme/tools", "scripts/evidence-upload.mjs", null]);
    if (fail) throw new Error("gh: HTTP 502");
    return "console.log('up')\n";
  }, 0);
  const ref = parseEvidenceSource(UPLOADER)!;
  assert.equal(await source.script(ref), "console.log('up')\n");
  fail = true;
  assert.equal(await source.script(ref), "console.log('up')\n");
  assert.equal(reads, 2);
  // Never fetched: the error surfaces.
  const empty = createEvidenceSource(async () => "  ");
  await assert.rejects(empty.script(ref), /empty/);
});

test("workers are told to upload, and the report block asks for the evidence", () => {
  const base = {
    taskId: "t_1",
    role: "implement" as const,
    title: "Header",
    brief: "Do it.",
    workspace: { repo: "acme/web", repoPath: "/home/user/work/t_1/web", branch: "boat/x", baseBranch: "main", prUrl: null },
  };
  for (const runner of ["chat", "boat"] as const) {
    const prompt = composeInitialPrompt({ ...base, runner, evidence: true });
    assert.ok(prompt.includes(EVIDENCE_NOTE), runner);
    assert.match(prompt, /This sandbox is deleted after your task, so files left only here are lost\./);
    assert.match(prompt, /`evidence-upload <files or folders> --name <short label>`/);
    assert.match(prompt, /Run it from your checkout, so the upload is filed under the repo and branch\./);
    assert.match(prompt, /TESTS: [^\n]*\nEVIDENCE: <links above, when you uploaded/);
    assert.doesNotMatch(composeInitialPrompt({ ...base, runner }), /evidence-upload|EVIDENCE:/);
  }
  const review = composeInitialPrompt({ ...base, role: "review", runner: "chat", evidence: true });
  assert.match(review, /TESTS: [^\n]*\nEVIDENCE: /);
  assert.ok(review.includes(EVIDENCE_NOTE));
  const custom = composeInitialPrompt({ ...base, role: "custom", runner: "boat", evidence: true });
  assert.ok(custom.includes(EVIDENCE_NOTE));
  // In a chat the block stays inside its text fence.
  assert.match(composeInitialPrompt({ ...base, runner: "chat", evidence: true }), /```text\n=== REPORT ===[\s\S]*EVIDENCE: [\s\S]*=== END REPORT ===\n```/);
  const handover = composeHandoverPrompt({ ...base, fromProvider: "claude", fromThreadId: "thr_a", why: "switch", message: null, evidence: true });
  assert.ok(handover.includes(EVIDENCE_NOTE));
  assert.match(handover, /EVIDENCE: /);
  assert.match(composeFollowupPrompt("implement", "Fix it.", { runner: "chat", evidence: true }), /EVIDENCE: /);
  assert.doesNotMatch(composeFollowupPrompt("implement", "Fix it.", { runner: "chat" }), /EVIDENCE: /);
});

test("the EVIDENCE line: links, none, a failed upload, or silence", () => {
  assert.deepEqual(evidenceStatus(`- [a.png](${LINK})`), { kind: "links", links: [LINK] });
  for (const value of ["none", '"none"', "None.", "n/a", "-", "<none>"]) assert.deepEqual(evidenceStatus(`Screenshot of nothing.\nEVIDENCE: ${value}`), { kind: "none" }, value);
  assert.deepEqual(evidenceStatus("EVIDENCE: none: the upload failed, keys missing"), { kind: "failed", detail: "none: the upload failed, keys missing" });
  assert.equal(evidenceStatus("Took screenshots.\nEVIDENCE: links above").kind, "missing");
  assert.equal(evidenceStatus("Fixed a typo.").kind, "unspecified");
});

test("a long final message keeps its report block", () => {
  const report = "```text\n=== REPORT ===\nSTATUS: done\nEVIDENCE: links above\n=== END REPORT ===\n```";
  const text = `${"x".repeat(20_000)}\n- [a.png](${LINK})\n\n${report}`;
  const clipped = clipResult(text, 16_000);
  assert.ok(clipped.length <= 16_000);
  assert.ok(clipped.endsWith(report));
  assert.match(clipped, /…\(cut\)…/);
  assert.equal(clipResult("short"), "short");
});

test("reports with evidence links, without them, and with none", () => {
  const withLinks = `Done.\n\n- [header.png](${LINK}) (120 KB), key \`2026-11-05/x/header.png\`\n\n=== REPORT ===\nSTATUS: done\nEVIDENCE: links above\n=== END REPORT ===`;
  assert.deepEqual(evidenceLinks(withLinks), [LINK]);
  assert.equal(evidenceWithoutLinks(withLinks), false);
  assert.equal(evidenceWithoutLinks("I took screenshots of the header at /tmp/shots/header.png."), true);
  assert.equal(evidenceWithoutLinks("Recorded a screen recording of the flow."), true);
  assert.equal(evidenceWithoutLinks("Fixed the parser.\nEVIDENCE: none"), false);
  assert.equal(evidenceWithoutLinks("Refactored the recording pipeline's queue."), false);
  assert.equal(evidenceWithoutLinks(null), false);
});

test("evidence links: presigned links on any host, and any https link on the EVIDENCE line", () => {
  const aws = "https://s3.eu-west-1.amazonaws.com/example-evidence/2026-11-06/web/main/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=fake_id%2F20261106%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20261106T120000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=fake";
  const minio = "https://minio.example.com/example-evidence/b.mp4?X-Amz-Credential=fake_id&X-Amz-Signature=fake";
  const text = [
    `- [a.png](${aws}) (120 KB)`,
    `Also ${minio}.`,
    // Ordinary links aren't evidence…
    "Docs: https://example.com/guide and the PR https://github.com/acme/web/pull/7",
    "=== REPORT ===",
    // …unless the EVIDENCE line names them (a custom uploader's links).
    "EVIDENCE: https://cdn.example.com/shots/c.png, https://cdn.example.com/shots/d.png.",
    "=== END REPORT ===",
  ].join("\n");
  assert.deepEqual(evidenceLinks(text), [aws, minio, "https://cdn.example.com/shots/c.png", "https://cdn.example.com/shots/d.png"]);
  assert.deepEqual(evidenceStatus(text), { kind: "links", links: evidenceLinks(text) });
  // R2 links still count; duplicates once.
  assert.deepEqual(evidenceLinks(`${LINK}\n${LINK}`), [LINK]);
  // A plain link elsewhere doesn't make a report "with links".
  assert.equal(evidenceStatus("Screenshot at https://example.com/a.png").kind, "missing");
  assert.deepEqual(evidenceLinks(null), []);
});

test("an EVIDENCE line that says failed or none wins over links the text quotes", () => {
  const plainPut = "https://example-bucket.s3.us-east-1.amazonaws.com/x.png";
  assert.deepEqual(evidenceStatus(`Took screenshots.\nEVIDENCE: upload failed: PUT ${plainPut} returned 403`), {
    kind: "failed",
    detail: `upload failed: PUT ${plainPut} returned 403`,
  });
  assert.deepEqual(evidenceLinks(`EVIDENCE: upload failed: PUT ${plainPut} returned 403`), []);
  assert.deepEqual(evidenceStatus("Fixed it.\nEVIDENCE: none (the PR is https://github.com/acme/web/pull/12)"), { kind: "none" });
  // A presigned download link quoted elsewhere (a release asset) isn't an upload.
  const asset = "https://objects.example.com/release/asset.zip?X-Amz-Credential=fake_id&X-Amz-Signature=fake";
  const quoted = `Downloaded ${asset} to test.\nEVIDENCE: none`;
  assert.deepEqual(evidenceStatus(quoted), { kind: "none" });
  assert.deepEqual(evidenceLinks(quoted), []);
  // A partial upload: the links it printed still count, and the report says what failed.
  assert.deepEqual(evidenceStatus(`- [a.png](${LINK})\nEVIDENCE: b.png failed to upload`), { kind: "failed", detail: "b.png failed to upload" });
  assert.deepEqual(evidenceLinks(`- [a.png](${LINK})\nEVIDENCE: b.png failed to upload`), [LINK]);
  // Words in a link don't count as what the line says.
  const errorShot = "https://minio.example.com/example-evidence/error-dialog.png?X-Amz-Credential=fake_id&X-Amz-Signature=fake";
  assert.deepEqual(evidenceStatus(`EVIDENCE: ${errorShot}`), { kind: "links", links: [errorShot] });
  assert.deepEqual(evidenceStatus("EVIDENCE: https://cdn.example.com/shots/no-results.png"), { kind: "links", links: ["https://cdn.example.com/shots/no-results.png"] });
});

test("the orchestrator's notice counts uploads, or flags evidence without links where uploads work", async () => {
  const env = makeService();
  const { task } = await env.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  const at = (result: string) => ({ ...env.store.get(task.id)!, status: "idle" as const, result });
  const works = () => "Installed evidence-upload (keys present)";
  const linked = notificationText([at(`See below.\n- [a.png](${LINK})\n- [b.png](${LINK}&x=2)`)], undefined, works);
  assert.match(linked, /Evidence: 2 uploaded files \(links in `boat_task`, valid up to 7 days\)\./);
  const unlinked = notificationText([at("Done. Screenshots are in /home/user/shots.")], undefined, works);
  assert.match(unlinked, /mentions screenshots or recordings but has no upload links: if the worker made any, ask it to upload them \(`boat_followup` with `evidence_only`\)/);
  assert.doesNotMatch(notificationText([at("Done.\nEVIDENCE: none")], undefined, works), /Evidence:|evidence-upload|upload/);
  assert.match(notificationText([at("Done.\nEVIDENCE: evidence-upload failed: keys missing")], undefined, works), /Evidence upload failed in this sandbox: evidence-upload failed: keys missing\./);
  // Where uploads can't work, don't send the orchestrator after them.
  const broken = () => "Installed evidence-upload, but missing CLOUDFLARE_ACCOUNT_ID in this sandbox's environment: uploads will fail";
  assert.match(notificationText([at("Took screenshots.")], undefined, broken), /evidence-upload doesn't work in this sandbox \(.*missing CLOUDFLARE_ACCOUNT_ID.*\); don't ask for an upload\./);
  // A sandbox without the uploader (older tasks, uploads off): no word about it.
  assert.doesNotMatch(notificationText([at("Took screenshots.")]), /evidence|upload/i);
});

test("an evidence-only follow-up asks for uploads and keeps the review and ready state", async () => {
  for (const chat of [false, true]) {
    const env = makeService({ chat, settings: { evidenceUploader: UPLOADER }, evidence: { script: async () => "x" } });
    env.boat.execResult = (script) =>
      script.includes("BOAT_EVIDENCE_EOF") ? { exitCode: 0, stdout: "BOAT_EVIDENCE node=v22.1.0 present=\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
    const { task } = await env.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
    if (chat) {
      await env.service.sweep();
      env.chat.finish(env.store.get(task.id)!.threadId!, `Done, screenshots in /tmp/shots.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===`);
      await env.service.sweep();
    } else {
      env.boat.finish(task.conversationId!, `Done, screenshots in /tmp/shots.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===`);
      await env.service.sweep();
    }
    env.service.markReady(task.id, "Check the header");
    const before = env.store.events(task.id, 200).length;
    const sent = await env.service.followup(task.id, "Upload the header screenshots.", { evidenceOnly: true });
    assert.equal(sent.status, "running", `chat=${chat}`);
    assert.equal(sent.readyNote, "Check the header");
    assert.notEqual(sent.readyAt, null);
    const prompt = chat ? env.chat.sends.at(-1)!.text : env.boat.prompts.at(-1)!.text;
    assert.match(prompt, /^# Upload your evidence\n\nUpload the header screenshots\./);
    assert.match(prompt, /Don't change, commit or push anything for this\./);
    assert.match(prompt, /EVIDENCE: /);
    assert.doesNotMatch(prompt, /Push the new commits|Re-review/);
    const added = env.store.events(task.id, 200).slice(before);
    assert.ok(added.some((event) => event.kind === "followup" && event.text === "(evidence only) Upload the header screenshots."));
    assert.ok(!added.some((event) => /Changed since/.test(event.text)));
    // Not while a turn runs.
    await assert.rejects(env.service.followup(task.id, "x", { evidenceOnly: true }), (error: unknown) => error instanceof TaskError && error.code === "task_running");
  }
  // A sandbox without the uploader can't be asked.
  const plain = makeService();
  const { task } = await plain.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  plain.boat.finish(task.conversationId!, "Done.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===");
  await plain.service.sweep();
  await assert.rejects(plain.service.followup(task.id, "Upload.", { evidenceOnly: true }), (error: unknown) => error instanceof TaskError && error.code === "evidence_unavailable");
  // It keeps the agent, model and tier.
  await assert.rejects(plain.service.followup(task.id, "Upload.", { evidenceOnly: true, tier: "deep" }), (error: unknown) => error instanceof TaskError && error.code === "invalid_value");
});

test("every turn's links stay listed after later turns", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const { task } = await env.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  const report = "\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===";
  env.boat.finish(task.conversationId!, `First.\n- [a.png](${LINK})${report}`);
  await env.service.sweep();
  await env.service.followup(task.id, "Again.");
  env.boat.finish(task.conversationId!, `Second.\n- [b.png](${LINK}&b=1)${report}`);
  await env.service.sweep();
  assert.deepEqual(env.service.evidenceLinks(task.id), [LINK, `${LINK}&b=1`]);
  const detail = taskDetail(env.store.get(task.id)!, env.store.events(task.id), { evidence: env.service.evidenceLinks(task.id) });
  assert.match(detail, /Evidence uploaded by its turns[^\n]*\n- https:[^\n]*header\.png[^\n]*\n- https:[^\n]*&b=1/);
  // The raw link events stay out of the history list.
  assert.doesNotMatch(detail, /evidence-links:/);
});

test("every task sandbox gets the uploader; a failed install doesn't stop the task", async () => {
  const uploader = "console.log('evidence')\n";
  const env = makeService({
    settings: { evidenceUploader: UPLOADER },
    evidence: { script: async () => uploader },
  });
  env.boat.limitsValue.maxActiveSandboxes = 10;
  env.boat.execResult = (script) =>
    script.includes("BOAT_EVIDENCE_EOF") ? { exitCode: 0, stdout: "BOAT_EVIDENCE node=v22.11.0 present=\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
  const { task } = await env.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  const install = env.boat.execs.find((entry) => entry.script.includes("BOAT_EVIDENCE_EOF"));
  assert.equal(install?.sandboxId, task.sandboxId);
  assert.ok(install!.script.includes(Buffer.from(uploader).toString("base64")));
  assert.ok(
    env.store.events(task.id, 50).some((event) => event.kind === "evidence" && event.text === "Installed evidence-upload from acme/tools:scripts/evidence-upload.mjs (its settings aren't checked)"),
  );
  // A custom script's sandbox isn't checked for any variable names.
  assert.doesNotMatch(install!.script, /for NAME in [A-Z]/);
  assert.ok(env.boat.prompts.at(-1)!.text.includes(EVIDENCE_NOTE));

  // GitHub unreachable: the task still runs, and the history says why uploads may fail.
  const broken = makeService({
    settings: { evidenceUploader: UPLOADER },
    evidence: {
      script: async () => {
        throw new Error("gh: HTTP 502");
      },
    },
  });
  const started = await broken.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  assert.equal(started.task.status, "running");
  assert.ok(broken.store.events(started.task.id, 50).some((event) => event.kind === "evidence" && /Couldn't install evidence-upload: gh: HTTP 502/.test(event.text)));
  // The brief still asks (the worker reports that uploads failed).
  assert.ok(broken.boat.prompts.at(-1)!.text.includes(EVIDENCE_NOTE));

  // Off: no install, no note.
  const off = makeService({ evidence: { script: async () => uploader } });
  await off.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  assert.equal(off.boat.execs.some((entry) => entry.script.includes("BOAT_EVIDENCE_EOF")), false);
  assert.doesNotMatch(off.boat.prompts.at(-1)!.text, /evidence-upload/);
});

test("the test task gets no uploader: it makes no screenshots, and a failed install would read like a setup problem", async () => {
  let fetched = 0;
  const env = makeService({
    settings: { evidenceUploader: UPLOADER },
    evidence: {
      script: async () => {
        fetched += 1;
        return "console.log('evidence')\n";
      },
    },
  });
  const { task } = await env.service.launchTask(testTaskInput(null), 5_000);
  assert.equal(task.status, "running");
  assert.equal(fetched, 0);
  assert.equal(env.boat.execs.some((entry) => entry.script.includes("BOAT_EVIDENCE_EOF")), false);
  assert.ok(!env.store.events(task.id, 50).some((event) => event.kind === "evidence"));
  assert.doesNotMatch(env.boat.prompts.at(-1)!.text, /evidence-upload/);
  // Other tasks still get it.
  await env.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  assert.equal(fetched, 1);
});

test("with the built-in uploader, the sandbox gets the bundled file and its variables are checked by name", async () => {
  const env = makeService({ settings: { evidenceUploader: "builtin" }, evidence: createEvidenceSource(async () => {
    throw new Error("builtin never reads GitHub");
  }) });
  env.boat.execResult = (script) =>
    script.includes("BOAT_EVIDENCE_EOF")
      ? { exitCode: 0, stdout: "BOAT_EVIDENCE node=v22.11.0 present=EVIDENCE_BUCKET EVIDENCE_ACCESS_KEY_ID EVIDENCE_SECRET_ACCESS_KEY CLOUDFLARE_ACCOUNT_ID\n", stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
  const { task } = await env.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  const install = env.boat.execs.find((entry) => entry.script.includes("BOAT_EVIDENCE_EOF"))!;
  assert.ok(install.script.includes(Buffer.from(readBundledUploader()).toString("base64").slice(0, 76)));
  assert.match(install.script, /for NAME in EVIDENCE_BUCKET EVIDENCE_ACCESS_KEY_ID EVIDENCE_SECRET_ACCESS_KEY EVIDENCE_R2_ACCESS_KEY_ID /);
  assert.ok(
    env.store
      .events(task.id, 50)
      .some((event) => event.kind === "evidence" && event.text === "Installed evidence-upload (keys present: EVIDENCE_BUCKET, EVIDENCE_ACCESS_KEY_ID, EVIDENCE_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID)"),
  );
  assert.ok(env.boat.prompts.at(-1)!.text.includes(EVIDENCE_NOTE));
});

test("chats opened in a worker's workspace hear about evidence-upload too", async () => {
  const env = makeService({ chat: true, settings: { evidenceUploader: UPLOADER }, evidence: { script: async () => "x" } });
  const { task } = await env.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  await env.service.sweep();
  const environmentId = env.store.get(task.id)!.environmentId!;
  assert.match(env.service.workspaceInstructions(environmentId, "thr_other")!, /evidence-upload <files or folders> --name <short label>/);
  // Without the uploader, not a word about it.
  const off = makeService({ chat: true });
  const plain = await off.service.launchTask({ title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  await off.service.sweep();
  assert.doesNotMatch(off.service.workspaceInstructions(off.store.get(plain.task.id)!.environmentId!, "thr_other")!, /evidence-upload/);
});
