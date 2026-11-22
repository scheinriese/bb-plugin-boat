// Optional local browser checks. Install Playwright outside this repository.
// node scripts/sandboxes-preview-capture.mjs <playwright-package-dir> <output-dir>
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
const require = createRequire(import.meta.url);
const {chromium} = require(resolve(process.argv[2]));
const output = resolve(process.argv[3] ?? "build-shots/sandboxes");
mkdirSync(output, {recursive: true});
const browser = await chromium.launch({executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"]});
const results = [];
try {
  const page = await browser.newPage({deviceScaleFactor: 1});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {if (message.type() === "error") errors.push(message.text());});
  for (const width of [360, 390, 1280]) {
    for (const theme of ["dark", "light"]) {
      for (const scene of ["returned", "active-stale", "loading", "unavailable", "partial", "mixed-currency", "stopped-held", "loaded-null-plan", "failed-refresh"]) {
        await page.setViewportSize({width, height: width === 1280 ? 1000 : 844});
        await page.goto(`http://127.0.0.1:4182/?scene=${scene}&theme=${theme}`, {waitUntil: "networkidle"});
        const main = page.locator("main");
        await main.getByRole("heading", {name: "Running now", exact: true}).waitFor();
        assert.equal(await main.getByRole("heading", {name: "This billing period", exact: true}).count(), 1);
        assert.equal(await main.getByRole("heading", {name: "Saved, not running", exact: true}).count(), 1);
        const geometry = await page.evaluate(() => ({
          viewport: innerWidth, document: document.documentElement.scrollWidth,
          scrollRegions: Array.from(document.querySelectorAll("main *")).filter(element => !element.closest("details:not([open])") && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "auto").map(element => element.tagName),
          headings: Array.from(document.querySelectorAll("main h2")).map(element => {const style = getComputedStyle(element); return {text: element.textContent, size: style.fontSize, height: style.lineHeight, weight: style.fontWeight, tracking: style.letterSpacing, transform: style.textTransform};}),
          targets: Array.from(document.querySelectorAll("main a,main button,main summary,main select")).filter(element => !(element.closest("details:not([open])") && !element.closest("summary")) && element.getBoundingClientRect().width > 0).map(element => ({text: element.textContent?.trim(), height: element.getBoundingClientRect().height})),
        }));
        assert.ok(geometry.document <= width + 1, `${scene}/${theme}/${width}: page does not overflow horizontally`);
        assert.deepEqual(geometry.scrollRegions, [], `${scene}/${theme}/${width}: no essential horizontally scrolling region`);
        for (const heading of geometry.headings.filter(heading => ["Running now", "This billing period", "Saved, not running"].includes(heading.text))) {
          assert.deepEqual([heading.size, heading.height, heading.weight, heading.transform], ["14px", "20px", "600", "none"], "approved sentence-case section typography");
          assert.ok(["normal", "0px"].includes(heading.tracking));
        }
        for (const target of geometry.targets) assert.ok(target.height >= 43.5, `${scene}/${width}: ${target.text} has a 44px target`);
        const text = await main.innerText();
        if (scene === "loading") assert.doesNotMatch(text, /\$0(?:\.00)?|0\.0 h/, "loading never appears as a zero reading");
        if (scene === "unavailable") assert.match(text, /unavailable/i);
        if (scene === "active-stale") assert.match(text, /stale/i);
        if (scene === "returned") assert.match(text, /handed back|returned/i);
        if (scene === "stopped-held") {
          assert.match(text, /No Instabox machines running/);
          assert.match(text, /1 stopped/);
          assert.match(text, /Recorded lease held/);
          assert.doesNotMatch(text, /Last Mac handed back/);
        }
        if (scene === "loaded-null-plan") {
          const plan = await main.getByRole("article", {name: "boat.dev plan usage"}).innerText();
          assert.match(plan, /unavailable/i);
          assert.doesNotMatch(plan, /Checking plan usage/);
        }
        if (scene === "failed-refresh") {
          assert.match(text, /Local estimate · Stale: last checked/i);
          assert.match(text, /\$12\.00 USD/);
        }
        if (["returned", "active-stale"].includes(scene) || (width === 390 && theme === "dark" && ["stopped-held", "loaded-null-plan", "failed-refresh"].includes(scene))) {
          await page.screenshot({path: join(output, `${scene}-${width}-${theme}.png`), fullPage: true});
        }
        results.push({scene, theme, width, ...geometry});
      }
    }
  }
  for (const width of [360, 390, 1280]) {
    for (const theme of ["dark", "light"]) {
      await page.setViewportSize({width, height: 1000});
      await page.goto(`http://127.0.0.1:4182/?scene=active-stale&theme=${theme}`, {waitUntil: "networkidle"});
      await page.locator("main details summary").click();
      const expanded = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        scrollRegions: Array.from(document.querySelectorAll("main *")).filter(element => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "auto").map(element => element.tagName),
        targets: Array.from(document.querySelectorAll("main button,main a,main summary")).filter(element => element.getBoundingClientRect().width > 0).map(element => ({text: element.textContent?.trim(), height: element.getBoundingClientRect().height})),
      }));
      assert.ok(expanded.document <= width + 1, `expanded/${theme}/${width}: page does not overflow`);
      assert.deepEqual(expanded.scrollRegions, [], `expanded/${theme}/${width}: machine actions have no horizontal scrolling`);
      for (const target of expanded.targets) assert.ok(target.height >= 43.5, `expanded/${width}: ${target.text} has a 44px target`);
      await page.screenshot({path: join(output, `machine-actions-${width}-${theme}.png`), fullPage: true});
      results.push({scene: "machine-actions-expanded", theme, width, ...expanded});
    }
  }
  await page.goto("http://127.0.0.1:4182/?scene=active-stale&theme=dark", {waitUntil: "networkidle"});
  const task = page.locator("main").getByRole("button", {name: /Test the synthetic desktop app/}).first();
  if (await task.count()) {await task.click(); await page.getByRole("status").getByText("Synthetic task link opened. No live navigation.").waitFor();}
  assert.deepEqual(errors, [], "no browser runtime or console errors");
  writeFileSync(join(output, "browser-checks.json"), JSON.stringify({passed: true, checked: results.length, results}, null, 2));
  console.log(`PASS: ${results.length} real component scenarios checked at 360/390/1280 in light/dark; no page errors, essential horizontal scroll, or undersized targets.`);
} finally {await browser.close();}
