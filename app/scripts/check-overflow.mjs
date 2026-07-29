// Assert that nothing on a public route scrolls sideways that is not meant to.
//
//   node scripts/check-overflow.mjs
//   node scripts/check-overflow.mjs --v mobile,feed --signed-in
//
// WHY THIS ONE IS AUTOMATED AND SCREENSHOTS ARE NOT. Horizontal overflow is the failure this app keeps
// shipping, it is invisible in review, and it is mechanically decidable. The /governance action-type
// filter was a chip row measuring 1257px inside a 568px column: it had `overflow-x: auto` with the
// scrollbar hidden on both engines, so it scrolled silently and simply looked cut off, and most of the
// eight action types could not be reached at all. Nothing caught it, because nothing could: vitest runs
// in a `node` environment and cannot lay anything out.
//
// EXACTLY TWO FAULTS ARE REPORTED, and the narrowness is deliberate:
//
//  1. THE PAGE scrolls sideways. Always wrong. A reader drags the whole layout to read a line.
//
//  2. AN ELEMENT OPTS IN TO SCROLLING AND HIDES ITS SCROLLBAR while actually overflowing. That
//     combination is precisely "hidden content dressed as a working scroller", and it is what the
//     filter bar was: `overflow-x: auto` with `scrollbar-width: none` and the webkit pseudo-element
//     display:none, so nothing on screen said the other five options existed.
//
// WHAT IS DELIBERATELY NOT REPORTED, because the first version of this check reported all of it and was
// 17-for-17 wrong:
//
//  • Content wider than a box whose overflow is VISIBLE. Nothing is hidden; it paints outside its box.
//    If that pushes the layout, fault 1 catches it, which is the case that actually harms a reader.
//  • Visually-hidden text. The `.srOnly` pattern is a 1px box deliberately holding a full sentence, so
//    "content 176px past its 1px box" is the pattern working, not failing.
//  • Deliberate truncation. `text-overflow: ellipsis` and `-webkit-line-clamp` both REQUIRE overflow
//    hidden with content wider than the box; that is what truncation is.
//
// A check that cries wolf gets ignored, and an ignored check is worse than no check, because it reads
// as coverage in CI while nobody looks at the output.
//
// Chrome-only: this needs no chain and no sign-in, because nav, headers, filters and empty states all
// render from first paint. Run `npm run build` first.

import { startExportServer, exportExists } from "./lib/export-server.mjs";
import { launch, newContext, openPage, parseViewports } from "./lib/browser.mjs";

/** Public routes with real chrome. The dynamic shims are included: they render the shell and the nav. */
const ROUTES = [
  "/",
  "/explore/",
  "/governance/",
  "/bookmarks/",
  "/lists/",
  "/settings/",
  "/welcome/",
  "/legal/",
  "/privacy/",
  "/policy/",
  "/notifications/",
  "/compose/",
  "/post/1/",
];

/** Sub-pixel slack. Fractional layout widths routinely land a hair over and mean nothing. */
const SLACK = 1.5;

const args = process.argv.slice(2);
const vSpec = args.includes("--v") ? args[args.indexOf("--v") + 1] : "mobile,feed,desktop";
const signedIn = args.includes("--signed-in");

if (!(await exportExists())) {
  console.error("no export in app/out. Run `npm run build` first.");
  process.exit(1);
}

const viewports = parseViewports(vSpec);
const server = await startExportServer();
const browser = await launch();

const findings = [];

for (const viewport of viewports) {
  const context = await newContext(browser, viewport, { signedIn });
  for (const route of ROUTES) {
    const { page } = await openPage(context, server.origin, route);
    const result = await page.evaluate((slack) => {
      const out = { page: null, elements: [] };
      const doc = document.scrollingElement ?? document.documentElement;
      if (doc.scrollWidth - doc.clientWidth > slack) {
        out.page = { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
      }
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const over = el.scrollWidth - el.clientWidth;
        if (over <= slack) continue;
        const cs = getComputedStyle(el);
        // ONLY the opted-in-scroller-with-no-visible-scrollbar case. See the header for why every
        // other shape of overflow is left alone.
        if (cs.overflowX !== "auto" && cs.overflowX !== "scroll") continue;
        // Firefox and the standard property both read here. The webkit `::-webkit-scrollbar
        // { display: none }` half cannot be read from computed style at all, but the two are always
        // written together (hiding one engine's scrollbar and not the other's is not a thing anyone
        // does on purpose), so this catches the pair.
        if (cs.scrollbarWidth !== "none") continue;
        const id = [
          el.tagName.toLowerCase(),
          el.id ? `#${el.id}` : "",
          el.className && typeof el.className === "string"
            ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
            : "",
        ].join("");
        out.elements.push({
          id,
          over: Math.round(over),
          width: Math.round(el.clientWidth),
          kind: "scrolls but hides its scrollbar",
        });
      }
      return out;
    }, SLACK);

    if (result.page) {
      findings.push({
        viewport: viewport.name,
        route,
        what: `PAGE scrolls sideways: ${result.page.scrollWidth}px of content in ${result.page.clientWidth}px`,
      });
    }
    for (const e of result.elements) {
      findings.push({
        viewport: viewport.name,
        route,
        what: `${e.id} ${e.kind}: ${e.over}px past its ${e.width}px box`,
      });
    }
    await page.close();
  }
  await context.close();
}

await browser.close();
await server.close();

if (findings.length === 0) {
  console.log(
    `overflow ok — ${ROUTES.length} routes x ${viewports.length} viewports, nothing hidden sideways.`,
  );
  process.exit(0);
}

for (const f of findings) {
  console.log(`  ${f.viewport.padEnd(8)} ${f.route.padEnd(18)} ${f.what}`);
}
console.error(`\noverflow FAILED (${findings.length})`);
process.exit(1);
