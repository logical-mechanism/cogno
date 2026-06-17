// M2 browser acceptance — the identity gate UI in real headless Chrome against the built static
// SPA. The CIP-30 wallet click-through (binding via Eternl/Lace) is the user's manual step — a
// browser extension can't be driven headlessly — so this proves everything AROUND it:
//   1. both honesty badges render (`follower: trusted (v1)` + `chain: operator-run (v1)`)
//   2. the default key (//Alice, pre-bound via `npm run grant`) shows the seal as BOUND, the
//      composer is NOT gated, and a post lands in the live feed
//   3. switching to a fresh session key (UNBOUND) flips the seal to "bind Cardano →" and GATES
//      the composer ("bind a Cardano identity to post", Post disabled) — the gate, in-browser
//
// Pre: a fresh --dev node, `npm run grant //Alice` (binds+weights+charges //Alice), SPA on :8099.
import { chromium } from "playwright-core";

const URL = process.env.URL || "http://127.0.0.1:8099/";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const SHOT = "/tmp/cogno-m2";
const marker = `M2 identity gate · ${new Date().toISOString()} · ${Math.floor(Math.random() * 1e6)}`;
const log = (m) => console.log(`[e2e-m2] ${m}`);

let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1600 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  log(`goto ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByText(/connected/i).first().waitFor({ timeout: 45000 });
  log("PAPI connected ✓");

  // 1. both honesty badges present
  await page.getByText("follower: trusted (v1)").first().waitFor({ timeout: 15000 });
  await page.getByText("chain: operator-run (v1)").first().waitFor({ timeout: 5000 });
  log("both honesty badges render ✓ (follower: trusted (v1) + chain: operator-run (v1))");

  // 2. //Alice is bound (granted) → seal shows bound, composer not gated, post lands
  // Wait for the bind readback to resolve (useIdentity reads PkhOf on mount).
  const seal = page.getByRole("button", { name: /bind a cardano identity/i }).or(page.getByText(/bound/i).first());
  let boundShown = false;
  for (let i = 0; i < 30; i++) {
    if (await page.getByText(/^bound/i).first().isVisible().catch(() => false)) { boundShown = true; break; }
    if (await page.locator("text=bound ·").first().isVisible().catch(() => false)) { boundShown = true; break; }
    if (await page.locator(".chipValue:has-text('bound')").first().isVisible().catch(() => false)) { boundShown = true; break; }
    await page.waitForTimeout(1000);
  }
  if (!boundShown) throw new Error("//Alice seal never showed BOUND — did you run `npm run grant //Alice`?");
  log("seal shows BOUND for the granted key ✓");
  await page.screenshot({ path: `${SHOT}/e2e-m2-1-bound.png`, fullPage: true });

  log(`composing + posting as bound //Alice: "${marker}"`);
  await page.locator("#cogno-composer").fill(marker);
  await page.getByRole("button", { name: /^post$/i }).click();
  await page.locator("article", { hasText: marker }).waitFor({ timeout: 60000 });
  log("BOUND ACCOUNT POSTED — appears in the live feed ✓");

  // 3. switch to a fresh (UNBOUND) session key → the gate engages
  log("switching to a fresh session key (unbound)…");
  await page.getByRole("button", { name: /posting key/i }).first().click();
  await page.getByRole("menuitem", { name: /generate session key/i }).click();
  // Acknowledge the mnemonic backup box.
  await page.getByRole("button", { name: /i've saved it|saved it/i }).click().catch(() => {});
  // The active key is now an unbound session key.
  const gateMsg = page.getByText(/bind a cardano identity to post/i).first();
  await gateMsg.waitFor({ timeout: 20000 });
  log("composer GATED for the unbound key ✓ ('bind a Cardano identity to post')");
  // The seal flips to the bind CTA.
  await page.getByText(/bind cardano/i).first().waitFor({ timeout: 10000 });
  log("seal flips to 'bind Cardano →' for the unbound key ✓");
  // Post button disabled.
  const postBtn = page.getByRole("button", { name: /^post$/i });
  const disabled = await postBtn.isDisabled().catch(() => false);
  if (!disabled) throw new Error("Post button was NOT disabled for an unbound account");
  log("Post button disabled while unbound ✓");
  await page.screenshot({ path: `${SHOT}/e2e-m2-2-gated.png`, fullPage: true });

  if (errors.length) { log(`NOTE ${errors.length} console error(s):`); errors.slice(0, 8).forEach((e) => log(`  · ${e}`)); }
  else log("no console errors ✓");

  console.log("\n==================== M2 BROWSER ACCEPTANCE: PASS ====================");
  console.log("(the real CIP-30 wallet bind click-through is the manual step — see docs/M2-build.md)");
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error("\n==================== M2 BROWSER ACCEPTANCE: FAIL ====================");
  console.error(err);
  try { const p = browser?.contexts().flatMap((c) => c.pages())[0]; if (p) await p.screenshot({ path: `${SHOT}/e2e-m2-FAIL.png`, fullPage: true }); } catch {}
  if (browser) await browser.close();
  process.exit(1);
}
