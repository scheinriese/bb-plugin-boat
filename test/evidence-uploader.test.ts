// The bundled uploader (assets/evidence-upload.mjs): AWS Signature V4
// against AWS's documented examples, its configuration, and real uploads to
// a local S3-style server that checks every signature itself.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { evidenceLinks } from "../src/evidence.ts";

const UPLOADER = fileURLToPath(new URL("../assets/evidence-upload.mjs", import.meta.url));

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}
interface Config {
  bucket: string;
  credentials: Credentials;
  endpoint: string;
  region: string;
  linkDays: number;
  names: { keys: [string, string]; endpoint: string | null };
}
interface Uploader {
  signRequest(input: { method: string; url: URL; region: string; credentials: Credentials; headers?: Record<string, string>; payloadHash: string; now?: Date }): Record<string, string>;
  presignGet(input: { url: URL; region: string; credentials: Credentials; seconds: number; now?: Date }): string;
  readConfig(env: Record<string, string>): Config;
  link(config: Config, key: string, days?: number, now?: Date): string;
  uploadPrefix(input: { now?: Date; repo?: string | null; branch?: string | null; name?: string; id?: string }): string;
  repoName(origin: string | null, topLevel: string | null): string | null;
  main(argv: string[], options: { env?: Record<string, string>; now?: Date; id?: string; out?: (text: string) => void }): Promise<void>;
}
// A plain .mjs file: loaded by path, typed here.
const uploader = (await import(new URL("../assets/evidence-upload.mjs", import.meta.url).href)) as Uploader;

// AWS's published SigV4 examples (S3 API reference, "Signature Calculations"):
// a documentation-only key pair, 2013-05-24, us-east-1, examplebucket.
// (Assembled from parts, so secret scanners don't flag the documentation key.)
const EXAMPLE: Credentials = { accessKeyId: "AKIA" + "IOSFODNN7EXAMPLE", secretAccessKey: ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/") };
const EXAMPLE_DATE = new Date("2013-05-24T00:00:00Z");
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("SigV4: AWS's GET Object example (Authorization header)", () => {
  const headers = uploader.signRequest({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    credentials: EXAMPLE,
    headers: { Range: "bytes=0-9" },
    payloadHash: EMPTY_SHA256,
    now: EXAMPLE_DATE,
  });
  assert.equal(
    headers.authorization,
    `AWS4-HMAC-SHA256 Credential=${EXAMPLE.accessKeyId}/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
  );
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
  assert.equal(headers.host, "examplebucket.s3.amazonaws.com");
});

test("SigV4: AWS's PUT Object example (a $ in the key, extra signed headers)", () => {
  const body = "Welcome to Amazon S3.";
  const headers = uploader.signRequest({
    method: "PUT",
    url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
    region: "us-east-1",
    credentials: EXAMPLE,
    headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    payloadHash: createHash("sha256").update(body).digest("hex"),
    now: EXAMPLE_DATE,
  });
  assert.equal(headers["x-amz-content-sha256"], "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  assert.match(headers.authorization!, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

test("SigV4: AWS's presigned URL example (query string authentication)", () => {
  const url = uploader.presignGet({
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    credentials: EXAMPLE,
    seconds: 86_400,
    now: EXAMPLE_DATE,
  });
  // Character for character the documented URL: parameter order, encoding, signature last.
  assert.equal(
    url,
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      `&X-Amz-Credential=${EXAMPLE.accessKeyId}%2F20130524%2Fus-east-1%2Fs3%2Faws4_request` +
      "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("links: path-style on the bucket's endpoint, 7 days by default, deterministic for a fixed clock", () => {
  const config = uploader.readConfig({
    EVIDENCE_BUCKET: "example-evidence",
    EVIDENCE_ACCESS_KEY_ID: "fake_key_id",
    EVIDENCE_SECRET_ACCESS_KEY: "fake_secret",
    CLOUDFLARE_ACCOUNT_ID: "0123456789ABCDEF0123456789abcdef",
  });
  assert.equal(config.endpoint, "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(config.region, "auto");
  const now = new Date("2026-11-06T12:00:00Z");
  const key = "2026-11-06/web/boat-t_1/120000-ab12-header/a b(1).png";
  const first = uploader.link(config, key, undefined, now);
  assert.equal(first, uploader.link(config, key, undefined, now));
  const url = new URL(first);
  // Spaces and parentheses are encoded, so the link survives Markdown.
  assert.equal(url.pathname, "/example-evidence/2026-11-06/web/boat-t_1/120000-ab12-header/a%20b%281%29.png");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "604800");
  assert.equal(url.searchParams.get("X-Amz-Credential"), "fake_key_id/20261106/auto/s3/aws4_request");
  assert.equal(url.searchParams.get("X-Amz-Date"), "20261106T120000Z");
  assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  assert.equal(new URL(uploader.link(config, key, 1, now)).searchParams.get("X-Amz-Expires"), "86400");
  // The plugin recognises the link in a report.
  assert.deepEqual(evidenceLinks(`- [a.png](${first})`), [first]);
});

test("configuration: endpoints, regions and key pairs", () => {
  const keys = { EVIDENCE_BUCKET: "example-evidence", EVIDENCE_ACCESS_KEY_ID: "fake_id", EVIDENCE_SECRET_ACCESS_KEY: "fake_secret" };
  // Neither endpoint variable: AWS S3 in the region.
  assert.equal(uploader.readConfig(keys).endpoint, "https://s3.us-east-1.amazonaws.com");
  assert.equal(uploader.readConfig(keys).region, "us-east-1");
  assert.equal(uploader.readConfig({ ...keys, EVIDENCE_REGION: "eu-central-1" }).endpoint, "https://s3.eu-central-1.amazonaws.com");
  // Any S3-compatible endpoint; it wins over the Cloudflare account.
  const minio = uploader.readConfig({ ...keys, EVIDENCE_ENDPOINT: "http://127.0.0.1:9000/", CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" });
  assert.equal(minio.endpoint, "http://127.0.0.1:9000");
  assert.equal(minio.region, "us-east-1");
  assert.equal(uploader.readConfig({ ...keys, EVIDENCE_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com" }).region, "auto");
  // Fallback key names, used as a pair.
  assert.deepEqual(uploader.readConfig({ EVIDENCE_BUCKET: "example-evidence", EVIDENCE_R2_ACCESS_KEY_ID: "fake_r2_id", EVIDENCE_R2_SECRET_ACCESS_KEY: "fake_r2_secret" }).credentials, {
    accessKeyId: "fake_r2_id",
    secretAccessKey: "fake_r2_secret",
  });
  assert.deepEqual(uploader.readConfig({ EVIDENCE_BUCKET: "example-evidence", AWS_ACCESS_KEY_ID: "fake_aws_id", AWS_SECRET_ACCESS_KEY: "fake_aws_secret" }).names.keys, [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]);
  assert.equal(uploader.readConfig({ ...keys, EVIDENCE_LINK_DAYS: "2" }).linkDays, 2);
});

test("configuration problems name the variables, never their values", () => {
  const secretish = "fake_value_do_not_print";
  const cases: [Record<string, string>, RegExp][] = [
    [{}, /^missing EVIDENCE_BUCKET, EVIDENCE_ACCESS_KEY_ID, EVIDENCE_SECRET_ACCESS_KEY\. /],
    [{ EVIDENCE_BUCKET: "example-evidence", EVIDENCE_R2_ACCESS_KEY_ID: secretish }, /^missing EVIDENCE_R2_SECRET_ACCESS_KEY\. /],
    [
      { EVIDENCE_BUCKET: "Not A Bucket", EVIDENCE_ACCESS_KEY_ID: secretish, EVIDENCE_SECRET_ACCESS_KEY: secretish, CLOUDFLARE_ACCOUNT_ID: secretish },
      /EVIDENCE_BUCKET isn't a bucket name.*; CLOUDFLARE_ACCOUNT_ID isn't a Cloudflare account id/,
    ],
    [{ EVIDENCE_BUCKET: "example-evidence", EVIDENCE_ACCESS_KEY_ID: secretish, EVIDENCE_SECRET_ACCESS_KEY: secretish, EVIDENCE_ENDPOINT: "ftp://x" }, /EVIDENCE_ENDPOINT isn't an http\(s\) URL/],
    [{ EVIDENCE_BUCKET: "example-evidence", EVIDENCE_ACCESS_KEY_ID: secretish, EVIDENCE_SECRET_ACCESS_KEY: secretish, EVIDENCE_LINK_DAYS: "30" }, /EVIDENCE_LINK_DAYS must be a number from 1 to 7/],
  ];
  for (const [env, expected] of cases) {
    assert.throws(
      () => uploader.readConfig(env),
      (error: Error) => {
        assert.match(error.message, expected);
        assert.ok(!error.message.includes(secretish), "no values in the message");
        assert.match(error.message, /Set these variables in the sandbox's environment/);
        return true;
      },
    );
  }
});

test("the command: --help, a missing setting exits non-zero naming it, --link prints one link", async () => {
  const run = promisify(execFile);
  const help = await run(process.execPath, [UPLOADER, "--help"], { env: {} });
  assert.match(help.stdout, /^evidence-upload: upload screenshots and recordings/);
  assert.match(help.stdout, /evidence-upload <files or folders>\.\.\. \[--name <label>\]/);
  assert.match(help.stdout, /evidence-upload --link <key>/);
  await assert.rejects(run(process.execPath, [UPLOADER, "shot.png"], { env: { EVIDENCE_BUCKET: "example-evidence", EVIDENCE_ACCESS_KEY_ID: "fake_value_id" } }), (error: { code: number; stderr: string; stdout: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /^evidence-upload: missing EVIDENCE_SECRET_ACCESS_KEY\./);
    assert.doesNotMatch(error.stderr + error.stdout, /fake_value_id/);
    return true;
  });
  const env = { EVIDENCE_BUCKET: "example-evidence", EVIDENCE_ACCESS_KEY_ID: "fake_id", EVIDENCE_SECRET_ACCESS_KEY: "fake_secret", CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" };
  const link = await run(process.execPath, [UPLOADER, "--link", "2026-11-06/web/main/120000-ab12/a.png", "--days", "3"], { env });
  const url = new URL(link.stdout.trim());
  assert.equal(url.pathname, "/example-evidence/2026-11-06/web/main/120000-ab12/a.png");
  assert.equal(url.searchParams.get("X-Amz-Expires"), String(3 * 86_400));
  assert.doesNotMatch(link.stdout, /fake_secret/);
  const check = await run(process.execPath, [UPLOADER, "--check"], { env });
  assert.match(check.stdout, /^evidence-upload is ready: bucket from EVIDENCE_BUCKET, keys from EVIDENCE_ACCESS_KEY_ID and EVIDENCE_SECRET_ACCESS_KEY, endpoint Cloudflare R2/);
  await assert.rejects(run(process.execPath, [UPLOADER, "--link", "k", "--days", "8"], { env }), /--days must be a number from 1 to 7/);
});

test("upload keys: day, repo, branch, time, id and label", () => {
  const now = new Date("2026-11-06T14:02:10Z");
  assert.equal(uploader.uploadPrefix({ now, repo: "web", branch: "boat/t_1 header", name: "Header shots!", id: "ab12" }), "2026-11-06/web/boat-t_1-header/140210-ab12-Header-shots/");
  assert.equal(uploader.uploadPrefix({ now, repo: null, branch: null, id: "ab12" }), "2026-11-06/no-repo/no-branch/140210-ab12/");
  assert.equal(uploader.repoName("git@github.com:acme/api.git", null), "api");
  assert.equal(uploader.repoName("https://github.com/acme/Web.git", null), "Web");
  assert.equal(uploader.repoName(null, "/home/user/work/docs"), "docs");
});

/** Check an S3 request's signature the way S3 does, independently of the uploader's code. */
function verifySignature(req: IncomingMessage, body: Buffer, secret: string): boolean {
  const auth = String(req.headers.authorization ?? "");
  const match = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
  if (!match) return false;
  const [, , date, region, signed, signature] = match;
  const payloadHash = createHash("sha256").update(body).digest("hex");
  if (req.headers["x-amz-content-sha256"] !== payloadHash) return false;
  const url = new URL(req.url ?? "/", "http://placeholder");
  const canonical = [
    req.method,
    url.pathname,
    "",
    signed!.split(";").map((name) => `${name}:${String(req.headers[name]).trim()}\n`).join(""),
    signed,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", req.headers["x-amz-date"], scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  let key: Buffer = createHmac("sha256", `AWS4${secret}`).update(date!).digest();
  for (const part of [region!, "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  return createHmac("sha256", key).update(toSign).digest("hex") === signature;
}

test("uploads files and folders to an S3-style server, signed, and prints a link per file", async (t) => {
  const stored = new Map<string, { body: Buffer; type: string }>();
  let refused = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.method !== "PUT" || !verifySignature(req, body, "fake_secret")) {
        refused += 1;
        res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
        return;
      }
      stored.set(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname), { body, type: String(req.headers["content-type"]) });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const dir = mkdtempSync(join(tmpdir(), "evidence-upload-"));
  writeFileSync(join(dir, "header.png"), "png bytes");
  mkdirSync(join(dir, "flow", "step 2"), { recursive: true });
  writeFileSync(join(dir, "flow", "1.webm"), "webm bytes");
  writeFileSync(join(dir, "flow", "step 2", "after.png"), "after bytes");
  mkdirSync(join(dir, "flow", "node_modules"));
  writeFileSync(join(dir, "flow", "node_modules", "skip.js"), "skipped");

  const lines: string[] = [];
  const now = new Date("2026-11-06T14:02:10Z");
  const env = { EVIDENCE_BUCKET: "example-evidence", EVIDENCE_ACCESS_KEY_ID: "fake_id", EVIDENCE_SECRET_ACCESS_KEY: "fake_secret", EVIDENCE_ENDPOINT: `http://127.0.0.1:${port}` };
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await uploader.main(["header.png", "flow", "--name", "header", "--repo", "web", "--branch", "boat/t_1"], { env, now, id: "ab12", out: (text) => lines.push(text) });
  } finally {
    process.chdir(cwd);
  }
  assert.equal(refused, 0);
  const prefix = "/example-evidence/2026-11-06/web/boat-t_1/140210-ab12-header";
  assert.deepEqual([...stored.keys()].sort(), [`${prefix}/flow/1.webm`, `${prefix}/flow/step-2/after.png`, `${prefix}/header.png`]);
  assert.equal(stored.get(`${prefix}/header.png`)?.body.toString(), "png bytes");
  assert.equal(stored.get(`${prefix}/header.png`)?.type, "image/png");
  assert.equal(stored.get(`${prefix}/flow/1.webm`)?.type, "video/webm");

  const output = lines.join("\n");
  assert.match(output, /^Uploaded 3 files\. Links work for 7 days \(until 2026-11-13 14:02 UTC\); `evidence-upload --link <key>` makes a fresh one\./);
  assert.match(output, /- \[header\.png\]\(http:\/\/127\.0\.0\.1:\d+\/example-evidence\/2026-11-06\/web\/boat-t_1\/140210-ab12-header\/header\.png\?X-Amz-Algorithm=AWS4-HMAC-SHA256&[^)]*X-Amz-Signature=[0-9a-f]{64}\) \(1 KB\), key `2026-11-06\/web\/boat-t_1\/140210-ab12-header\/header\.png`/);
  assert.equal(output.match(/^- \[/gm)?.length, 3);
  assert.doesNotMatch(output, /fake_secret/);

  // A refused upload fails the command, with the status and S3's error code only.
  await assert.rejects(
    uploader.main([join(dir, "header.png")], { env: { ...env, EVIDENCE_SECRET_ACCESS_KEY: "fake_wrong_secret" }, now, out: () => undefined }),
    /1 of 1 files failed:\nUploading .*header\.png failed \(HTTP 403 SignatureDoesNotMatch\)\./,
  );
});
