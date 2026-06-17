// A tiny, dependency-free GraphQL client. No Apollo, no codegen — the M4 indexer queries
// are a handful of fixed strings, so a plain `fetch` POST is the honest minimum.
//
// SSG-safe: nothing here touches `window`/`fetch` at module-evaluation time — `gqlRequest`
// is only ever called from effects/handlers in the client bundle. Errors (HTTP failure,
// network/CORS, GraphQL `errors`) all surface as a typed {@link GraphqlError} so the feed
// source can degrade honestly instead of blanking the UI.

/** A GraphQL `{ data, errors }` envelope. */
interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Every failure the GraphQL path can hit, wrapped so callers can tell "the indexer is
 * unreachable / mis-configured" from a real bug. `kind` lets the UI word it honestly.
 */
export class GraphqlError extends Error {
  readonly kind: "network" | "http" | "graphql";
  readonly status?: number;

  constructor(
    message: string,
    kind: "network" | "http" | "graphql",
    status?: number,
  ) {
    super(message);
    this.name = "GraphqlError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * POST a GraphQL query to `endpoint` and return its `data`. Throws {@link GraphqlError} on
 * a network/CORS failure, a non-2xx response, a missing `data`, or any GraphQL `errors`.
 * `signal` lets a watch poll abort an in-flight request when it re-fires or unsubscribes.
 */
export async function gqlRequest<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (err) {
    // Unreachable host, CORS rejection, DNS failure, or an aborted poll.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new GraphqlError(
      `could not reach the indexer at ${endpoint} (${
        err instanceof Error ? err.message : "network error"
      })`,
      "network",
    );
  }

  if (!res.ok) {
    throw new GraphqlError(
      `indexer returned HTTP ${res.status} ${res.statusText}`,
      "http",
      res.status,
    );
  }

  let body: GraphqlEnvelope<T>;
  try {
    body = (await res.json()) as GraphqlEnvelope<T>;
  } catch {
    throw new GraphqlError("indexer returned a non-JSON response", "http", res.status);
  }

  if (body.errors && body.errors.length > 0) {
    throw new GraphqlError(body.errors.map((e) => e.message).join("; "), "graphql");
  }
  if (body.data === undefined || body.data === null) {
    throw new GraphqlError("indexer returned no data", "graphql");
  }
  return body.data;
}
