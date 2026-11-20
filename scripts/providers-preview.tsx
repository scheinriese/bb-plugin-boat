// Static preview of the real components with neutral, obviously fake data.
// npx esbuild scripts/providers-preview.tsx --bundle --platform=node --format=esm --packages=external --outfile=scripts/.providers-preview.mjs
// node scripts/.providers-preview.mjs > /tmp/providers-preview/index.html
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { scene } from "../test/fixtures/provider-polish-render";
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
// Simulate host chrome using the values bb reads from this plugin. The
// provider rows and chat notice below are the actual plugin components.
const panelTitle = /app\.slots\.navPanel\(\{[\s\S]*?title: "([^"]+)"/.exec(
  readFileSync("app.tsx", "utf8"),
)![1];

function NamePreview() {
  return <>
    <section style={{ marginBottom: 32 }}>
      <h2 className="caption">Settings · host frame from plugin manifest</h2>
      <h1 style={{ fontSize: 26, lineHeight: "32px", fontWeight: 500, letterSpacing: "-.015em" }}>
        {manifest.bb.name}
      </h1>
      <p style={{ fontSize: 13, lineHeight: "20px", color: "#8A8A8A", maxWidth: 760, marginBottom: 20 }}>
        {manifest.bb.description}
      </p>
      {scene("settings")}
    </section>
    <section style={{ marginBottom: 32 }}>
      <h2 className="caption">Cloud agents · host frame from navPanel title</h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center", height: 42, borderBottom: "1px solid #262626", marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{panelTitle}</span>
        <span style={{ fontSize: 12, color: "#6E6E6E" }}>Cloud agents</span>
      </div>
      <div style={{ display: "flex", gap: 28, fontSize: 20, marginBottom: 20 }}>
        <span>Today</span><span>Sandboxes</span><span>Projects</span>
      </div>
      {scene("usage")}
    </section>
    <section>
      <h2 className="caption">Chat · actual provider notice card</h2>
      {scene("fresh")}
    </section>
  </>;
}
const allScenes = [
  "name",
  "usage",
  "credential-settings-ready",
  "credential-emergency",
  "credential-revocation",
  "sandbox-actions",
  "running-only",
  "multi-lease-footer",
  "settings",
  "footer",
  "github",
  "key",
  "capacity",
  "fresh",
  "failed",
  "released",
  "lines",
  "unused",
  "over",
  "off",
  "scaleway",
  "kept",
  "scheduled",
  "elapsed",
  "no-lease",
  "boat-footer",
  "waiting",
  "regressed",
  "complete",
];
const names = process.env.PROVIDER_PREVIEW_SCENE
  ? allScenes.filter((name) => name === process.env.PROVIDER_PREVIEW_SCENE)
  : allScenes;
const html = renderToStaticMarkup(
  <html lang="en" className="dark">
    <head>
      <meta charSet="UTF-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Provider polish round 2 · component preview</title>
      <style>{"@layer theme,base,components,utilities;"}</style>
      <link rel="stylesheet" href="/app.css" />
      <style>{`body{--spacing:.25rem;--font-weight-medium:500;--font-weight-semibold:600;--text-xs:.75rem;--text-xs--line-height:1rem;--text-sm:.875rem;--text-sm--line-height:1.25rem;--text-base:1rem;--text-base--line-height:1.5rem;--default-font-family:Inter,system-ui,sans-serif;--radius:.5rem;margin:0;background:#161616;color:#EDEDED;font-family:Inter,system-ui,sans-serif;--boat-faint:#6E6E6E;--boat-label:#E2E2E2;--boat-content:#D6D6D6;--boat-secondary:#A8A8A8;--boat-heading:#EDEDED;--boat-setting-border:#262626;--border:#262626;--card:#181818;--muted-foreground:#8A8A8A;--foreground:#EDEDED}@layer base{*{box-sizing:border-box}p,h1,h2,h3,ol,ul,dl,dd{margin:0;padding:0}ol,ul{list-style:none}button,a{font:inherit}a{color:inherit;text-decoration:none}button{cursor:pointer;background:transparent;color:inherit;border:0;padding:0}svg{display:block}}main{max-width:992px;margin:40px auto;padding:16px}h1{font-size:18px;margin-bottom:8px}.intro{font-size:12px;color:#8A8A8A}.scene{margin:32px 0}.caption{font-size:12px;color:#6E6E6E;margin-bottom:12px}#settings{max-width:760px}.scene>section{margin:0}nav{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#7AA7FF;margin-top:16px}@media(max-width:600px){main{margin:16px auto}.scene{scroll-margin-top:16px}}`}</style>
    </head>
    <body data-bb-plugin="boat">
      <main className="boat-ui">
        <h1>Cloud agents · Provider polish round 2</h1>
        <p className="intro">
          Actual plugin components · fake sample data · buttons in this static
          preview do not rent or change settings.
        </p>
        <nav>
          {names.map((n) => (
            <a key={n} href={`#${n}`}>
              {n}
            </a>
          ))}
        </nav>
        {names.map((name) => (
          <div key={name} id={name} className="scene">
            <h2 className="caption">{name}</h2>
            {name === "name" ? <NamePreview /> : scene(name)}
          </div>
        ))}
      </main>
    </body>
  </html>,
);
process.stdout.write("<!doctype html>" + html);
