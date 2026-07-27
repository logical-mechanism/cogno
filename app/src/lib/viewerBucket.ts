// viewerBucket — the ONE derivation of "which account is the viewer", and therefore of the key every
// device-local store is bucketed under.
//
// WHY THIS EXISTS. `createViewerScopedStore` keys each bucket `<prefix>:<who>` and falls back to
// `<prefix>:anon` when `who` is null, so the store is only as correct as the `who` its callers hand
// it. Thirty-one call sites each re-derived that `who` by hand, and three of them derived it
// DIFFERENTLY — `gate.status === "ready" ? (gate.address ?? null) : null` instead of the bare
// `viewer.address ?? null` every other site used. The two agree only once the CIP-8 bind has
// RESOLVED, and they disagree for the whole window in between:
//
//   • during onboarding, after the derive signature but before the bind, and
//   • on EVERY page load, while `useIdentity` is still resolving `isAccountBound` over a
//     freshly-opened socket (and permanently, for the session, if that read throws).
//
// In that window PostCard, Timeline and PinnedPostBlock read `cg-blocked:anon` / `cg-hidden:anon` /
// `cg-bookmarks:anon` / `cg-lists:anon` while every other surface writes `cg-*:<ss58>`. A block
// landed, the card collapsed, a green toast confirmed it, and the row came back on the next render
// because the filter was asking a different bucket.
//
// THE GUARD IS THE LINT RULE, NOT THIS FILE. Extracting the helper fixes the three sites; the eslint
// `no-restricted-syntax` rule in `eslint.config.mjs` (banning `.status === "ready"` in the same
// ternary as `.address`, everywhere but here) is what stops the thirty-second site re-deriving it.
//
// NOT the write gate. `status === "ready"` is the correct guard for a write AFFORDANCE — whether to
// show "Pin to profile", whether to route a compose intent to /welcome — and it correctly stays on
// `isOwnPost` in PostCard. It is the wrong guard for a bucket key: a bucket is about WHOSE device
// state this is, which is answered by the address alone, and the address is set the moment the
// posting key is derived.

import type { Ss58 } from "@/lib/types";

/**
 * The minimum a viewer needs to expose to be bucketed. Structural on purpose: `Viewer` (components/kit)
 * satisfies it, and so does anything else carrying an optional address, so a caller never has to import
 * the full kit type to key a store.
 */
export interface BucketableViewer {
  address?: Ss58;
}

/**
 * The viewer's ss58, or `null` for signed-out browsing (which `createViewerScopedStore` maps to the
 * `:anon` bucket).
 *
 * The ONLY correct expression for a device-local store's `who`, and the same value every surface uses
 * as "who am I" for viewer-relative chain reads.
 */
export function viewerBucket(v: BucketableViewer | null | undefined): Ss58 | null {
  return v?.address ?? null;
}
