// Optional local-only browser verification of actual shared routing/payment controls.
// Usage: node scripts/claude-routing-preview-capture.mjs <playwright-package-dir> <output-dir>
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.argv[2]));
const output = resolve(process.argv[3]);
mkdirSync(output,{recursive:true});
const browser = await chromium.launch({executablePath:process.env.CHROME_BIN??"/usr/bin/google-chrome",headless:true,args:["--no-sandbox"]});
try {
  const page = await browser.newPage({viewport:{width:1100,height:1100},deviceScaleFactor:1});
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto("http://127.0.0.1:4181/",{waitUntil:"networkidle"});
  await page.evaluate(()=>localStorage.clear());
  await page.reload({waitUntil:"networkidle"});
  const custom = page.getByRole("region",{name:"Original custom task controls"});
  await custom.getByRole("button",{name:"Revoke Claude paid continuation"}).click();
  await page.reload({waitUntil:"networkidle"});
  assert.equal(await custom.getByText("Claude paid continuation revoked",{exact:true}).count(),1);
  assert.equal(await custom.getByText("Claude routing retained",{exact:true}).count(),1);
  assert.equal(await custom.getByRole("button",{name:"Return to normal routing"}).count(),1);
  await page.screenshot({path:join(output,"custom-revoked-routing-retained.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,"mobile controls do not overflow");
  await page.screenshot({path:join(output,"custom-revoked-routing-mobile.png"),fullPage:true});
  await page.setViewportSize({width:1100,height:1100});
  await custom.getByRole("button",{name:"Return to normal routing"}).click();
  await page.reload({waitUntil:"networkidle"});
  assert.equal(await custom.getByText("Normal routing restored",{exact:true}).count(),1);
  assert.equal(await custom.getByText("Claude paid continuation revoked",{exact:true}).count(),1);
  assert.equal(await custom.getByRole("button",{name:"Return to normal routing"}).count(),0);
  await page.screenshot({path:join(output,"custom-normal-routing-restored.png"),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log("PASS: real shared custom-task controls retain routing after payment revoke, expose explicit release, persist independent states after reload, and fit mobile; no page errors.");
} finally { await browser.close(); }
