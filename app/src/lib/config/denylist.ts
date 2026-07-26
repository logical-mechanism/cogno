// The operator's serve lever: what THIS deployment of the frontend declines to render.
//
// POLICY.md has always promised this ("Change what the hosted frontend at cogno.forum shows — the site
// is a client, not the record") and nothing implemented it. There was no blocklist, denylist or
// takedown path anywhere in node/, runtime/, pallets/, deploy/ or app/. Every reader-side lever was
// device-local localStorage that only its own owner ever saw, and the one chain lever, `cogno-gate`'s
// committee `revoke`, is forward-only: it stops the next post and does not touch the ones already
// published. So a report about something illegal had exactly one possible outcome, and it was "the
// account cannot post again". The content stayed on the site.
//
// WHAT THIS IS, EXACTLY
//
// A build-time list, baked into the static export, that the read path omits. It changes what
// https://cogno.forum serves. It does NOT change the chain: every post is still in every block, every
// node still has it, and anyone running their own node or pointing this same app at a different
// endpoint reads the complete record. That is the design, not a limitation of the implementation —
// there is no on-chain moderation and there will not be, because a chain whose operator can rewrite
// history is not a record of anything.
//
// So the honest description of this lever is: the operator can decline to be the one serving it.
// That is a real thing to be able to do, it is what a takedown notice can actually compel, and it is
// meaningfully less than "removed".
//
// SHIPPED EMPTY. Both sets are empty here and in the build, so the decorator short-circuits to the
// identity function and the whole mechanism costs nothing until somebody deliberately populates it.
//
// HOW TO POPULATE
//
// Two build-time env vars, comma-separated, read at `next build` and inlined into the export:
//
//   NEXT_PUBLIC_DENY_AUTHORS=5Grw…utQY,5FHn…9xKp     ss58 addresses (prefix 42)
//   NEXT_PUBLIC_DENY_POSTS=1234,5678                  post ids, decimal
//
// Denying an AUTHOR omits everything of theirs the app reads: their posts, replies, quotes, their
// profile, their rows in search and who-to-follow, and their mentions inside other people's posts.
// Denying a POST omits that one item. Both take effect on the next deploy of the static export, and
// both are reversible by removing the entry and deploying again.
//
// THE LIST IS PUBLIC. A static export inlines it into the JavaScript bundle, so anyone can read it.
// That is the right trade for this project: a secret list of what an operator has quietly stopped
// serving is worse than a visible one, and the chain makes the underlying content trivially findable
// anyway. Do not treat an entry here as confidential.
//
// NOT device-local state. `createViewerScopedStore` and its facades exist for a VIEWER's own choices
// (mutes, blocks, hidden posts, lists), bucketed per account so a shared device does not leak one
// wallet's preferences to the next. This is operator build config and belongs in the same class as
// endpoints.ts, which is why it lives beside it and has no localStorage override: a visitor must not
// be able to edit it in their own browser, in either direction.
//
// SSG-safe: `process.env.NEXT_PUBLIC_*` is referenced LITERALLY so Next can substitute it at build
// time, and nothing here touches `window`.

import { normalizeSs58 } from "@/lib/ss58";

/** An ss58 at prefix 42 is 47-49 base58 chars. Only a shape check — a typo must fail the build. */
const SS58_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{44,49}$/;
/**
 * A post id is a decimal counter (`NextPostId`). No leading zeros: lookups are `DENIED_POSTS.has(String(id))`
 * and `String(1234n)` is "1234", so a pasted "01234" would sit in the set matching nothing at all —
 * a silently ineffective entry, which is the exact failure the validation exists to prevent. "0" itself
 * is a legitimate id and is allowed.
 */
const POST_ID_SHAPE = /^(0|[1-9]\d*)$/;

/** Split a comma-separated env var, trimming and dropping blanks. */
function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Validate an operator-supplied list, failing a PRODUCTION build on a malformed entry.
 *
 * This matters more than it looks. A denylist that silently drops a typo'd entry is worse than no
 * denylist: the operator believes something is no longer served, the deploy goes out green, and it is
 * still on the site. Better to fail `next build` loudly, exactly like endpoints.ts does for a
 * mixed-content `ws://`. In development a bad entry warns and is dropped, so an experiment does not
 * brick `npm run dev`.
 */
function validated(
  entries: string[],
  shape: RegExp,
  what: string,
  extra?: (e: string) => string | null,
): string[] {
  const bad = entries.filter((e) => !shape.test(e) || extra?.(e) != null);
  if (bad.length > 0) {
    const why = bad
      .map((e) => (shape.test(e) ? `${e} (${extra?.(e) ?? "invalid"})` : e))
      .join(", ");
    const message = `Denylist: ${bad.length} malformed ${what} entr${bad.length === 1 ? "y" : "ies"} (${why}).`;
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `${message} A malformed entry would be silently ignored, so the deploy would look successful while still serving the content. Fix or remove it.`,
      );
    }
    console.warn(`[cogno] ${message} Ignored in development.`);
  }
  return entries.filter((e) => shape.test(e) && extra?.(e) == null);
}

/**
 * The checks a regex cannot make on an ss58: it must be checksum-valid AND at prefix 42.
 *
 * A shape check alone passes the two likeliest operator mistakes, both of which build GREEN and then
 * deny nothing. One mistyped base58 character is still base58 and still the right length. And an
 * address copied from a Polkadot/Substrate explorer carries a different network prefix, which encodes
 * the SAME public key as a completely different string — so it never equals the prefix-42 form every
 * post in this app is authored under. Either way the operator believes an account is delisted while
 * every surface still serves it, which is worse than having no lever, because they stop looking.
 *
 * `normalizeSs58` (lib/ss58) is the same checksum validator the mention parser uses, so a denylist
 * entry is held to exactly the standard an address in a post body is.
 */
function ss58Problem(entry: string): string | null {
  const canonical = normalizeSs58(entry);
  if (canonical === null) return "not a valid ss58 address";
  if (canonical !== entry) return `wrong network prefix, use ${canonical}`;
  return null;
}

const ENV_DENY_AUTHORS = process.env.NEXT_PUBLIC_DENY_AUTHORS || "";
const ENV_DENY_POSTS = process.env.NEXT_PUBLIC_DENY_POSTS || "";

/** ss58 addresses this deployment declines to serve. EMPTY as shipped. */
export const DENIED_AUTHORS: ReadonlySet<string> = new Set(
  validated(parseList(ENV_DENY_AUTHORS), SS58_SHAPE, "author", ss58Problem),
);

/**
 * Post ids this deployment declines to serve, as decimal STRINGS.
 *
 * Strings, not bigints, so lookups match `hiddenStore`'s `String(id)` convention and so a Set built at
 * module scope needs no bigint parsing on a hot path.
 */
export const DENIED_POSTS: ReadonlySet<string> = new Set(
  validated(parseList(ENV_DENY_POSTS), POST_ID_SHAPE, "post"),
);

/** True when this deployment denies nothing, which is the shipped state. Lets callers short-circuit. */
export const DENYLIST_EMPTY: boolean = DENIED_AUTHORS.size === 0 && DENIED_POSTS.size === 0;

/** Is this author on the operator's list? */
export function isDeniedAuthor(address: string | null | undefined): boolean {
  return address != null && DENIED_AUTHORS.has(address);
}

/** Is this post on the operator's list? */
export function isDeniedPost(id: bigint | string | null | undefined): boolean {
  return id != null && DENIED_POSTS.has(String(id));
}

/** True when this post is denied outright OR its author is. The predicate every read path applies. */
export function isDenied(post: { id: bigint; author: string }): boolean {
  return isDeniedPost(post.id) || isDeniedAuthor(post.author);
}
