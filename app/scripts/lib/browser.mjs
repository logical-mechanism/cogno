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
//  • The chain. Chrome (nav, filters, headers, empty states) renders from first paint regardless of any
//    endpoint, which is why the layout checks here do not need a chain. But OMITTING `ws` IS NOT "NO
//    CHAIN": getEndpoints falls back to DEFAULT_WS_ENDPOINTS, which is the LIVE PUBLIC NODE
//    (wss://cogno.forum/rpc), so an un-pointed run quietly reads production and renders whatever is on
//    it. That makes any un-pointed check network-dependent and non-reproducible — it sees real posts on
//    a good connection, a half-populated race on a slow one, and empty states on a plane. Pass `ws`
//    explicitly for anything whose result should be stable: the local tracking node
//    (scripts/run-tracking-node.sh) for real data, or an unroutable port for a guaranteed empty read.
//
//  • Sign-in. Signed-in surfaces are reachable with NO wallet by writing the `cg-session` record before
//    the app boots. It is device-global (not viewer-scoped), so it goes in as a plain key. This only
//    gets the viewer past the auth wall; it does not give them posting power, which is a chain read.
//
//  • Settling. openPage returns as soon as the shell has painted, which on every chain-backed surface is
//    the SKELETON. A capture taken then shows shimmer rows and a spinner, and it looks like a legitimate
//    loading state rather than a harness that photographed the wrong moment — so a feed, a poll, a thread
//    and a profile were all unreviewable while appearing to have been reviewed. Pass `settle` to wait for
//    the real content. See waitForSettled.
//
// SSG note: everything here drives the EXPORT, never `next dev`. See lib/export-server.mjs for why.

import { chromium } from "@playwright/test";
import { AccountId } from "@polkadot-api/substrate-bindings";
import { toHex } from "@polkadot-api/utils";

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
 * @param {{ signedIn?: boolean, ws?: string, ss58?: string }} [opts] ss58 = the account to sign in AS;
 *   it must be identity-bound on `ws` or the auth wall still wins. See the note in the body.
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
    // AND A VALID RECORD IS ONLY HALF OF IT. The auth wall in AppShell tests `viewer.status ===
    // "ready"`, which is an IDENTITY-BOUND session — a chain read of CognoGate.AccountOf against the
    // endpoint in `ws`. //Alice (the default below) is bound on a --dev chain and NOT on preprod, so
    // pointing at the tracking node and asking for /settings, /notifications or /compose renders
    // WalledRouteNotice: a perfectly legitimate-looking "Settings needs an account" page that is not
    // the surface anyone meant to audit. Pass `ss58` with an account that is actually bound on the
    // chain you are pointing at — every post author on the timeline is one, and
    //   api.query.CognoGate.AccountOf.getEntries()
    // lists them. The public key is derived from the address, so the two can never disagree.
    //
    // Neither form confers posting power: that is a separate chain read against a real vault.
    const ss58 = opts.ss58 ?? "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    seed[SESSION_KEY] = JSON.stringify({
      walletId: "headless",
      ss58,
      publicKeyHex: toHex(AccountId().enc(ss58)),
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
export async function openPage(context, origin, path, opts = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  // `state: "attached"` IS LOAD-BEARING. waitForSelector defaults to waiting for VISIBILITY, and the
  // first `body *` on a Next export is an injected <script>, which is never visible — so the default
  // burns its whole timeout on every page while the DOM has in fact been ready the entire time. With a
  // 15s timeout across 13 routes and 3 viewports that is ten minutes of waiting for nothing.
  await page.waitForSelector("body *", { state: "attached", timeout: 10000 }).catch(() => {});
  let settled = null;
  if (opts.settle) settled = await waitForSettled(page, opts.settle === true ? {} : opts.settle);
  // One frame for layout to settle after hydration, so a measurement is not taken mid-paint.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return { page, errors, settled };
}

/**
 * Wait until the surface has stopped loading, so a capture or a measurement sees real content.
 *
 * THE PREDICATE IS `aria-busy="true"`, and that choice is the point. The app already declares its own
 * waiting state there — Skeleton, Loading and Timeline's placeholder list all set it — so this reads a
 * contract the components maintain rather than guessing. The obvious alternative, matching hashed
 * CSS-module class names (`[class*="keleton"]`), works only by coincidence: the hash happens to embed the
 * source name today, nothing guarantees it, and a production build is free to mangle it into oblivion —
 * at which point the wait would silently pass instantly and every capture would go back to being shimmer.
 *
 * TEXT STABILITY IS A SECOND, SEPARATE GATE, because aria-busy drops the instant the FIRST read lands
 * and the surface keeps moving after that: on /, article count is final at ~1s but the text still grows
 * for another second as relative times, vote tallies and poll state arrive. Settling on aria-busy alone
 * therefore photographs a half-populated feed, which is a more convincing wrong answer than a skeleton.
 *
 * IT NEVER THROWS, AND THAT IS DELIBERATE. Plenty of surfaces legitimately never settle: any chain-backed
 * route with no `--ws` stays busy forever, and that is the correct rendering of "no chain", not a failure.
 * A throwing wait would turn every no-chain run red and the flag would stop being used. Callers get the
 * outcome back instead and can report it — see how shoot.mjs prints `did not settle`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ timeout?: number, quiet?: number }} [opts] quiet = ms of no text change before we call it.
 * @returns {Promise<{ ok: boolean, ms: number, busy: number, reason?: string }>}
 */
export async function waitForSettled(page, opts = {}) {
  const timeout = opts.timeout ?? 10000;
  const quiet = opts.quiet ?? 400;
  const started = Date.now();
  let lastLen = -1;
  let lastChange = started;
  let busy = -1;

  while (Date.now() - started < timeout) {
    let state;
    try {
      state = await page.evaluate(() => ({
        busy: document.querySelectorAll('[aria-busy="true"]').length,
        len: document.body.innerText.length,
      }));
    } catch {
      // Navigated or closed under us. Nothing to wait for.
      return { ok: false, ms: Date.now() - started, busy, reason: "page went away" };
    }
    busy = state.busy;
    if (state.len !== lastLen) {
      lastLen = state.len;
      lastChange = Date.now();
    }
    if (state.busy === 0 && Date.now() - lastChange >= quiet) {
      return { ok: true, ms: Date.now() - started, busy: 0 };
    }
    await page.waitForTimeout(100);
  }
  return {
    ok: false,
    ms: Date.now() - started,
    busy,
    reason: busy > 0 ? `${busy} element(s) still aria-busy` : "content never stopped changing",
  };
}
