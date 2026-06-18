// Shared, dependency-free observability helpers for the cogno-chain off-chain services (prod-readiness
// Phase 2). prom-client is NOT in the services' node_modules, so we hand-roll the tiny slice of the
// Prometheus text-exposition format we need (gauges + counters) using only Node v22 builtins — same
// philosophy as net.mjs / paths.mjs. The Python follower has its own equivalent.

import http from "node:http";

// Escape a Prometheus label VALUE per the exposition format (backslash, double-quote, newline).
const escapeLabel = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

// PURE: render the Prometheus text-exposition format from a list of samples. Each sample is
// { name, value, help?, type?, labels? }. `# HELP`/`# TYPE` are emitted once per metric name (the
// first sample that carries them). Samples whose value is null/undefined/NaN are SKIPPED (a metric we
// could not compute this scrape — e.g. wallet balance during a Kupo blip — is omitted, not zeroed,
// so an alert never misreads "unknown" as "0"). BigInt values are rendered losslessly.
export function renderPrometheus(samples) {
	const declared = new Set();
	const out = [];
	for (const s of samples) {
		if (!s || s.name == null) continue;
		const v = s.value;
		if (v == null) continue;
		if (typeof v !== "bigint" && Number.isNaN(Number(v))) continue;
		if (!declared.has(s.name)) {
			if (s.help) out.push(`# HELP ${s.name} ${s.help}`);
			out.push(`# TYPE ${s.name} ${s.type || "gauge"}`);
			declared.add(s.name);
		}
		const labels = s.labels && Object.keys(s.labels).length
			? "{" + Object.entries(s.labels).map(([k, lv]) => `${k}="${escapeLabel(lv)}"`).join(",") + "}"
			: "";
		out.push(`${s.name}${labels} ${typeof v === "bigint" ? v.toString() : Number(v)}`);
	}
	return out.join("\n") + "\n";
}

// Start a tiny observability HTTP server. `routes` maps a path (e.g. "/metrics", "/healthz") to a
// handler returning { code?, contentType?, body? }. A handler may throw → 500. Unknown path → 404.
// Binds 127.0.0.1 by default (put it behind your scrape network/proxy, not the public internet) and
// is unref()'d so it never keeps the process alive on its own. Returns the http.Server.
export function startMetricsServer({ port, host = "127.0.0.1", routes = {} }) {
	const server = http.createServer((req, res) => {
		const path = (req.url || "/").split("?")[0];
		const handler = routes[path];
		if (typeof handler !== "function") {
			res.writeHead(404, { "content-type": "text/plain" });
			return res.end("not found\n");
		}
		try {
			const { code = 200, contentType = "text/plain; version=0.0.4", body = "" } = handler() || {};
			res.writeHead(code, { "content-type": contentType });
			res.end(body);
		} catch (e) {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end(`error: ${e?.message || e}\n`);
		}
	});
	// A bind failure (port in use) must not crash the service — observability is best-effort.
	server.on("error", (e) => console.error(`  ⚠ metrics server (:${port}) error: ${e?.message || e} — continuing without it.`));
	server.listen(port, host, () => console.log(`metrics  : http://${host}:${port}/metrics   health: /healthz`));
	server.unref();
	return server;
}
