"use client";

// useNestedQuote — a session-lived, shared cache mapping an embedded post id to the id of the post IT
// quotes, so a quote-of-a-quote renders its "Quoted post →" pill. The seam's one-level `quoted` summary
// drops the inner post's own `quote` field, so a quote-of-a-quote is indistinguishable from a plain
// quote until this one extra keyed read.
//
// TWO THINGS HERE ARE LOAD-BEARING, and both are why the shared factory is written the way it is:
//
//   • `null` IS A SUCCESSFUL READ — it means "this post quotes nothing", which is true of MOST posts.
//     The failure sentinel is the result envelope, never the value. A cache that treated a null value
//     as a miss would re-read every non-quoting post forever: a read storm across the whole timeline.
//
//   • post id `0n` IS VALID AND FALSY. Every guard tests `!== undefined`, never truthiness.
//
// A post's `quote` is immutable, so this cache never goes stale.
//
// ERROR POLICY = retry (a failed read is re-fetched when an embed for that id next mounts).

import { createChainCache } from "./createChainCache";
import { readPostQuoteId } from "@/lib/chain/reads";

const cache = createChainCache<bigint, bigint | null>({
  name: "NestedQuote",
  toKey: (id) => String(id),
  read: (api, id) => readPostQuoteId(api, id),
  onError: { mode: "retry" },
});

export const NestedQuoteProvider = cache.Provider;

/** The id of the post that `id` itself quotes, or `null` when it quotes nothing / is still loading. */
export function useNestedQuote(id: bigint | undefined): bigint | null {
  return cache.useValue(id);
}
