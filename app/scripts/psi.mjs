#!/usr/bin/env node
// psi — a PageSpeed Insights sweep of the deployed frontend.
//
//   npm run psi                          # 7 guest routes x mobile+desktop x 3 runs
//   npm run psi -- --runs 5              # more samples (see the note on variance below)
//   npm run psi -- --label after         # name the run; a second one can be diffed against it
//   npm run psi -- --urls https://cogno.forum/legal/
//   npm run psi -- --origin http://localhost:3000   # a local `serve out` instead of production
//
// WHY MEDIANS OF N. A Lighthouse lab run on this site is genuinely noisy: the home page has scored 93,
// 83 and 64 on three consecutive runs of the SAME deployed bytes. A single number cannot tell a real
// change from that spread, so every route is run N times and the report prints the median plus the
// min-max range. Read the range before believing a delta. CLS is the exception — it comes back stable
// to three decimals — so it is the metric to trust for a before/after.
//
// WHAT THIS CAN AND CANNOT SEE. PageSpeed's sandbox does not proxy WebSockets, so the chain connection
// always fails and no post ever renders. Two consequences worth knowing before acting on a report:
//   • `errors-in-console` can never pass. Every error it collects is the browser's own
//     "WebSocket connection to wss://... failed", none originate in app code, and the audit fails on
//     any error at all. best-practices is therefore capped at 96 here and reaches 100 the moment a
//     real socket connects. Do not "fix" it by throttling PAPI's reconnect.
//   • Anything measured on a chain-backed route is measuring the app's EMPTY state. Real-user CLS in
//     particular is higher than what this reports, because the skeleton-to-content swap that PSI never
//     triggers is a bigger shift than anything it does see.
//
// THE KEY. PAGESPEED_API_KEY, read from app/.env.local or the repo-root .env, or the environment.
// Anonymous calls to the API are rate-limited to the point of uselessness (it answers 429). It is
// deliberately NOT a NEXT_PUBLIC_ var: this runs in node and the key must never reach the bundle.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(APP, "..");

/**
 * The guest-visible surface. PageSpeed is always signed out, so the walled routes (compose, settings,
 * notifications) would only ever measure the /welcome bounce and are left out.
 *
 * The two dynamic routes are safe to pin: this chain has no delete, so post 0 and the account that
 * authored it are permanent. They are here because they are the heavy case — a thread and a profile
 * are where the layout work actually happens, and both carried the site's worst CLS.
 */
const ROUTES = ["/", "/explore/", "/governance/", "/post/0/", "/u/5HW7Gaq1ecLb7TJgupJfPkVXS9D24uabHAjLSAKQn5teCiQS/", "/welcome/", "/legal/"];

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const METRICS = [
  ["first-contentful-paint", "FCP"],
  ["largest-contentful-paint", "LCP"],
  ["total-blocking-time", "TBT"],
  ["cumulative-layout-shift", "CLS"],
  ["speed-index", "SI"],
];

// ---------------------------------------------------------------- config

function loadKey() {
  if (process.env.PAGESPEED_API_KEY) return process.env.PAGESPEED_API_KEY;
  for (const p of [join(APP, ".env.local"), join(REPO, ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?PAGESPEED_API_KEY\s*=\s*(.*)$/.exec(line);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  console.error(
    "PAGESPEED_API_KEY not found.\n" +
      "  Get a key: https://developers.google.com/speed/docs/insights/v5/get-started\n" +
      "  Then add it to app/.env.local or the repo-root .env (both gitignored):\n" +
      "      PAGESPEED_API_KEY=...\n" +
      "  Do NOT prefix it NEXT_PUBLIC_ — that would inline it into the shipped bundle.",
  );
  process.exit(1);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const KEY = loadKey();
const LABEL = arg("label", "run");
const RUNS = Math.max(1, Number(arg("runs", "3")) || 3);
const ORIGIN = arg("origin", "https://cogno.forum").replace(/\/$/, "");
const STRATEGIES = arg("strategy", "mobile,desktop").split(",").filter(Boolean);
const urlArg = arg("urls", "").split(",").filter(Boolean);
const URLS = urlArg.length ? urlArg : ROUTES.map((r) => ORIGIN + r);
const OUTDIR = join(arg("out", join(tmpdir(), "cogno-psi")), LABEL);

mkdirSync(OUTDIR, { recursive: true });

const slug = (url, strategy) =>
  `${url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "_").replace(/_+$/, "")}__${strategy}`;

// ---------------------------------------------------------------- fetching

async function runOne(url, strategy, run, attempt = 1) {
  const q = new URLSearchParams({ url, strategy, key: KEY });
  for (const c of CATEGORIES) q.append("category", c);

  try {
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, {
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    const json = JSON.parse(body);
    if (json.lighthouseResult?.runtimeError?.code) {
      throw new Error(`runtimeError ${json.lighthouseResult.runtimeError.code}`);
    }
    writeFileSync(join(OUTDIR, `${slug(url, strategy)}__r${run}.json`), JSON.stringify(json));
    return { url, strategy, run, json };
  } catch (err) {
    // The API throttles hard and Lighthouse itself is flaky; three tries with a widening backoff.
    if (attempt >= 3) return { url, strategy, run, error: String(err.message || err) };
    await new Promise((r) => setTimeout(r, 5000 * attempt));
    return runOne(url, strategy, run, attempt + 1);
  }
}

/** Bounded concurrency: the API tolerates a few in flight, not 42. */
async function pool(jobs, size) {
  const out = [];
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        const r = await jobs[i]();
        out[i] = r;
        done++;
        const where = `${new URL(r.url).pathname} [${r.strategy}] r${r.run}`;
        console.error(`  ${r.error ? "x" : "+"} (${done}/${jobs.length}) ${where}${r.error ? ` - ${r.error}` : ""}`);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- report

const median = (xs) => {
  const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctOf = (v) => (v == null ? " - " : String(Math.round(v * 100)).padStart(3));
const rangeOf = (xs) => {
  const s = xs.filter((x) => x != null).map((x) => Math.round(x * 100)).sort((a, b) => a - b);
  return s.length > 1 ? `${s[0]}-${s[s.length - 1]}` : "";
};
const shortPath = (u) => new URL(u).pathname.replace(/^(.{18}).*/, "$1…");

function report(results) {
  const groups = new Map();
  for (const r of results) {
    const k = `${r.url}|${r.strategy}`;
    if (!groups.has(k)) groups.set(k, { url: r.url, strategy: r.strategy, runs: [] });
    groups.get(k).runs.push(r);
  }

  console.log(`\n${"=".repeat(88)}\nPSI "${LABEL}" - ${ORIGIN} - median of ${RUNS} run(s)\nraw: ${OUTDIR}\n${"=".repeat(88)}`);
  console.log("\nSCORES (median, min-max in brackets)\n" + "-".repeat(88));
  console.log("route".padEnd(20) + "strat".padEnd(9) + "perf".padEnd(15) + "a11y".padEnd(9) + "best".padEnd(9) + "seo");

  const summary = [];
  for (const g of groups.values()) {
    const ok = g.runs.filter((r) => !r.error);
    if (!ok.length) {
      console.log(shortPath(g.url).padEnd(20) + g.strategy.padEnd(9) + `ALL RUNS FAILED: ${String(g.runs[0].error).slice(0, 44)}`);
      continue;
    }
    const scoresFor = (c) => ok.map((r) => r.json.lighthouseResult.categories[c]?.score ?? null);
    const row = {
      url: g.url,
      strategy: g.strategy,
      n: ok.length,
      scores: Object.fromEntries(CATEGORIES.map((c) => [c, median(scoresFor(c))])),
      metrics: Object.fromEntries(
        METRICS.map(([id, l]) => [l, median(ok.map((r) => r.json.lighthouseResult.audits[id]?.numericValue ?? null))]),
      ),
    };
    summary.push(row);
    console.log(
      shortPath(g.url).padEnd(20) +
        g.strategy.padEnd(9) +
        `${pctOf(row.scores.performance)} (${rangeOf(scoresFor("performance"))})`.padEnd(15) +
        pctOf(row.scores.accessibility).padEnd(9) +
        pctOf(row.scores["best-practices"]).padEnd(9) +
        pctOf(row.scores.seo),
    );
  }

  console.log("\nCORE METRICS (median)\n" + "-".repeat(88));
  console.log("route".padEnd(20) + "strat".padEnd(9) + METRICS.map(([, l]) => l.padEnd(11)).join(""));
  for (const r of summary) {
    const fmt = (l, v) =>
      v == null ? "-" : l === "CLS" ? v.toFixed(3) : l === "TBT" ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`;
    console.log(
      shortPath(r.url).padEnd(20) + r.strategy.padEnd(9) + METRICS.map(([, l]) => fmt(l, r.metrics[l]).padEnd(11)).join(""),
    );
  }

  // Tallied across every run, so a flaky audit is visibly flaky rather than looking definitive.
  const tally = new Map();
  const total = results.filter((r) => !r.error).length;
  for (const r of results) {
    if (r.error) continue;
    for (const [id, a] of Object.entries(r.json.lighthouseResult.audits)) {
      if (a.score === null || a.score >= 0.9) continue;
      const t = tally.get(id) || { n: 0, ms: 0, kb: 0 };
      t.n++;
      t.ms = Math.max(t.ms, a.details?.overallSavingsMs || 0);
      t.kb = Math.max(t.kb, (a.details?.overallSavingsBytes || 0) / 1024);
      tally.set(id, t);
    }
  }
  console.log(`\nFAILING AUDITS (runs affected / ${total})\n` + "-".repeat(88));
  for (const [id, t] of [...tally].sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `${String(t.n).padStart(3)}/${total}  ${id.padEnd(44)}` +
        `${t.ms ? `~${Math.round(t.ms)}ms ` : ""}${t.kb ? `~${Math.round(t.kb)}KiB` : ""}`,
    );
  }

  writeFileSync(join(OUTDIR, "_summary.json"), JSON.stringify({ label: LABEL, origin: ORIGIN, runs: RUNS, summary }, null, 2));
  console.log(`\nsummary: ${join(OUTDIR, "_summary.json")}`);
}

// ---------------------------------------------------------------- main

console.error(`PSI "${LABEL}": ${URLS.length} route(s) x ${STRATEGIES.length} strategy(ies) x ${RUNS} run(s) = ${URLS.length * STRATEGIES.length * RUNS} calls`);
const jobs = [];
for (let run = 1; run <= RUNS; run++) for (const url of URLS) for (const s of STRATEGIES) jobs.push(() => runOne(url, s, run));
const results = await pool(jobs, 3);
report(results);

const failed = results.filter((r) => r.error).length;
if (failed) {
  console.error(`\n${failed}/${results.length} call(s) failed after retries.`);
  process.exit(1);
}
