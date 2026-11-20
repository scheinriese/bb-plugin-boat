// Optional browser verification of the safe local component preview.
// Usage: node scripts/claude-design-preview-capture.mjs <playwright-package-dir> <output-dir>
// Install Playwright separately; it is not a production plugin dependency.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
const require=createRequire(import.meta.url);
const { chromium }=require(resolve(process.argv[2]));
const output=resolve(process.argv[3]??"build-shots/claude-design");mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??"/usr/bin/google-chrome",headless:true,args:["--no-sandbox"]});
try {
  const page=await browser.newPage({viewport:{width:1100,height:1000},deviceScaleFactor:1});
  const errors=[];page.on("pageerror",error=>{errors.push(error.message);console.error(error.message); });
  await page.goto("http://127.0.0.1:4181/",{waitUntil:"networkidle"});
  await page.evaluate(()=>localStorage.clear());await page.reload({waitUntil:"networkidle"});
  const preference=page.getByRole("switch",{name:"Prefer Claude for design"});
  assert.equal(await preference.getAttribute("aria-checked"),"true");
  await page.screenshot({path:join(output,"design-settings-and-chat.png"),fullPage:true});
  await preference.click();await page.reload({waitUntil:"networkidle"});
  assert.equal(await preference.getAttribute("aria-checked"),"false","fake setting persists through reload");
  await preference.click();
  await page.getByRole("button",{name:"Request Claude continuation confirmation"}).click();
  await page.getByText("Start and allow Claude continuation",{exact:true}).click({timeout:5000});
  assert.equal(await page.locator('input[value="start-claude-continuation"]').isChecked(),true);
  await page.screenshot({path:join(output,"design-owner-confirmation.png"),fullPage:true});
  await page.getByRole("button",{name:"Start with Claude",exact:true}).click();
  await page.reload({waitUntil:"networkidle"});
  assert.equal(await page.getByText("Paid Claude continuation is separately approved for this task.",{exact:true}).count(),1,"scoped fixture permission persists through reload");
  await page.screenshot({path:join(output,"design-paid-consent-active.png"),fullPage:true});
  await page.getByRole("region",{name:"In-chat task controls"}).getByRole("button",{name:"Return to normal routing"}).click();
  await page.reload({waitUntil:"networkidle"});
  assert.equal(await page.getByText("Design task · normal routing",{exact:true}).count(),1);
  assert.equal(await page.getByText("Paid Claude continuation is separately approved for this task.",{exact:true}).count(),0,"normal routing revokes scoped fixture permission");
  await page.screenshot({path:join(output,"design-normal-routing-restored.png"),fullPage:true});
  await page.getByRole("button",{name:"Revoke Claude paid continuation"}).click();
  await page.reload({waitUntil:"networkidle"});
  assert.equal(await page.getByText("Claude paid continuation revoked",{exact:true}).count(),1,"custom task scope can be revoked independently of design metadata");
  await page.screenshot({path:join(output,"custom-task-scope-revoked.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole("button",{name:"Reset fixture"}).click();
  await page.screenshot({path:join(output,"design-mobile-controls.png"),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log("PASS: actual design controls and native form rendered; fake setting/permission reload persistence and normal-routing revocation verified; no page errors.");
} finally {await browser.close();}
