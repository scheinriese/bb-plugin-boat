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
const rentalScript = await build({
  entryPoints: ["scripts/rental-preview.tsx"],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
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
    if (url.pathname === "/rental-preview.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(rentalScript.outputFiles[0].contents);
      return;
    }
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
    if (scene === "rental-interactive") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="en" class="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake Mac rental choice</title><style>@layer theme,base,components,utilities;</style><link rel="stylesheet" href="/app.css"><style>body{--spacing:.25rem;--font-weight-medium:500;--font-weight-semibold:600;--text-xs:.75rem;--text-xs--line-height:1rem;--text-sm:.875rem;--text-sm--line-height:1.25rem;--text-base:1rem;--text-base--line-height:1.5rem;--default-font-family:Inter,system-ui,sans-serif;--radius:.5rem;margin:0;background:#161616;color:#EDEDED;font-family:Inter,system-ui,sans-serif}@layer base{*{box-sizing:border-box}p,h1,h2,h3,ol,ul,dl,dd{margin:0;padding:0}ol,ul{list-style:none}button,a{font:inherit}a{color:inherit;text-decoration:none}button{cursor:pointer;background:transparent;color:inherit;border:0;padding:0}svg{display:block}}</style></head><body data-bb-plugin="boat"><div id="rental-preview"></div><script type="module" src="/rental-preview.js"></script></body></html>`);
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
