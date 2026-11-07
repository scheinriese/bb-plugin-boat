import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPullRequest, mergePullRequest, pullRequestNumber } from "../src/github.ts";

test("PR URL identity cannot select another repository, host, protocol or command", () => {
  assert.equal(pullRequestNumber("demo/storefront", "https://github.com/demo/storefront/pull/482"), 482);
  for (const url of ["https://github.com/other/storefront/pull/482", "https://example.com/demo/storefront/pull/482", "http://github.com/demo/storefront/pull/482", "https://github.com/demo/storefront/pull/482?x=1", "https://github.com/demo/storefront/pull/482#x", "https://github.com/demo/storefront/pull/0", "https://github.com/demo/storefront/pull/--admin"]) assert.throws(() => pullRequestNumber("demo/storefront", url));
});
test("fake gh proves bounded facts and atomic merge HEAD args without any GitHub action", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "boat-gh-merge-")); const fake = join(dir, "fake-gh");
  const before = process.env.BOAT_PLUGIN_GH;
  const log = join(dir, "args.jsonl"); const response = join(dir, "response.json");
  writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='api')process.stdout.write(fs.readFileSync(${JSON.stringify(response)}));`, { mode: 0o700 });
  process.env.BOAT_PLUGIN_GH = fake;
  t.after(() => { if (before === undefined) delete process.env.BOAT_PLUGIN_GH; else process.env.BOAT_PLUGIN_GH = before; rmSync(dir, { recursive: true, force: true }); });
  const pr = { number: 482, url: "https://github.com/demo/storefront/pull/482", title: "Cart drawer", headRefOid: "1".repeat(40), baseRefOid: "2".repeat(40), headRefName: "boat/cart", baseRefName: "main", additions: 214, deletions: 61, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", commits: { totalCount: 6, nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", name: "Tests", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null },
    { __typename: "StatusContext", context: "Build", state: "PENDING", targetUrl: "https://github.com/demo/storefront/actions" },
  ] } } } }] } };
  writeFileSync(response, JSON.stringify({ data: { repository: { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false, pullRequest: pr } } }));
  const facts = await getPullRequest("demo/storefront", pr.url);
  assert.equal(facts.commits, 6); assert.equal(facts.additions, 214); assert.equal(facts.deletions, 61); assert.equal(facts.mergeMethod, "squash");
  assert.deepEqual(facts.checks.map((check) => check.state), ["SUCCESS", "PENDING"]);
  // The action wrapper only receives already approved facts; the controller checks readiness.
  await mergePullRequest({ ...facts, checks: [] });
  const args = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(args[1], ["pr", "merge", "482", "--repo", "demo/storefront", "--squash", "--match-head-commit", "1".repeat(40)]);
  assert.ok(!args[1].includes("--admin")); assert.ok(!args[1].includes("--delete-branch"));
  writeFileSync(response, JSON.stringify({ errors: [{ message: "private detail" }] }));
  await assert.rejects(() => getPullRequest("demo/storefront", pr.url), /couldn't read/);
});
