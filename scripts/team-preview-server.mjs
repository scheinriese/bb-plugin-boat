// Read-only component preview; never connects to the live bb or cloud providers.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const dir = mkdtempSync(join(process.cwd(), ".team-preview-"));
const shim = resolve("test/fixtures/team-preview-sdk.tsx");
await build({
  entryPoints: ["scripts/team-preview.tsx"],
  outfile: join(dir, "render.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  loader: { ".css": "empty" },
  logLevel: "silent",
  plugins: [
    {
      name: "preview-host",
      setup(builder) {
        builder.onResolve({ filter: /^@get-bb\/plugin-sdk\/app$/ }, (args) =>
          args.importer === shim
            ? { path: args.path, external: true }
            : { path: shim },
        );
      },
    },
  ],
});
const { renderScene } = await import(
  pathToFileURL(join(dir, "render.mjs")).href
);
const port = Number(process.env.PORT ?? 4174);
createServer((req, res) => {
  const url = new URL(req.url, "http://preview.invalid");
  if (url.pathname === "/app.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(readFileSync("dist/app.css"));
    return;
  }
  const scene = url.searchParams.get("scene") ?? "today";
  if (!["today", "board", "tray", "strip", "confirm"].includes(scene)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team · ${scene} · fixture preview</title><style>@layer theme,base,components,utilities;</style><link rel="stylesheet" href="/app.css"><style>
@layer base{button{background:transparent;color:inherit;border:0;padding:0;font:inherit}}:root{--background:#141414;--foreground:#ededed;--border:#292929;--card:#1b1b1b;--accent:#242424;--muted-foreground:#8a8a8a;--primary:#e6e6e6;--primary-foreground:#151515;--secondary:#262626;--radius:.5rem;--spacing:.25rem}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:#141414;color:#ededed;font-size:13px}button{cursor:pointer;font:inherit}h1,h2,h3,p{margin:0}button{color:inherit}a{color:#79a9db}.preview-shell{display:flex;min-height:100vh}.preview-sidebar{width:320px;flex-shrink:0;background:#1b1b1b;border-right:1px solid #2a2a2a;padding:48px 10px 20px}.preview-sidebar>p,.preview-sidebar>div>p{display:flex;align-items:center;gap:10px;color:#b6b6b6;padding:9px 10px}.preview-sidebar hr{border:0;border-top:1px solid #2a2a2a;margin:18px 0}.preview-sidebar small{display:block;color:#8a8a8a;margin:8px 0 10px 35px}.preview-nora{background:#262626;border:1px solid #333;border-radius:10px;display:flex;gap:10px;padding:12px 10px;margin-bottom:12px;align-items:center}.preview-nora>.team-avatar{width:42px;height:42px}.preview-nora>span:nth-child(2){min-width:0;flex:1;color:#9f9f9f}.preview-nora small{margin:4px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}.preview-nora b{color:#eee;font-weight:500}.preview-nora strong{background:#f0b135;color:#151515;border-radius:12px;min-width:22px;text-align:center}.preview-active{background:#303030;border-radius:6px}.preview-caption{margin-top:60px;font-size:11px;line-height:1.6}.preview-shell>main{flex:1;min-width:0}.preview-chat{max-width:880px;padding:24px 28px;margin:auto;min-height:100vh;display:flex;flex-direction:column}.preview-chat>h1{font-size:16px;border-bottom:1px solid #292929;padding-bottom:20px}.preview-message{display:flex;gap:15px;margin:60px 15px;line-height:1.8}.preview-message>.team-avatar{flex-shrink:0;width:28px;height:28px}.preview-composer{margin-top:auto;padding:0 0 28px}.preview-input{margin-top:8px;border:1px solid #333;border-radius:10px;height:110px;padding:18px;color:#777;background:#1c1c1c}.team-page{height:100vh}.team-settings{display:none}@media(max-width:800px){.preview-sidebar{display:none}}
</style></head><body data-bb-plugin="boat">${renderScene(scene)}</body></html>`);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
}).listen(port, "0.0.0.0", () =>
  console.log(`Team fixture preview on 0.0.0.0:${port}`),
);
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
