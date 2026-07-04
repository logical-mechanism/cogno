// The write path: submit a post, surfaced as an honest phase stream.
//
// Honesty is a product property here: "signed" ≠ "broadcast" ≠ "inBestBlock" ≠ "finalized".
// The UI must be able to say exactly where a tx is, and never claim "posted" before the tx
// is actually in a block — and never claim "permanent" before GRANDPA finalization.
//
// There is no delete: posts are permanent on-chain (the `Microblog.delete_post` call was removed
// at spec 113 — "content is permanent"), so the client offers no delete affordance.

import { Binary } from "polkadot-api";
import { Observable } from "rxjs";
import { takeNonce, settleNonce } from "@/lib/chain/nonce";
import type { CognoApi, PostingSigner, TxUpdate } from "@/lib/types";

/** A PAPI transaction we can sign + watch, with the client-managed nonce we override. */
export interface SignableTx {
  signSubmitAndWatch(signer: unknown, options?: { nonce?: number }): unknown;
}

/** One event emitted by `signSubmitAndWatch` (the subset of fields we read). */
interface TxWatchEvent {
  type: "signed" | "broadcasted" | "txBestBlocksState" | "finalized";
  txHash?: string;
  found?: boolean;
  ok?: boolean;
  block?: { number: number; hash: string; index: number };
  events?: ChainEvent[];
  dispatchError?: { type: string; value: unknown };
}

/** A decoded runtime event from a tx's events array. */
interface ChainEvent {
  type: string;
  value: { type: string; value: Record<string, unknown> };
}

/**
 * Extract the post id carried by a Microblog `PostCreated` event, if present.
 * Returns undefined when the events array has no matching Microblog event (e.g. a failed tx).
 * Exported for unit tests (the id extraction is load-bearing for the inBestBlock/finalized phases).
 */
export function extractPostId(
  events: ChainEvent[] | undefined,
  eventName?: "PostCreated",
): bigint | undefined {
  // Only `PostCreated` carries a new id. vote/repost/follow/clear pass no event name (the id is
  // already known to the caller), so there is nothing to extract.
  if (!eventName) return undefined;
  if (!events) return undefined;
  for (const ev of events) {
    if (ev.type === "Microblog" && ev.value?.type === eventName) {
      const id = ev.value.value?.id;
      if (typeof id === "bigint") return id;
    }
  }
  return undefined;
}

/** Best-effort dispatchError → human string, so failures are surfaced rather than swallowed. */
export function stringifyDispatchError(
  err: { type: string; value: unknown } | undefined,
): string {
  if (!err) return "Transaction failed (no dispatch error reported).";
  try {
    // `value` is typically a nested { type, value } module-error shape; JSON-stringify with a
    // bigint-safe replacer so we never throw on a u64-bearing error value.
    const detail = JSON.stringify(
      err.value,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    return detail && detail !== "{}" && detail !== "null"
      ? `${err.type}: ${detail}`
      : err.type;
  } catch {
    return err.type;
  }
}

/** Best-effort thrown-error → message (signer rejection, network drop, capacity gate, etc.). */
export function stringifyError(err: unknown): string {
  let raw: string;
  if (err instanceof Error) raw = err.message;
  else {
    try {
      raw = typeof err === "string" ? err : JSON.stringify(err, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
      raw = String(err);
    }
  }
  // The feeless-post spam gate (CheckCapacity → ExhaustsResources). The composer gates this
  // proactively via the rate-limit pre-flight (no battery), so this is the rare race; surface
  // the same Twitter-style rate-limit line.
  if (/ExhaustsResources/i.test(raw)) {
    return "You are over the rate limit. Try again shortly.";
  }
  return raw || "Transaction failed.";
}

/**
 * Map a `signSubmitAndWatch` stream into the shared TxUpdate phase stream.
 *
 * Phase mapping (verified event sequence):
 *   "signed"            -> { phase: "signing" }            (key approved, not yet on the wire)
 *   "broadcasted"       -> { phase: "broadcast" }          (sent to peers, not yet in a block)
 *   "txBestBlocksState" found:true  ok:true  -> { phase: "inBestBlock", blockNumber, txHash, postId }
 *                        found:true  ok:false -> { phase: "invalid", error }     (included but dispatch-failed)
 *                        found:false          -> (ignored: dropped from best chain, may re-include)
 *   "finalized"         ok:true  -> { phase: "finalized", finalized:true, blockNumber, txHash, postId }
 *                        ok:false -> { phase: "error", error }
 * Any thrown error (signer rejection / network) -> { phase: "error", error }.
 *
 * Exported for unit tests: the phase ordering (and the silent-skip of dropped best-block
 * states) is load-bearing for the honest tx lifecycle.
 */
export function watchTx(
  submit: () => { subscribe: (o: {
    next: (e: TxWatchEvent) => void;
    error: (err: unknown) => void;
    complete: () => void;
  }) => { unsubscribe: () => void } },
  eventName?: "PostCreated",
  fallbackId?: bigint,
): Observable<TxUpdate> {
  return new Observable<TxUpdate>((subscriber) => {
    let inner: { unsubscribe: () => void } | undefined;
    try {
      inner = submit().subscribe({
        next(e: TxWatchEvent) {
          switch (e.type) {
            case "signed":
              subscriber.next({ phase: "signing", txHash: e.txHash });
              break;
            case "broadcasted":
              subscriber.next({ phase: "broadcast", txHash: e.txHash });
              break;
            case "txBestBlocksState": {
              if (!e.found) {
                // Dropped from the best chain (may be re-included in a later block).
                // Stay quiet rather than emit a misleading phase.
                break;
              }
              if (e.ok) {
                subscriber.next({
                  phase: "inBestBlock",
                  blockNumber: e.block?.number,
                  txHash: e.txHash,
                  postId: extractPostId(e.events, eventName) ?? fallbackId,
                });
              } else {
                subscriber.next({
                  phase: "invalid",
                  blockNumber: e.block?.number,
                  txHash: e.txHash,
                  error: stringifyDispatchError(e.dispatchError),
                });
              }
              break;
            }
            case "finalized": {
              if (e.ok) {
                subscriber.next({
                  phase: "finalized",
                  finalized: true,
                  blockNumber: e.block?.number,
                  txHash: e.txHash,
                  postId: extractPostId(e.events, eventName) ?? fallbackId,
                });
              } else {
                subscriber.next({
                  phase: "error",
                  blockNumber: e.block?.number,
                  txHash: e.txHash,
                  error: stringifyDispatchError(e.dispatchError),
                });
              }
              break;
            }
            default:
              break;
          }
        },
        error(err: unknown) {
          // Signer rejection, validity error, or network drop — surface honestly AND log it
          // with context so a failed submission is debuggable (the UI only shows the message).
          // eslint-disable-next-line no-console
          console.error(`cogno: ${eventName ?? "tx"} submission failed (stream error):`, stringifyError(err), err);
          subscriber.next({ phase: "error", error: stringifyError(err) });
          subscriber.complete();
        },
        complete() {
          subscriber.complete();
        },
      });
    } catch (err) {
      // Synchronous failure building/signing the tx — log it (a thrown tx-build error is
      // otherwise invisible beyond the one-line message the UI renders).
      // eslint-disable-next-line no-console
      console.error(`cogno: ${eventName ?? "tx"} submission threw while building/signing:`, stringifyError(err), err);
      subscriber.next({ phase: "error", error: stringifyError(err) });
      subscriber.complete();
    }

    return () => {
      inner?.unsubscribe();
    };
  });
}

/**
 * Sign + submit + watch a tx with a client-MANAGED nonce (see lib/chain/nonce). Every signed write
 * goes through here so rapid sequential writes from the same key get monotonic nonces instead of
 * colliding on PAPI's finalized-block default (which yields `Invalid: Stale`). Reserves a nonce, wires
 * the phase stream, and releases the nonce once the tx reaches any terminal phase (or on unsubscribe).
 */
export function signSubmitWatch(
  api: CognoApi,
  signer: PostingSigner,
  tx: SignableTx,
  eventName?: "PostCreated",
  fallbackId?: bigint,
): Observable<TxUpdate> {
  return new Observable<TxUpdate>((subscriber) => {
    let innerSub: { unsubscribe: () => void } | undefined;
    let cancelled = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      settleNonce(signer.ss58);
    };

    takeNonce(api, signer.ss58)
      .then((nonce) => {
        if (cancelled) {
          // The teardown's guarded settle() already ran (clamped at 0, a no-op) BEFORE takeNonce
          // resolved and did its `inflight += 1`. settle() here can't release that slot (settled is
          // tripped), so decrement directly — otherwise inflight sticks at ≥1, settleNonce never hits 0,
          // and next never resets to re-sync from chain.
          settleNonce(signer.ss58);
          return;
        }
        const inner$ = watchTx(
          // PAPI v2: TxOptions.at is a pinned block-HASH only (no "best"/"finalized"); passing "best"
          // now throws at runtime. Drop it — the extrinsic builds against the latest block; the
          // client-managed `nonce` (still passed) is what keeps rapid sequential writes from colliding.
          () =>
            tx.signSubmitAndWatch(signer.signer, { nonce }) as unknown as ReturnType<
              Parameters<typeof watchTx>[0]
            >,
          eventName,
          fallbackId,
        );
        innerSub = inner$.subscribe({
          next: (u) => {
            subscriber.next(u);
            // First terminal phase releases the reserved nonce (best-block/invalid/finalized = the
            // nonce is consumed; error = usually not, but freeing our in-flight slot is still correct).
            if (
              u.phase === "inBestBlock" ||
              u.phase === "invalid" ||
              u.phase === "finalized" ||
              u.phase === "error"
            ) {
              settle();
            }
          },
          error: (e) => {
            settle();
            subscriber.error(e);
          },
          complete: () => {
            settle();
            subscriber.complete();
          },
        });
      })
      .catch((e: unknown) => {
        settle();
        subscriber.next({ phase: "error", error: stringifyError(e) });
        subscriber.complete();
      });

    return () => {
      cancelled = true;
      innerSub?.unsubscribe();
      settle();
    };
  });
}

/**
 * Submit a new post (optionally as a reply to `parent`). Emits the full honest phase stream
 * from signing through finalization; on success the `postId` of the created post is attached
 * as soon as it lands in a best block.
 */
export function submitPost(
  api: CognoApi,
  signer: PostingSigner,
  text: string,
  parent?: bigint,
): Observable<TxUpdate> {
  const tx = api.tx.Microblog.post_message({
    text: Binary.fromText(text),
    parent,
  });
  return signSubmitWatch(api, signer, tx as unknown as SignableTx, "PostCreated");
}

