// Shared, dependency-free network helpers for the cogno-chain off-chain services (themes 3/4 of
// PRODUCTION-HARDENING.md). Uses only Node v22 globals (fetch, AbortController) so it imports cleanly
// from any service regardless of its node_modules. The Python follower has its own equivalent
// (_rpc_json) — same pattern, different runtime.

/// Hardened JSON fetch: validates res.ok + that the body is JSON, applies an AbortController timeout,
/// and retries with bounded exponential backoff. A transient/HTML-error response must NOT silently
/// become `undefined` and drive a privileged write or a confirmation decision. Throws after `retries`.
export async function fetchJson(url, { method = "GET", body = null, headers = {}, timeoutMs = 10_000, retries = 3, backoffMs = 500 } = {}) {
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
			if (attempt < retries) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(`fetchJson ${url} failed after ${retries} attempts: ${last?.message || last}`);
}
