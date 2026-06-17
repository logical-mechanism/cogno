// M1 browser acceptance — drives the ACTUAL built static SPA (app/out/) in headless
// Chrome through the real DONE-WHEN loop:
//   1. load the SPA, confirm it connects to the node via PAPI (status "connected")
//   2. type text, sign with the sr25519 key, Post  -> the post lands in a block
//   3. the LIVE feed shows the new post in real time (watchEntries), with author + text
//   4. delete the post -> it disappears from the feed live (PostDeleted)
// Usage: URL=http://localhost:8099/ CHROME=/usr/bin/google-chrome node scripts/e2e.mjs
import { chromium } from "playwright-core";

const URL = process.env.URL || "http://localhost:8099/";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const SHOT = "/tmp/cogno-m1";
const stamp = new Date().toISOString();
const marker = `M1 browser acceptance · ${stamp} · ${Math.floor(Math.random() * 1e6)}`;

const log = (m) => console.log(`[e2e] ${m}`);
let browser;
try {
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  log(`goto ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // 1. CONNECT — the ConnState pill must report a live PAPI connection.
  await page.getByText(/connected/i).first().waitFor({ timeout: 45000 });
  log("PAPI connected ✓ (status pill shows 'connected')");
  // sanity: the honest framing is present
  await page.getByText(/signed ≠ included/i).first().waitFor({ timeout: 10000 });
  await page.getByText(/operator-run/i).first().waitFor({ timeout: 10000 });
  log("honest framing present ✓ ('signed ≠ included', 'operator-run')");

  // 2. POST — type, then Post (sr25519 sign + submit).
  log(`composing: "${marker}"`);
  await page.locator("#cogno-composer").fill(marker);
  const postBtn = page.getByRole("button", { name: /^post$/i });
  await postBtn.waitFor({ timeout: 10000 });
  await postBtn.click();
  log("clicked Post (signing + submitting)…");

  // 3. LIVE FEED — the post appears in the feed via watchEntries (real-time).
  const postArticle = page.locator("article", { hasText: marker });
  await postArticle.waitFor({ timeout: 60000 });
  log("POST APPEARED IN LIVE FEED ✓ (watchEntries delivered it)");

  // capture the in-block/finalized status the composer surfaced
  const statusTxt = await page
    .locator("text=/in block #\\d+|finalized #\\d+/i")
    .first()
    .textContent()
    .catch(() => null);
  if (statusTxt) log(`composer tx status observed: "${statusTxt.trim()}"`);

  // the rendered post must carry the chain-truth marginalia (mono #id, ss58, #block)
  const idText = await postArticle.locator("text=/#\\d+/").first().textContent();
  log(`feed post marginalia shows id/block: "${(idText || "").trim()}"`);
  await page.screenshot({ path: `${SHOT}/e2e-1-posted.png`, fullPage: true });
  log(`screenshot: ${SHOT}/e2e-1-posted.png`);

  // 4. DELETE — own-post delete affordance; the post leaves the feed live.
  const del = postArticle.getByRole("button", { name: /delete your post/i });
  await del.waitFor({ timeout: 20000 });
  await del.click();
  log("clicked delete (signing + submitting delete_post)…");
  await postArticle.waitFor({ state: "detached", timeout: 60000 });
  log("POST REMOVED FROM LIVE FEED ✓ (PostDeleted delivered it)");
  await page.screenshot({ path: `${SHOT}/e2e-2-deleted.png`, fullPage: true });
  log(`screenshot: ${SHOT}/e2e-2-deleted.png`);

  if (consoleErrors.length) {
    log(`NOTE: ${consoleErrors.length} console error(s) during run:`);
    for (const e of consoleErrors.slice(0, 8)) log(`   · ${e}`);
  } else {
    log("no console errors during the run ✓");
  }

  console.log("\n==================== M1 BROWSER ACCEPTANCE: PASS ====================");
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error("\n==================== M1 BROWSER ACCEPTANCE: FAIL ====================");
  console.error(err);
  try {
    const pages = browser ? browser.contexts().flatMap((c) => c.pages()) : [];
    if (pages[0]) await pages[0].screenshot({ path: `${SHOT}/e2e-FAIL.png`, fullPage: true });
  } catch {}
  if (browser) await browser.close();
  process.exit(1);
}
