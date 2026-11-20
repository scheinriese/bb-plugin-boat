import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const available = spawnSync("gitleaks", ["version"]).status === 0;
const required = process.env.CI !== undefined || process.env.REQUIRE_GITLEAKS !== undefined;
const body = (length: number) => randomBytes(length).toString("hex").slice(0, length);

test("gitleaks provider rules and inherited GitHub rules", { skip: !available && !required }, () => {
  assert.ok(available, "gitleaks must be installed when CI or REQUIRE_GITLEAKS is set");
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
  try {
    const scan = (value: string): string[] => {
      writeFileSync(join(dir, "input.txt"), value);
      const report = join(dir, "report.json");
      const result = spawnSync("gitleaks", ["dir", dir, "--config", resolve(".gitleaks.toml"),
        "--report-format", "json", "--report-path", report, "--redact", "--no-banner"], { encoding: "utf8" });
      assert.ok(result.status === 0 || result.status === 1, "gitleaks must complete successfully");
      const findings = JSON.parse(readFileSync(report, "utf8")) as { RuleID: string }[];
      rmSync(report);
      return findings.map((finding) => finding.RuleID).sort();
    };
    for (const prefix of ["ibk_", "ibp_", "ibkv_", "ibpv_"]) {
      assert.deepEqual(scan(prefix + body(32)), ["instabox-key"]);
    }
    assert.deepEqual(scan("ibk_" + body(16) + "test" + body(16)), ["instabox-key"]);
    assert.deepEqual(scan("ibp_" + body(16) + "latest"), ["instabox-key"]);
    const access = "SCW" + body(17).toUpperCase();
    assert.deepEqual(scan(access), ["scaleway-access-key"]);
    for (const context of ["SCW_SECRET_KEY=", "scaleway: ", "secret_key: "]) {
      assert.deepEqual(scan(context + randomUUID()), ["scaleway-secret-key"]);
    }
    assert.deepEqual(scan(access + "\n" + randomUUID()), ["scaleway-access-key", "scaleway-secret-key"]);
    assert.deepEqual(scan(randomUUID()), []);
    assert.deepEqual(scan("scalewayProjectId: " + randomUUID()), []);
    assert.deepEqual(scan("scaleway " + ".".repeat(81) + randomUUID()), []);
    assert.deepEqual(scan("ibk_short ibp_fake_example_key ibk_test_example_key ibp_example_key"), []);
    for (const [prefix, rule] of [["ghp_", "github-pat"], ["gho_", "github-oauth"],
      ["ghu_", "github-app-token"], ["ghs_", "github-app-token"], ["ghr_", "github-refresh-token"],
      ["github_pat_", "github-fine-grained-pat"]]) {
      assert.ok(scan(prefix + body(prefix === "github_pat_" ? 82 : 36)).includes(rule), `missing ${rule}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
