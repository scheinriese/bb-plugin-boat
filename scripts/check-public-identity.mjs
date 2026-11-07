// Never print identity values: even an error must not expose a private address.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
const candidate = process.argv[2] ?? event.pull_request?.base?.sha ?? event.before;
const base = typeof candidate === "string" && /^[0-9a-f]{40}$/i.test(candidate) && !/^0+$/.test(candidate) ? candidate : null;
const range = base ? `${base}..HEAD` : "HEAD";
const text = execFileSync("git", ["log", range, "--format=%H%x00%an%x00%ae%x00%cn%x00%ce"], { encoding: "utf8" });
const failures = [];
let checked = 0;
for (const line of text.trim().split("\n").filter(Boolean)) {
  const [sha, an, ae, cn, ce] = line.split("\0");
  checked++;
  for (const [role, name, email] of [["author", an, ae], ["committer", cn, ce]]) {
    if (name.includes("@")) failures.push(`${sha.slice(0, 7)}: ${role} name contains an address`);
    if (name === "scheinriese" && email !== "6771752+scheinriese@users.noreply.github.com") failures.push(`${sha.slice(0, 7)}: owner ${role} must use the public noreply identity`);
  }
}
if (failures.length) { process.stderr.write(failures.join("\n") + "\n"); process.exit(1); }
console.log(`Public identity checks passed for ${checked} commits.`);
