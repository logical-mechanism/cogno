// The BUILT static export, served the way nginx actually serves it.
//
// Extracted from smoke-export.mjs so that everything which drives the export drives the SAME routing.
// That is the whole reason this is a module rather than a copied twenty lines: the routing is the thing
// under test. `next dev` is not the shipped artifact (`output: 'export'` is gated to NODE_ENV=production
// in next.config.mjs), so the `_` SSG shims and the nginx rewrites are never exercised in dev, and a
// second harness with its own naive static server would be checking a routing that production does not
// have. That is how two Retry buttons shipped calling router.refresh(), which does nothing at all under
// a static export.
//
// Mirrors deploy/nginx/cogno.conf, including the fact that there is NO SPA catch-all: /post/<id>/ and
// /u/<addr>/ map to their `_` shims and everything else must resolve to a real file. Do NOT swap this
// for `python3 -m http.server` — it has no fallback, would serve the shims' 404s as 200s, and every
// check built on it would go vacuously green.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

/** The export directory `next build` writes. */
export const OUT_DIR = fileURLToPath(new URL("../../out", import.meta.url));

const TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** nginx `try_files`: first candidate that exists wins. */
async function tryFiles(root, candidates) {
  for (const c of candidates) {
    try {
      return { body: await readFile(join(root, c)), path: c };
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/**
 * Start the export server and resolve once it is listening.
 *
 * Port 0 by default, so callers get a free port from the OS rather than colliding with each other or
 * with whatever the operator has bound. The smoke check pins 8099 for a stable log line; the browser
 * harness does not care and should not fight for a port.
 *
 * @param {{ root?: string, port?: number }} [opts]
 * @returns {Promise<{ origin: string, port: number, close: () => Promise<void> }>}
 */
export async function startExportServer(opts = {}) {
  const root = opts.root ?? OUT_DIR;
  const server = createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let hit;
    if (/^\/post\/[^/]+\/?$/.test(p)) hit = await tryFiles(root, ["/post/_/index.html"]);
    else if (/^\/u\/[^/]+\/?$/.test(p)) hit = await tryFiles(root, ["/u/_/index.html"]);
    else hit = await tryFiles(root, [p, `${p}/index.html`, `${p}.html`]);

    if (!hit) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end((await tryFiles(root, ["/404.html"]))?.body ?? "404");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(hit.path)] ?? "application/octet-stream",
    });
    res.end(hit.body);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Whether the export has actually been built. Every caller needs this check and each one used to fail
 * differently: without it the server answers 404 for everything and the harness reports a page of
 * failures rather than the one fact that matters, which is that nobody ran `npm run build`.
 */
export async function exportExists() {
  try {
    await readFile(join(OUT_DIR, "index.html"));
    return true;
  } catch {
    return false;
  }
}
