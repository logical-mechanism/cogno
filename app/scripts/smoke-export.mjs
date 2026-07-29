// Drive the BUILT static export the way nginx actually serves it, and assert every route returns the
// app shell. Run after `npm run build`.
//
// Why this exists: `next dev` is not the shipped artifact. `output: 'export'` is gated to
// NODE_ENV=production (next.config.mjs), so the export path — the `_` SSG shims, the nginx rewrites —
// is NEVER exercised in dev. That is exactly how two Retry buttons shipped calling router.refresh(),
// which does nothing at all under a static export.
//
// The SERVER now lives in scripts/lib/export-server.mjs, shared with the browser harness (scripts/
// shoot.mjs, e2e/). It is shared rather than copied because the routing is the thing under test: a
// second harness with its own static server would be checking a routing production does not have.

import { startExportServer, exportExists } from "./lib/export-server.mjs";

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CASES = [
  ["/", 200],
  ["/explore/", 200],
  ["/compose/", 200],
  ["/notifications/", 200],
  // The two device-local surfaces. Both are in PUBLIC_SEGMENTS (a guest reaches them without signing
  // in), so an export that stopped emitting either is a 404 for a logged-out visitor, not a bounce.
  ["/bookmarks/", 200],
  ["/lists/", 200],
  ["/settings/", 200],
  ["/welcome/", 200],
  // The three static documents. /policy is the abuse/report surface and is the ONLY in-product path to
  // the operator, so an export that silently stopped emitting it would be a real outage of a real
  // obligation, invisible to every other gate.
  ["/legal/", 200],
  ["/privacy/", 200],
  ["/policy/", 200],
  ["/post/1/", 200], // the SSG shim + nginx rewrite — never exercised by `next dev`
  [`/u/${SS58}/`, 200], // ditto
  ["/this-route-does-not-exist/", 404], // proves the server is not blanket-200ing (a vacuous pass)
];

if (!(await exportExists())) {
  console.error("smoke FAILED — no export in app/out. Run `npm run build` first.");
  process.exit(1);
}

// 8099 stays pinned here (not the module's default free port) so the log line is stable and an operator
// can curl the same address the check used while it is running.
const server = await startExportServer({ port: 8099 });

let failed = 0;
for (const [path, want] of CASES) {
  const res = await fetch(`${server.origin}${path}`);
  const ok = res.status === want;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${path.padEnd(52)} ${res.status}${ok ? "" : ` (want ${want})`}`);
}

// A 200 is not enough — assert the shell HTML actually came back on the rewritten route.
const shell = await (await fetch(`${server.origin}/post/1/`)).text();
if (!shell.includes("<body")) {
  console.log("  FAIL  /post/1/ returned no app shell");
  failed++;
}

await server.close();

if (failed > 0) {
  console.error(`\nsmoke FAILED (${failed})`);
  process.exit(1);
}
console.log("\nsmoke ok — the built export serves every route under the nginx rewrites.");
