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
// SHIPPED EMPTY. Both sets are empty here and in the build, and no runtime file exists until an
// operator creates one, so the whole mechanism is inert until somebody deliberately populates it.
//
// HOW TO POPULATE — TWO SOURCES, UNIONED
//
// 1. A RUNTIME FILE, /denylist.json, fetched once at boot. This is the fast lever, and the one to
//    reach for when a notice arrives:
//
//      {"authors": ["5Grw…utQY"], "posts": ["1234", "5678"]}
//
//    nginx maps it to /etc/cogno/denylist.json — OUTSIDE the web root, because `deploy-app` is
//    `rsync -a --delete out/ /var/www/cogno/` and anything under the root is reset or deleted by the
//    next deploy. Editing it takes effect on the next page load. No rebuild, no rsync, no deploy.
//
// 2. TWO BUILD-TIME ENV VARS, comma-separated, read at `next build` and inlined into the export:
//
//      NEXT_PUBLIC_DENY_AUTHORS=5Grw…utQY,5FHn…9xKp     ss58 addresses (prefix 42)
//      NEXT_PUBLIC_DENY_POSTS=1234,5678                  post ids, decimal
//
//    This is the durable half. It is baked into the bundle, so unlike the file it cannot fail to
//    load, cannot 404, and cannot be forgotten when someone rebuilds the server from scratch. A
//    permanent delisting belongs here; the file is what you use in the twenty minutes before you get
//    round to a deploy.
//
// The two are UNIONED, never merged-with-precedence: removing an entry from the file does not
// un-deny something the env var also names. That is deliberate — the failure worth designing against
// is an entry quietly ceasing to apply, not one applying twice.
//
// Denying an AUTHOR omits everything of theirs the app reads: their posts, replies, quotes, their
// profile, their rows in search and who-to-follow, and their mentions inside other people's posts.
// Denying a POST omits that one item. Both are reversible by removing the entry.
//
// THE LIST IS PUBLIC, from both sources. A static export inlines the env vars into the JavaScript
// bundle, and /denylist.json is served to anyone who asks for it. That is the right trade for this
// project: a secret list of what an operator has quietly stopped serving is worse than a visible one,
// and the chain makes the underlying content trivially findable anyway. Do not treat an entry as
// confidential, and do not put a reason, a reporter or a case number in the file.
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

/**
 * ss58 addresses this deployment declines to serve. EMPTY as shipped.
 *
 * MUTATED IN PLACE by `loadServeDenylist` when the runtime file lands — the Set identity is stable,
 * so every module that captured this binding at import time sees the additions without a re-import.
 * That is why it is a live `Set` behind a `ReadonlySet` type rather than a frozen snapshot: a
 * rebuilt-on-load collection would leave stale copies denying nothing in whichever modules imported
 * first, which is the silent-reopen failure this whole module exists to avoid.
 */
export const DENIED_AUTHORS: ReadonlySet<string> = new Set(
  validated(parseList(ENV_DENY_AUTHORS), SS58_SHAPE, "author", ss58Problem),
);

/**
 * Post ids this deployment declines to serve, as decimal STRINGS.
 *
 * Strings, not bigints, so lookups match `hiddenStore`'s `String(id)` convention and so the Set needs
 * no bigint parsing on a hot path. Mutated in place on load, like `DENIED_AUTHORS`.
 */
export const DENIED_POSTS: ReadonlySet<string> = new Set(
  validated(parseList(ENV_DENY_POSTS), POST_ID_SHAPE, "post"),
);

/**
 * Does this deployment currently deny nothing?
 *
 * A FUNCTION, not the constant it used to be. The constant was evaluated once at module scope, which
 * was correct while the only source was a build-time env var and is a bug the moment a runtime file
 * can add entries later: `withServeDenylist` read it to decide whether to wrap the feed source at
 * all, so a list that arrived after that decision would have been read into a set nothing consulted.
 * Callers that cache the answer must re-ask, or simply not short-circuit — the per-entry predicates
 * below already cost nothing on an empty set.
 */
export function denylistEmpty(): boolean {
  return DENIED_AUTHORS.size === 0 && DENIED_POSTS.size === 0;
}

/** Where the runtime list is served from. nginx maps it to /etc/cogno/denylist.json (see deploy/). */
const DENYLIST_URL = "/denylist.json";

/** The shape of that file. Both keys optional so `{}` and `{"posts":[]}` are both legal. */
interface DenylistFile {
  authors?: unknown;
  posts?: unknown;
}

/** Entries as strings, dropping anything that is not one. Non-array input yields []. */
function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is string => typeof e === "string").map((e) => e.trim()).filter(Boolean);
}

/**
 * Validate runtime entries. Unlike the build-time path this can NEVER throw: it runs in the browser,
 * and a malformed file must not take the site down. It is still LOUD — `console.error`, not a warn —
 * because the failure mode is the operator believing something is delisted when it is not, and the
 * console is the only channel there is. Valid entries in the same file still apply; one bad line does
 * not discard the rest, which is the behaviour you want at 2am with a notice in hand.
 */
function validatedAtRuntime(entries: string[], shape: RegExp, what: string): string[] {
  const good = entries.filter((e) => shape.test(e));
  if (good.length !== entries.length) {
    const bad = entries.filter((e) => !shape.test(e));
    console.error(
      `[cogno] ${DENYLIST_URL}: ignored ${bad.length} malformed ${what} entr${bad.length === 1 ? "y" : "ies"} (${bad.join(", ")}). They are NOT being denied. Fix the file.`,
    );
  }
  return good;
}

/**
 * Runtime author entries, CANONICALIZED to prefix 42 rather than rejected.
 *
 * This deliberately diverges from the build-time path, which rejects a wrong-prefix address so the
 * operator fixes it before deploying. Here there is no build to fail and no operator watching: an
 * address pasted from a Polkadot or Substrate explorer is checksum-valid and encodes the SAME key as
 * a different string, so rejecting it would leave the account fully served while the operator, having
 * just edited the file during an incident, believes it is delisted. Denying is the safe direction and
 * the intent is unambiguous — it is the same 32 bytes. The correction is still logged so the file
 * gets fixed.
 *
 * A genuinely invalid entry (a typo, not a prefix) has no such unambiguous intent and is dropped.
 */
function canonicalAuthorsAtRuntime(entries: string[]): string[] {
  const out: string[] = [];
  const bad: string[] = [];
  for (const e of entries) {
    const canonical = SS58_SHAPE.test(e) ? normalizeSs58(e) : null;
    if (canonical === null) {
      bad.push(e);
      continue;
    }
    if (canonical !== e) {
      console.warn(
        `[cogno] ${DENYLIST_URL}: author "${e}" is at a non-42 network prefix. Denying it as ${canonical} (the same account). Update the file to the canonical form.`,
      );
    }
    out.push(canonical);
  }
  if (bad.length > 0) {
    console.error(
      `[cogno] ${DENYLIST_URL}: ignored ${bad.length} malformed author entr${bad.length === 1 ? "y" : "ies"} (${bad.join(", ")}). They are NOT being denied. Fix the file.`,
    );
  }
  return out;
}

/** Resolves once the runtime list has been applied (or definitively has not). Idempotent. */
let loadOnce: Promise<void> | null = null;

/**
 * Fetch and apply the runtime denylist. Called once at app boot (see components/Providers).
 *
 * FAIL-OPEN, deliberately and with the trade stated: if the file cannot be read, this deployment
 * serves whatever the build-time env vars did not already deny. The alternative — refusing to render
 * the site when a static JSON 404s — would mean a routine nginx typo takes cogno.forum down, and the
 * content in question is on a public chain that anyone can read from any node regardless. So the
 * durable entries belong in the env vars (baked, cannot fail) and this is the fast path on top.
 *
 * A 404 is the NORMAL state, not an error: it is what an operator who has never needed the lever
 * sees, so it is silent. Anything else is logged.
 */
export function loadServeDenylist(): Promise<void> {
  if (loadOnce) return loadOnce;
  // No fetch during prerender: `next build` runs this module in Node with no origin to resolve
  // against, and the export must not bake in whatever the build host happened to answer.
  if (typeof window === "undefined") {
    loadOnce = Promise.resolve();
    return loadOnce;
  }
  loadOnce = (async () => {
    let file: DenylistFile;
    try {
      const res = await fetch(DENYLIST_URL, { cache: "no-store" });
      if (res.status === 404) return; // no runtime list configured — the shipped state
      if (!res.ok) {
        console.error(`[cogno] ${DENYLIST_URL}: HTTP ${res.status}. Runtime denylist NOT applied.`);
        return;
      }
      file = (await res.json()) as DenylistFile;
    } catch (err) {
      console.error(`[cogno] ${DENYLIST_URL}: unreadable. Runtime denylist NOT applied.`, err);
      return;
    }

    const authors = canonicalAuthorsAtRuntime(asStringList(file.authors));
    const posts = validatedAtRuntime(asStringList(file.posts), POST_ID_SHAPE, "post");
    // Union onto the env seed, in place. Never a replacement: an entry named by the build can only be
    // withdrawn by a build, so nothing that ships denied can be quietly re-opened by editing a file.
    for (const a of authors) (DENIED_AUTHORS as Set<string>).add(a);
    for (const p of posts) (DENIED_POSTS as Set<string>).add(p);
  })();
  return loadOnce;
}

/**
 * Canonical form of an address, memoized.
 *
 * `normalizeSs58` decodes a blake2b checksum, and the only caller below sits on a per-post hot path,
 * so the answers are cached. The key space is account addresses — a small set that repeats on every
 * page — and the bound is there so a stream of distinct route params cannot grow it without limit.
 */
const canonicalCache = new Map<string, string | null>();
function canonicalSs58(address: string): string | null {
  const hit = canonicalCache.get(address);
  if (hit !== undefined) return hit;
  const canonical = normalizeSs58(address);
  if (canonicalCache.size >= 1024) canonicalCache.clear();
  canonicalCache.set(address, canonical);
  return canonical;
}

/**
 * Is this author on the operator's list?
 *
 * Compared CANONICALLY, not by string equality. An ss58 address is an encoding of a 32-byte public key
 * plus a network prefix, so the same account is a DIFFERENT string at every prefix — and the one
 * address in this app that does not come from the chain, the `/u/[address]` route param, arrives from
 * whatever a visitor typed. A bare `Set.has` would therefore have served a delisted account's entire
 * profile at a non-canonical encoding of their own key: `isPlausibleSs58` is a loose base58 regex with
 * no checksum and no prefix check, and PAPI's AccountId codec decodes any prefix to the same key, so
 * every chain read behind that page resolves normally. Re-encoding an address in an explorer is not a
 * sophisticated bypass, and the operator would have no way to notice it.
 *
 * The route canonicalizes its own param as well (app/u/[address]/view.tsx), which is where the fix
 * belongs; this is the backstop that makes the predicate itself hard to hold wrong.
 *
 * Costs nothing in the shipped build: the `size === 0` check short-circuits before any decoding, and an
 * operator who populates the list pays one memoized decode per distinct address.
 */
export function isDeniedAuthor(address: string | null | undefined): boolean {
  if (address == null || DENIED_AUTHORS.size === 0) return false;
  if (DENIED_AUTHORS.has(address)) return true;
  const canonical = canonicalSs58(address);
  return canonical !== null && canonical !== address && DENIED_AUTHORS.has(canonical);
}

/** Is this post on the operator's list? */
export function isDeniedPost(id: bigint | string | null | undefined): boolean {
  return id != null && DENIED_POSTS.has(String(id));
}

/** True when this post is denied outright OR its author is. The predicate every read path applies. */
export function isDenied(post: { id: bigint; author: string }): boolean {
  return isDeniedPost(post.id) || isDeniedAuthor(post.author);
}
