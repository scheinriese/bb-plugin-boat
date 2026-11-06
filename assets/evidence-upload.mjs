#!/usr/bin/env node
// evidence-upload: keep screenshots and recordings after a sandbox is gone.
//
// Uploads files or folders to an S3-compatible bucket (Cloudflare R2, AWS S3,
// MinIO, ...) and prints a presigned link for each file. One file, no
// dependencies, Node 20+. It ships with the Boat bb plugin as the "builtin"
// evidence uploader; every task sandbox gets it as `evidence-upload`.
//
// Configuration comes from environment variables (see --help). Key values
// are never printed.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const HELP = `evidence-upload: upload screenshots and recordings, print a link for each file

Usage:
  evidence-upload <files or folders>... [--name <label>] [--repo <name>] [--branch <name>] [--days <1-7>] [--json]
  evidence-upload --link <key> [--days <1-7>]
  evidence-upload --check
  evidence-upload --help

Uploads go to <date>/<repo>/<branch>/<time>-<id>-<label>/<file>. The repo and
branch come from the git checkout you run it in (--repo and --branch override
them). Folders keep their layout. Each link is a presigned link: anyone with
it can open that file until it expires (7 days at most). --link <key> prints a
fresh link for a file already uploaded (it doesn't check that the file exists).
--check says whether the configuration is complete, without uploading.

Configuration (environment variables; values are never printed):
  EVIDENCE_BUCKET              Bucket name (required)
  EVIDENCE_ACCESS_KEY_ID       Access key with write access to the bucket (required)
  EVIDENCE_SECRET_ACCESS_KEY   Its secret (required)
                               EVIDENCE_R2_ACCESS_KEY_ID / EVIDENCE_R2_SECRET_ACCESS_KEY or
                               AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY work too
  EVIDENCE_ENDPOINT            S3 endpoint URL, like https://minio.example.com
  CLOUDFLARE_ACCOUNT_ID        Without EVIDENCE_ENDPOINT: Cloudflare R2 at
                               https://<account id>.r2.cloudflarestorage.com
                               (without either: AWS S3, https://s3.<region>.amazonaws.com)
  EVIDENCE_REGION              Default: auto for R2, else us-east-1
  EVIDENCE_LINK_DAYS           How long links work, 1 to 7 days (default 7)
`;

/** Key pairs in the order they're looked for; the first pair with either name set is used. */
export const KEY_PAIRS = [
  ["EVIDENCE_ACCESS_KEY_ID", "EVIDENCE_SECRET_ACCESS_KEY"],
  ["EVIDENCE_R2_ACCESS_KEY_ID", "EVIDENCE_R2_SECRET_ACCESS_KEY"],
  ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
];
/** SigV4 links last at most 7 days. */
export const MAX_LINK_DAYS = 7;
/** One PUT carries at most 5 GB on AWS S3 and R2. */
const MAX_FILE_BYTES = 5_000_000_000;
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);
const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";

const TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

export function contentType(path) {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// ------------------------------------------------------------- configuration

/** A configuration problem: names variables, never their values. */
export class ConfigError extends Error {}

/**
 * Read the configuration from `env`. Throws a ConfigError that lists every
 * missing or invalid variable by name.
 */
export function readConfig(env = process.env) {
  const value = (name) => {
    const raw = env[name];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  };
  const missing = [];
  const invalid = [];

  const bucket = value("EVIDENCE_BUCKET");
  if (bucket === null) missing.push("EVIDENCE_BUCKET");
  else if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) invalid.push("EVIDENCE_BUCKET isn't a bucket name (lowercase letters, digits, dots and dashes)");

  const pair = KEY_PAIRS.find(([id, secret]) => value(id) !== null || value(secret) !== null) ?? KEY_PAIRS[0];
  const accessKeyId = value(pair[0]);
  const secretAccessKey = value(pair[1]);
  if (accessKeyId === null) missing.push(pair[0]);
  else if (/[\s/]/.test(accessKeyId)) invalid.push(`${pair[0]} has a space or a slash in it`);
  if (secretAccessKey === null) missing.push(pair[1]);

  const endpointText = value("EVIDENCE_ENDPOINT");
  const accountId = value("CLOUDFLARE_ACCOUNT_ID");
  let endpoint = null;
  let endpointFrom = null;
  if (endpointText !== null) {
    endpointFrom = "EVIDENCE_ENDPOINT";
    let url = null;
    try {
      url = new URL(endpointText);
    } catch {
      // Reported below.
    }
    if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || url.search !== "" || url.hash !== "" || url.username !== "") {
      invalid.push("EVIDENCE_ENDPOINT isn't an http(s) URL like https://s3.example.com");
    } else {
      endpoint = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }
  } else if (accountId !== null) {
    endpointFrom = "CLOUDFLARE_ACCOUNT_ID";
    if (!/^[a-f0-9]{32}$/i.test(accountId)) invalid.push("CLOUDFLARE_ACCOUNT_ID isn't a Cloudflare account id (32 hex characters)");
    else endpoint = `https://${accountId.toLowerCase()}.r2.cloudflarestorage.com`;
  }
  const r2 = endpointFrom === "CLOUDFLARE_ACCOUNT_ID" || (endpoint !== null && /\.r2\.cloudflarestorage\.com$/i.test(new URL(endpoint).hostname));

  const region = value("EVIDENCE_REGION") ?? (r2 ? "auto" : "us-east-1");
  if (!/^[a-z0-9-]{1,40}$/i.test(region)) invalid.push("EVIDENCE_REGION isn't a region name like us-east-1");
  else if (endpointFrom === null) endpoint = `https://s3.${region}.amazonaws.com`;

  const daysText = value("EVIDENCE_LINK_DAYS");
  const linkDays = daysText === null ? MAX_LINK_DAYS : Number(daysText);
  if (!isLinkDays(linkDays)) invalid.push(`EVIDENCE_LINK_DAYS must be a number from 1 to ${MAX_LINK_DAYS}`);

  if (missing.length > 0 || invalid.length > 0) {
    const problems = [...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []), ...invalid];
    throw new ConfigError(
      `${problems.join("; ")}. Set these variables in the sandbox's environment (in boat: the environment's variables); --help lists every setting.`,
    );
  }
  return {
    bucket,
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    region,
    linkDays,
    // Names only, for --check.
    names: { keys: pair, endpoint: endpointFrom },
  };
}

function isLinkDays(days) {
  return Number.isFinite(days) && days >= 1 && days <= MAX_LINK_DAYS;
}

// ----------------------------------------------------- AWS Signature Version 4

/** RFC 3986 encoding, as SigV4 wants it; object keys keep their slashes. */
export function encode(text, keepSlash = false) {
  const encoded = encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replaceAll("%2F", "/") : encoded;
}

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** "20130524T000000Z" and "20130524". */
export function amzDates(now) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signature(secretAccessKey, dateStamp, region, stringToSign) {
  let key = hmac(`AWS4${secretAccessKey}`, dateStamp);
  for (const part of [region, SERVICE, "aws4_request"]) key = hmac(key, part);
  return createHmac("sha256", key).update(stringToSign).digest("hex");
}

/** The path, each segment encoded once (S3 doesn't normalize it). */
function canonicalPath(url) {
  return url.pathname
    .split("/")
    .map((segment) => {
      try {
        return encode(decodeURIComponent(segment));
      } catch {
        return segment;
      }
    })
    .join("/");
}

/** Sorted, RFC 3986-encoded query string. */
export function canonicalQuery(entries) {
  return entries
    .map(([key, value]) => [encode(key), encode(String(value))])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/**
 * Sign a request with an Authorization header. Returns every header to send
 * (host, x-amz-date and x-amz-content-sha256 included).
 */
export function signRequest({ method, url, region, credentials, headers = {}, payloadHash, now = new Date() }) {
  const { amzDate, dateStamp } = amzDates(now);
  const all = {};
  for (const [name, value] of Object.entries(headers)) all[name.toLowerCase()] = String(value).trim().replace(/\s+/g, " ");
  all.host = url.host;
  all["x-amz-content-sha256"] = payloadHash;
  all["x-amz-date"] = amzDate;
  const names = Object.keys(all).sort();
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const canonical = [
    method,
    canonicalPath(url),
    canonicalQuery([...url.searchParams]),
    names.map((name) => `${name}:${all[name]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const toSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join("\n");
  all.authorization = `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature(credentials.secretAccessKey, dateStamp, region, toSign)}`;
  return all;
}

/** A presigned GET link for `url` (no query of its own), valid for `seconds`. */
export function presignGet({ url, region, credentials, seconds, now = new Date() }) {
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const query = canonicalQuery([
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(seconds)],
    ["X-Amz-SignedHeaders", "host"],
  ]);
  const path = canonicalPath(url);
  const canonical = ["GET", path, query, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join("\n");
  return `${url.origin}${path}?${query}&X-Amz-Signature=${signature(credentials.secretAccessKey, dateStamp, region, toSign)}`;
}

/** Path-style object URL: works on R2, MinIO and AWS S3 alike. */
export function objectUrl(config, key) {
  return new URL(`${config.endpoint}/${encode(config.bucket)}/${encode(key, true)}`);
}

export function link(config, key, days = config.linkDays, now = new Date()) {
  return presignGet({
    url: objectUrl(config, key),
    region: config.region,
    credentials: config.credentials,
    seconds: Math.round(days * 86_400),
    now,
  });
}

// ------------------------------------------------------------------- uploads

function send(method, url, headers, body) {
  const request = url.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolvePromise, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(120_000, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body) body.on("error", (error) => req.destroy(error)).pipe(req);
    else req.end();
  });
}

async function sha256OfFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** PUT one file, retrying server errors. Errors name the HTTP status and S3 error code only. */
async function putFile(config, file) {
  const url = objectUrl(config, file.key);
  const payloadHash = await sha256OfFile(file.path);
  let detail = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const headers = signRequest({
        method: "PUT",
        url,
        region: config.region,
        credentials: config.credentials,
        headers: { "content-length": file.size, "content-type": contentType(file.path) },
        payloadHash,
      });
      const res = await send("PUT", url, headers, createReadStream(file.path));
      if (res.status >= 200 && res.status < 300) return;
      const code = res.body.match(/<Code>([A-Za-z0-9.]{1,64})<\/Code>/)?.[1];
      detail = ` (HTTP ${res.status}${code ? ` ${code}` : ""})`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (error) {
      detail = ` (${error instanceof Error ? error.message : String(error)})`;
    }
    await new Promise((done) => setTimeout(done, 500 * attempt));
  }
  throw new Error(`Uploading ${file.key} failed${detail}.`);
}

/** Upload every file (4 at a time); one failure never hides the others' links. */
export async function upload(config, files, { concurrency = 4, now = new Date() } = {}) {
  const uploaded = new Array(files.length);
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      try {
        await putFile(config, file);
        uploaded[index] = { ...file, url: link(config, file.key, config.linkDays, now) };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return { uploaded: uploaded.filter(Boolean), failures };
}

// ------------------------------------------------------------ names and files

/** Safe for an object key: letters, digits, dot, dash and underscore. */
export function slug(text, fallback) {
  const cleaned = String(text ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

/** `<day>/<repo>/<branch>/<time>-<id>[-<label>]/`, in UTC, so uploads sort by day. */
export function uploadPrefix({ now = new Date(), repo, branch, name, id = randomBytes(2).toString("hex") }) {
  const iso = now.toISOString();
  const label = name ? `-${slug(name, "upload")}` : "";
  return `${iso.slice(0, 10)}/${slug(repo, "no-repo")}/${slug(branch, "no-branch")}/${iso.slice(11, 19).replaceAll(":", "")}-${slug(id, "x")}${label}/`;
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** "web" from git@github.com:acme/web.git, else the checkout's folder name. */
export function repoName(originUrl, topLevel) {
  const fromOrigin = originUrl?.replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "");
  return fromOrigin || (topLevel ? basename(topLevel) : null);
}

function currentBranch() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "HEAD" ? git(["rev-parse", "--short", "HEAD"]) : branch;
}

/** Files and folders as { path, key, size }; folders keep their layout under their own name. */
export async function collectFiles(inputs, prefix) {
  const files = [];
  const seen = new Set();
  const add = (path, keyPart, size) => {
    const key = prefix + keyPart.split(sep).map((part) => slug(part, "file")).join("/");
    if (seen.has(key)) throw new Error(`Two files would get the same name: ${keyPart}`);
    seen.add(key);
    files.push({ path, key, size });
  };
  async function walk(root, dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(root, path);
      else if (entry.isFile()) add(path, join(basename(root), relative(root, path)), (await stat(path)).size);
    }
  }
  for (const input of inputs) {
    const path = resolve(input);
    const info = await stat(path).catch(() => null);
    if (info === null) throw new Error(`Not found: ${input}`);
    if (info.isDirectory()) await walk(path, path);
    else if (info.isFile()) add(path, basename(path), info.size);
    else throw new Error(`Not a file or folder: ${input}`);
  }
  if (files.length === 0) throw new Error("Nothing to upload: the folders are empty.");
  const tooBig = files.find((file) => file.size > MAX_FILE_BYTES);
  if (tooBig) throw new Error(`${relative(process.cwd(), tooBig.path)} is over 5 GB; compress or split it first.`);
  return files;
}

function size(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** The list workers paste into their report. */
export function markdown(results, days, now = new Date()) {
  const until = new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 16).replace("T", " ");
  return [
    `Uploaded ${results.length} ${results.length === 1 ? "file" : "files"}. Links work for ${days} ${days === 1 ? "day" : "days"} (until ${until} UTC); \`evidence-upload --link <key>\` makes a fresh one.`,
    "",
    ...results.map((r) => `- [${r.key.split("/").pop()}](${r.url}) (${size(r.size)}), key \`${r.key}\``),
  ].join("\n");
}

// ----------------------------------------------------------------------- CLI

function linkDaysOption(text, fallback) {
  if (text === undefined) return fallback;
  const days = Number(text);
  if (!isLinkDays(days)) throw new Error(`--days must be a number from 1 to ${MAX_LINK_DAYS}.`);
  return days;
}

export async function main(argv = process.argv.slice(2), { env = process.env, now = new Date(), id, out = console.log } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      repo: { type: "string" },
      branch: { type: "string" },
      days: { type: "string" },
      link: { type: "string" },
      json: { type: "boolean" },
      check: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return out(HELP.trimEnd());
  const config = readConfig(env);
  if (values.check) {
    const [idName, secretName] = config.names.keys;
    const endpoint = config.names.endpoint === null ? "AWS S3" : config.names.endpoint === "CLOUDFLARE_ACCOUNT_ID" ? "Cloudflare R2 (CLOUDFLARE_ACCOUNT_ID)" : "EVIDENCE_ENDPOINT";
    return out(`evidence-upload is ready: bucket from EVIDENCE_BUCKET, keys from ${idName} and ${secretName}, endpoint ${endpoint}, region ${config.region}, links last ${config.linkDays} ${config.linkDays === 1 ? "day" : "days"}.`);
  }
  const days = linkDaysOption(values.days, config.linkDays);
  if (values.link !== undefined) {
    const key = values.link.trim().replace(/^\/+/, "");
    if (key === "") throw new Error("--link needs the key of an uploaded file (the upload list shows it).");
    return out(link(config, key, days, now));
  }
  if (positionals.length === 0) throw new Error("Name the screenshots, recordings or folders to upload (evidence-upload --help).");
  const prefix = uploadPrefix({
    now,
    repo: values.repo ?? repoName(git(["remote", "get-url", "origin"]), git(["rev-parse", "--show-toplevel"])),
    branch: values.branch ?? currentBranch(),
    name: values.name,
    ...(id ? { id } : {}),
  });
  const files = await collectFiles(positionals, prefix);
  const { uploaded, failures } = await upload({ ...config, linkDays: days }, files, { now });
  if (uploaded.length > 0) {
    out(
      values.json
        ? JSON.stringify(
            uploaded.map(({ key, size: bytes, url }) => ({ key, size: bytes, url, expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString() })),
            null,
            2,
          )
        : markdown(uploaded, days, now),
    );
  }
  if (failures.length > 0) throw new Error(`${failures.length} of ${files.length} files failed:\n${failures.join("\n")}`);
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`evidence-upload: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
