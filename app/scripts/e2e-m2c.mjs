// M2c browser acceptance — the talk-capacity battery + feeless posting, in real headless
// Chrome against the built static SPA. Assumes the dev accounts were granted a battery
// (`npm run grant`). Drives the actual UI:
//   1. the <CapacityBattery> renders charged for the active key (//Alice, granted ~10 posts)
//   2. a post lands in the live feed (feeless)
//   3. the battery DRAINS — aria-valuenow drops after the post consumes capacity
import { chromium } from "playwright-core";

const URL = process.env.URL || "http://127.0.0.1:8099/";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const SHOT = "/tmp/cogno-m1";
const marker = `M2c feeless+capacity · ${new Date().toISOString()} · ${Math.floor(Math.random() * 1e6)}`;
const log = (m) => console.log(`[e2e-m2c] ${m}`);

let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  log(`goto ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByText(/connected/i).first().waitFor({ timeout: 45000 });
  log("PAPI connected ✓");

  // 1. battery present + charged
  const meter = page.locator('[role="meter"]').first();
  await meter.waitFor({ timeout: 30000 });
  await page.getByText(/talk capacity/i).first().waitFor({ timeout: 10000 });
  // wait until charged (aria-valuenow > 0 — the grant has landed)
  let chargedNow = 0n;
  for (let i = 0; i < 30; i++) {
    chargedNow = BigInt((await meter.getAttribute("aria-valuenow")) || "0");
    if (chargedNow > 0n) break;
    await page.waitForTimeout(1000);
  }
  if (chargedNow <= 0n) throw new Error("battery never charged — did you run `npm run grant`?");
  const max = BigInt((await meter.getAttribute("aria-valuemax")) || "0");
  const readout = (await page.locator('[role="meter"]').first().locator("xpath=ancestor::*[1]").textContent().catch(() => "")) || "";
  log(`battery charged ✓ — aria-valuenow=${chargedNow} / max=${max}`);
  const statusTxt = await page.getByText(/ready to post|post in ~|no talk capacity/i).first().textContent().catch(() => null);
  if (statusTxt) log(`battery status: "${statusTxt.trim()}"`);
  await page.screenshot({ path: `${SHOT}/e2e-m2c-1-charged.png`, fullPage: true });

  // 2. post (feeless) → lands in feed
  log(`composing + posting: "${marker}"`);
  await page.locator("#cogno-composer").fill(marker);
  await page.getByRole("button", { name: /^post$/i }).click();
  const post = page.locator("article", { hasText: marker });
  await post.waitFor({ timeout: 60000 });
  log("POST APPEARED IN LIVE FEED ✓ (feeless, capacity-metered)");

  // 3. battery drains — aria-valuenow drops below the charged value after consume
  let drained = null;
  for (let i = 0; i < 20; i++) {
    const now = BigInt((await meter.getAttribute("aria-valuenow")) || "0");
    if (now < chargedNow) { drained = now; break; }
    await page.waitForTimeout(1000);
  }
  if (drained == null) throw new Error("battery did not drain after posting (capacity not consumed?)");
  log(`BATTERY DRAINED ✓ — aria-valuenow ${chargedNow} → ${drained} (consumed ${chargedNow - drained} micro-capacity)`);
  await page.screenshot({ path: `${SHOT}/e2e-m2c-2-drained.png`, fullPage: true });

  if (errors.length) { log(`NOTE ${errors.length} console error(s):`); errors.slice(0, 6).forEach((e) => log(`  · ${e}`)); }
  else log("no console errors ✓");

  console.log("\n==================== M2c BROWSER ACCEPTANCE: PASS ====================");
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error("\n==================== M2c BROWSER ACCEPTANCE: FAIL ====================");
  console.error(err);
  try { const p = browser?.contexts().flatMap((c) => c.pages())[0]; if (p) await p.screenshot({ path: `${SHOT}/e2e-m2c-FAIL.png`, fullPage: true }); } catch {}
  if (browser) await browser.close();
  process.exit(1);
}
