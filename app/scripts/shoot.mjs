// Screenshot routes of the BUILT export at one or more viewports.
//
//   node scripts/shoot.mjs /governance/
//   node scripts/shoot.mjs / /explore/ --v mobile,feed,desktop
//   node scripts/shoot.mjs /settings/ --signed-in --out /tmp/shots
//   node scripts/shoot.mjs /settings/ --as 5Hmr…MGei --ws ws://127.0.0.1:9944   # a BOUND account
//   node scripts/shoot.mjs /post/1/ --ws ws://127.0.0.1:9944 --full
//   node scripts/shoot.mjs / --ws ws://127.0.0.1:9944 --settle    # real posts, not skeletons
//
// USE --settle FOR ANY CHAIN-BACKED SURFACE. Without it the capture is taken at first paint, which on a
// feed / thread / profile / poll is the shimmer placeholder — and a screenshot of a skeleton reads as a
// real loading state, so nothing about it says the shot was useless. It needs --ws too: with no endpoint
// the surface stays legitimately busy and the wait just burns its timeout (reported, never fatal).
//
// For LOOKING at a change, not for asserting one. Assertions belong in check-overflow.mjs or a real
// test, because a screenshot only fails when somebody opens it. This exists because CSS work was
// otherwise unverifiable here: vitest runs in a `node` environment so components cannot be rendered,
// and the alternative was reasoning about layout from font metrics.
//
// Run `npm run build` first. It shoots the export, never `next dev` — see lib/export-server.mjs.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startExportServer, exportExists } from "./lib/export-server.mjs";
import { launch, newContext, openPage, parseViewports } from "./lib/browser.mjs";

function parseArgs(argv) {
  const paths = [];
  const opts = {
    out: null,
    viewports: null,
    signedIn: false,
    ws: null,
    ss58: null,
    full: false,
    settle: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--v" || a === "--viewports") opts.viewports = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--ws") opts.ws = argv[++i];
    // Implies --signed-in: naming the account you want to be is not a separate wish from being it.
    else if (a === "--as") {
      opts.ss58 = argv[++i];
      opts.signedIn = true;
    } else if (a === "--signed-in") opts.signedIn = true;
    else if (a === "--full") opts.full = true;
    else if (a === "--settle") opts.settle = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else paths.push(a.startsWith("/") ? a : `/${a}`);
  }
  if (paths.length === 0) paths.push("/");
  return { paths, opts };
}

const { paths, opts } = parseArgs(process.argv.slice(2));
const viewports = parseViewports(opts.viewports);
// Default under the OS temp dir rather than into the repo: these are throwaway artifacts and must
// never be mistaken for something to commit.
const outDir = opts.out ?? join(process.env.TMPDIR ?? "/tmp", "cogno-shots");

if (!(await exportExists())) {
  console.error("no export in app/out. Run `npm run build` first.");
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
const server = await startExportServer();
const browser = await launch();

const written = [];
for (const viewport of viewports) {
  const context = await newContext(browser, viewport, {
    signedIn: opts.signedIn,
    ws: opts.ws,
    ss58: opts.ss58 ?? undefined,
  });
  for (const path of paths) {
    const { page, errors, settled } = await openPage(context, server.origin, path, {
      settle: opts.settle,
    });
    const slug = path.replace(/^\/|\/$/g, "").replace(/[^a-z0-9]+/gi, "-") || "home";
    const file = join(outDir, `${slug}.${viewport.name}.png`);
    await page.screenshot({ path: file, fullPage: opts.full });
    written.push({ file, path, viewport: viewport.name, errors, settled });
    await page.close();
  }
  await context.close();
}

await browser.close();
await server.close();

for (const w of written) {
  console.log(`  ${w.viewport.padEnd(8)} ${w.path.padEnd(28)} ${w.file}`);
  // Surfaced rather than swallowed: a page that threw during hydration still screenshots, and the
  // image looks plausible, so a silent error here is exactly how a broken surface reads as fine.
  for (const e of w.errors) console.log(`      page error: ${e.split("\n")[0]}`);
  // Same reasoning for the wait: an unsettled shot is a skeleton, and it does not look like one.
  if (w.settled && !w.settled.ok) {
    console.log(`      did not settle after ${w.settled.ms}ms — ${w.settled.reason}`);
  }
}
console.log(`\n${written.length} shot(s) in ${outDir}`);
