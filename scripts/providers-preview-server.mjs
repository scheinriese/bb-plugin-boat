// Component preview only: no provider calls or credentials. Build the plugin first.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
const temporary = mkdtempSync(join(process.cwd(), ".provider-preview-"));
const outfile = join(temporary, "render.mjs");
await build({
  entryPoints: ["scripts/providers-preview.tsx"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
});
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const port = Number(arg("--port", "4173")),
  host = arg("--host", "0.0.0.0");
const cache = new Map();
const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://preview.invalid");
    if (url.pathname === "/app.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(readFileSync("dist/app.css"));
      return;
    }
    if (url.pathname !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    const scene = url.searchParams.get("scene") ?? "";
    if (!/^[a-z-]*$/.test(scene)) {
      response.writeHead(400);
      response.end();
      return;
    }
    if (!cache.has(scene))
      cache.set(
        scene,
        execFileSync(process.execPath, [outfile], {
          env: { ...process.env, PROVIDER_PREVIEW_SCENE: scene },
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
        }),
      );
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(cache.get(scene));
  } catch {
    response.writeHead(500);
    response.end(
      "Build the plugin with npm run build before opening this preview.",
    );
  }
});
server.listen(port, host, () =>
  console.log(`Provider components preview listening on ${host}:${port}`),
);
const cleanup = () => {
  server.close();
  rmSync(temporary, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
