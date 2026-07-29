// Shared browser setup for everything that drives the built export in a real Chromium.
//
// THE TRAPS ARE THE REASON THIS IS A MODULE. Each one below cost a previous audit real time, and each
// makes a check pass while proving nothing:
//
//  • hasTouch. A headless context is a MOUSE device by default, so `@media (hover: hover)` matches and
//    `@media (hover: none)` never fires. Every mobile-only rule in the app is behind the second one, so
//    a "mobile" viewport without hasTouch renders the DESKTOP styling at 375px wide and reports it as
//    fine. Viewports below the tablet breakpoint therefore always set it.
//
//  • The chain. The app reads over WS from PUBLIC_WS and nothing on a data surface renders without it.
//    Chrome (nav, filters, headers, empty states) renders from first paint regardless, which is why the
//    layout checks here do not need a chain at all. Point CG_WS at the tracking node
//    (scripts/run-tracking-node.sh) or the live relay when a check needs real posts.
//
//  • Sign-in. Signed-in surfaces are reachable with NO wallet by writing the `cg-session` record before
//    the app boots. It is device-global (not viewer-scoped), so it goes in as a plain key. This only
//    gets the viewer past the auth wall; it does not give them posting power, which is a chain read.
//
// SSG note: everything here drives the EXPORT, never `next dev`. See lib/export-server.mjs for why.

import { chromium } from "@playwright/test";

/** The tablet breakpoint from AppShell.module.css. At or below it, the app is in its touch layout. */
const TOUCH_MAX_WIDTH = 1019;

/** localStorage keys, mirrored from lib/sessionRestore.ts and lib/config/endpoints.ts. */
const SESSION_KEY = "cg-session";
const ENDPOINTS_KEY = "cogno.endpoints";

/** Named viewports, so a capture and an assertion can never disagree about what "mobile" means. */
export const VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 900 },
  /** The feed column's own width, where the single-column layout is widest. */
  feed: { width: 600, height: 900 },
};

export function parseViewports(spec) {
  if (!spec) return ["mobile", "tablet", "desktop"].map((n) => ({ name: n, ...VIEWPORTS[n] }));
  return String(spec)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (VIEWPORTS[s]) return { name: s, ...VIEWPORTS[s] };
      const w = Number(s);
      if (!Number.isFinite(w) || w <= 0) throw new Error(`bad viewport: ${s}`);
      return { name: `${w}px`, width: w, height: 900 };
    });
}

/**
 * Launch Chromium. One browser, many contexts: a context per viewport is cheap, a browser is not.
 */
export function launch() {
  return chromium.launch();
}

/**
 * A context at `viewport`, with the touch trap handled and an optional fabricated session.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {{width:number,height:number}} viewport
 * @param {{ signedIn?: boolean, ws?: string }} [opts]
 */
export async function newContext(browser, viewport, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    // See the header: without this, a 375px viewport silently renders desktop styling.
    hasTouch: viewport.width <= TOUCH_MAX_WIDTH,
    isMobile: false, // Chromium couples isMobile to a whole emulation profile; hasTouch is the media bit
    deviceScaleFactor: 1,
  });

  const seed = {};
  if (opts.signedIn) {
    // EVERY FIELD IS REQUIRED, and the shape is not negotiable. `parseRestoredSession`
    // (lib/sessionRestore.ts) type-checks all five and additionally demands a non-empty walletId and
    // ss58 and a 0x-prefixed publicKeyHex, degrading to "no session" on any miss. A plausible-looking
    // record with the wrong keys is therefore WORSE than none: the run silently stays a guest and the
    // check reports on guest chrome while claiming to audit a signed-in surface.
    //
    // //Alice's well-known public key. This gets a headless run past the auth wall with no wallet; it
    // does NOT confer posting power, which is a chain read against a real account.
    seed[SESSION_KEY] = JSON.stringify({
      walletId: "headless",
      ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      publicKeyHex: "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
      walletAddress: "addr_test1headless",
      walletAddressHex: "00",
    });
  }
  // An ARRAY under `cogno.endpoints`, which is what getEndpoints parses; a bare string is filtered out
  // by isValidWsUrl and falls back to the default endpoint without saying so.
  if (opts.ws) seed[ENDPOINTS_KEY] = JSON.stringify([opts.ws]);

  if (Object.keys(seed).length > 0) {
    // BEFORE any script runs, not after navigation: the providers read localStorage during their first
    // render, so seeding afterwards would need a reload and would race the boot either way.
    await context.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) {
        try {
          window.localStorage.setItem(k, v);
        } catch {
          /* storage disabled */
        }
      }
    }, seed);
  }
  return context;
}

/**
 * Open `path` and wait for the app shell to have painted.
 *
 * Deliberately NOT `networkidle`: the app holds a live WS subscription, so with a chain configured the
 * network is never idle and the wait would burn its full timeout on every page. Waiting for the shell
 * element is both faster and a stronger claim (the React tree mounted), and layout checks only need
 * chrome, which does not wait on any read.
 */
export async function openPage(context, origin, path) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  // `state: "attached"` IS LOAD-BEARING. waitForSelector defaults to waiting for VISIBILITY, and the
  // first `body *` on a Next export is an injected <script>, which is never visible — so the default
  // burns its whole timeout on every page while the DOM has in fact been ready the entire time. With a
  // 15s timeout across 13 routes and 3 viewports that is ten minutes of waiting for nothing.
  await page.waitForSelector("body *", { state: "attached", timeout: 10000 }).catch(() => {});
  // One frame for layout to settle after hydration, so a measurement is not taken mid-paint.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return { page, errors };
}
