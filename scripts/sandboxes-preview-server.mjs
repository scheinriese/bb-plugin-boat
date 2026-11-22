// Isolated rendering of the real Sandboxes component with synthetic RPCs only.
// Build first for dist/app.css. This server never connects to bb or a provider.
import {createServer} from "node:http";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {join, resolve} from "node:path";
import {build} from "esbuild";
const require = createRequire(import.meta.url);
const shim = resolve("scripts/sandboxes-preview-sdk.tsx");
const result = await build({entryPoints: ["scripts/sandboxes-preview.tsx"], bundle: true, jsx: "automatic", outfile: "preview.js", platform: "browser", format: "esm", write: false, logLevel: "silent", plugins: [{name: "synthetic-host", setup(builder) {builder.onResolve({filter: /^@get-bb\/plugin-sdk\/app$/}, args => ({path: args.importer === shim ? require.resolve("@get-bb/plugin-sdk/app") : shim}));}}]});
const javascript = result.outputFiles.find(file => file.path.endsWith(".js"));
const arg = (name, fallback) => {const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1];};
const port = Number(arg("--port", "4182")), host = arg("--host", "0.0.0.0");
const fontDirectory = arg("--font-dir", process.env.PREVIEW_FONT_DIR);
const fontFaces = fontDirectory ? [400, 500, 600].map(weight => `@font-face{font-family:Inter;font-style:normal;font-weight:${weight};font-display:swap;src:url(/inter-${weight}.woff2) format("woff2")}`).join("") : "";
const css = `${fontFaces}@layer theme,base,components,utilities;:root{--spacing:.25rem;--font-weight-medium:500;--font-weight-semibold:600;--text-xs:.75rem;--text-xs--line-height:1rem;--text-sm:.875rem;--text-sm--line-height:1.25rem;--radius:.5rem;--default-font-family:Inter,system-ui,sans-serif;--background:#fff;--foreground:#202020;--muted-foreground:#666;--border:#dedede;--card:#fafafa;--muted:#f1f1f1;--primary:#222;--primary-foreground:#fff;--input:#ddd;--accent:#eee;--destructive:#b42318;--destructive-foreground:#fff;--secondary:#eee;--secondary-foreground:#222;--state-hover:#eee;--ring:#888;color-scheme:light}.dark{--background:#161616;--foreground:#ededed;--muted-foreground:#8a8a8a;--border:#2a2a2a;--card:#181818;--muted:#252525;--primary:#e6e6e6;--primary-foreground:#141414;--input:#373737;--accent:#292929;color-scheme:dark}body{margin:0;background:var(--background);color:var(--foreground);font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}@layer base{*{box-sizing:border-box}p,h1,h2,h3,ol,ul,dl,dd{margin:0;padding:0}ol,ul{list-style:none}button,a,input,select{font:inherit}a{color:inherit;text-decoration:none}button{cursor:pointer;background:transparent;color:inherit;border:0;padding:0}svg{display:block}}main{max-width:1056px;margin:28px auto;padding:0 24px 32px}.preview-header{margin-bottom:24px}.preview-header h1{font-size:20px;line-height:26px;font-weight:600}.preview-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;border-bottom:1px solid var(--border);padding:12px 24px;font-size:12px;color:var(--muted-foreground)}.preview-controls select{min-height:44px;margin-left:8px;padding:0 6px;max-width:180px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--foreground)}@media(max-width:600px){main{margin:24px auto;padding:0 16px 24px}.preview-controls{padding:12px 20px}.preview-controls p{width:100%}}`;
createServer((request, response) => {
  const url = new URL(request.url, "http://preview.invalid");
  if (fontDirectory && /^\/inter-(400|500|600)\.woff2$/.test(url.pathname)) {response.setHeader("Content-Type", "font/woff2"); response.end(readFileSync(join(fontDirectory, `inter-latin-${url.pathname.match(/(400|500|600)/)[0]}-normal.woff2`)));}
  else if (url.pathname === "/favicon.ico") {response.writeHead(204); response.end();}
  else if (url.pathname === "/preview.js") {response.setHeader("Content-Type", "text/javascript"); response.end(javascript.contents);}
  else if (url.pathname === "/app.css") {response.setHeader("Content-Type", "text/css"); response.end(readFileSync("dist/app.css"));}
  else if (url.pathname === "/") {
    const theme = url.searchParams.get("theme") === "light" ? "" : "dark";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Sandboxes component preview</title><style>${css}</style><link rel="stylesheet" href="/app.css"></head><body data-bb-plugin="boat"><div id="root"></div><script type="module" src="/preview.js"></script></body></html>`);
  } else {response.writeHead(404); response.end();}
}).listen(port, host, () => console.log(`Synthetic Sandboxes preview listening on ${host}:${port}`));
