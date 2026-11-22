import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SandboxTable } from "../web/sandboxes-table";
import { SCENES } from "./sandboxes-preview-data";

function Preview() {
  const [navigation, setNavigation] = useState(false);
  const params = new URLSearchParams(location.search);
  const current = params.get("scene") ?? "returned";
  const theme = params.get("theme") ?? "dark";
  useEffect(() => {
    const listener = () => setNavigation(true);
    window.addEventListener("fixture-navigation", listener);
    return () => window.removeEventListener("fixture-navigation", listener);
  }, []);
  return <>
    <aside className="preview-controls" aria-label="Synthetic preview controls">
      <p>Synthetic component preview · all provider actions disabled</p>
      <label>Scenario <select value={current} onChange={event => {params.set("scene", event.target.value); location.search = params.toString();}}>{SCENES.map(scene => <option key={scene}>{scene}</option>)}</select></label>
      <label>Appearance <select value={theme} onChange={event => {params.set("theme", event.target.value); location.search = params.toString();}}><option>dark</option><option>light</option></select></label>
      {navigation && <p role="status">Synthetic task link opened. No live navigation.</p>}
    </aside>
    <main className="boat-ui"><header className="preview-header"><h1>Sandboxes</h1></header><SandboxTable /></main>
  </>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
