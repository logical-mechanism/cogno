// Shared, dependency-free network helpers for the cogno-chain off-chain services (themes 3/4 of
// PRODUCTION-HARDENING.md). Uses only Node v22 globals (fetch, AbortController) so it imports cleanly
// from any service regardless of its node_modules. The Python follower has its own equivalent
// (_rpc_json) — same pattern, different runtime.

// Default sleep used between retry attempts. Injectable via the `sleep` option purely so the unit
// tests can capture the backoff SCHEDULE without burning real wall-clock; production always uses this.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Render an error for human-readable logs/messages. An Error with an empty message (e.g. `new Error("")`)
// would otherwise render as a blank string ("failed after 3 attempts: "), which is useless to an
// operator — fall back to the constructor name / String() so the message is never empty (gap 8).
const describeError = (e) => {
	if (e == null) return "unknown error";
	if (e instanceof Error) return e.message || e.name || e.toString();
	return String(e);
};

// AbortController-based timeouts surface as a DOMException named "AbortError" (or, on some paths, an
// Error whose name is "AbortError"). Detect both so a slow/dead endpoint is logged as a TIMEOUT rather
// than an opaque "fetch failed" — operators need to tell a hung Ogmios/Kupo apart from an HTTP 500.
const isAbort = (e) => e != null && (e.name === "AbortError" || e.code === "ABORT_ERR");

/// Hardened JSON fetch: validates res.ok + that the body is JSON, applies an AbortController timeout,
/// and retries with bounded exponential backoff. A transient/HTML-error response must NOT silently
/// become `undefined` and drive a privileged write or a confirmation decision. Throws after `retries`.
/// Logs each failed attempt at warn level (attempt N/total, reason, backoff) and throws a final error
/// carrying full context (url, attempts, last error stack) so failures are debuggable in production.
export async function fetchJson(url, { method = "GET", body = null, headers = {}, timeoutMs = 10_000, retries = 3, backoffMs = 500, sleep = realSleep } = {}) {
	let last;
	for (let attempt = 1; attempt <= retries; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, { method, body, headers, signal: ctrl.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			const text = await res.text();
			const ct = res.headers.get("content-type") || "";
			const looksJson = ct.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[");
			if (!looksJson) throw new Error(`non-JSON response (content-type ${ct || "?"}): ${text.slice(0, 120)}`);
			return JSON.parse(text);
		} catch (e) {
			last = e;
			// Distinguish a timeout/abort (slow or dead endpoint) from any other failure (HTTP error,
			// malformed JSON, DNS, …) so logs point operators straight at the cause (gaps 5/11).
			const reason = isAbort(e) ? `timeout after ${timeoutMs}ms` : describeError(e);
			if (attempt < retries) {
				const backoff = backoffMs * 2 ** (attempt - 1);
				console.warn(`  ⚠ fetchJson ${url} attempt ${attempt}/${retries} failed (${reason}) — retrying in ${backoff}ms`);
				await sleep(backoff);
			} else {
				console.warn(`  ⚠ fetchJson ${url} attempt ${attempt}/${retries} failed (${reason}) — no retries left`);
			}
		} finally {
			clearTimeout(timer);
		}
	}
	// Final failure: log the FULL stack at error level so it is captured even if the caller swallows the
	// throw. The thrown message carries only the concise reason (timeout / HTTP / parse) — NOT the
	// multi-line stack — so callers that re-wrap it (`new Error('Kupo read failed: ' + e.message)`) don't
	// propagate a giant stack up the chain; the stack lives in the console.error here (gap 6).
	const reason = isAbort(last) ? `timeout after ${timeoutMs}ms` : describeError(last);
	console.error(`  ✗ fetchJson ${url} FAILED after ${retries} attempts: ${last?.stack || reason}`);
	throw new Error(`fetchJson ${url} failed after ${retries} attempts: ${reason}`);
}
