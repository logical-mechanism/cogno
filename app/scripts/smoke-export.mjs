// Drive the BUILT static export the way nginx actually serves it, and assert every route returns the
// app shell. Run after `npm run build`.
//
// Why this exists: `next dev` is not the shipped artifact. `output: 'export'` is gated to
// NODE_ENV=production (next.config.mjs), so the export path — the `_` SSG shims, the nginx rewrites —
// is NEVER exercised in dev. That is exactly how two Retry buttons shipped calling router.refresh(),
// which does nothing at all under a static export.
//
// The routing below mirrors deploy/nginx/cogno.conf, including the fact that there is NO SPA catch-all:
// /post/<id>/ and /u/<addr>/ map to their `_` shims and everything else must resolve to a real file.
// Do NOT replace this with `python3 -m http.server` — it has no fallback, would serve the shims' 404s
// as 200s, and the whole check would go vacuously green.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../out", import.meta.url));
const PORT = 8099;

const TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
};

/** nginx `try_files`: first candidate that exists wins. */
async function tryFiles(candidates) {
  for (const c of candidates) {
    try {
      return { body: await readFile(join(ROOT, c)), path: c };
    } catch {
      /* next candidate */
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let hit;
  if (/^\/post\/[^/]+\/?$/.test(p)) hit = await tryFiles(["/post/_/index.html"]);
  else if (/^\/u\/[^/]+\/?$/.test(p)) hit = await tryFiles(["/u/_/index.html"]);
  else hit = await tryFiles([p, `${p}/index.html`, `${p}.html`]);

  if (!hit) {
    res.writeHead(404, { "content-type": "text/html" });
    res.end((await tryFiles(["/404.html"]))?.body ?? "404");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(hit.path)] ?? "application/octet-stream" });
  res.end(hit.body);
});

const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CASES = [
  ["/", 200],
  ["/explore/", 200],
  ["/compose/", 200],
  ["/notifications/", 200],
  ["/bookmarks/", 200],
  ["/settings/", 200],
  ["/welcome/", 200],
  ["/post/1/", 200], // the SSG shim + nginx rewrite — never exercised by `next dev`
  [`/u/${SS58}/`, 200], // ditto
  ["/this-route-does-not-exist/", 404], // proves the server is not blanket-200ing (a vacuous pass)
];

await new Promise((r) => server.listen(PORT, r));

let failed = 0;
for (const [path, want] of CASES) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  const ok = res.status === want;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${path.padEnd(52)} ${res.status}${ok ? "" : ` (want ${want})`}`);
}

// A 200 is not enough — assert the shell HTML actually came back on the rewritten route.
const shell = await (await fetch(`http://127.0.0.1:${PORT}/post/1/`)).text();
if (!shell.includes("<body")) {
  console.log("  FAIL  /post/1/ returned no app shell");
  failed++;
}

server.close();

if (failed > 0) {
  console.error(`\nsmoke FAILED (${failed})`);
  process.exit(1);
}
console.log("\nsmoke ok — the built export serves every route under the nginx rewrites.");
