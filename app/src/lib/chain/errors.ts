// Chain failures, classified ONCE and worded ONCE.
//
// What this replaces: `stringifyError` rewrote the CheckCapacity pool rejection (`ExhaustsResources`)
// into English prose, and three byte-identical `isRateLimit` regexes downstream parsed that English
// back OUT again to decide which toast to raise. The classification round-tripped through a human
// sentence. That is not a style problem — it is why the boot guard was a hazard: its reason string
// ("This app is not compatible with the connected node") flowed through the same regex, and any copy
// that happened to contain "rate limit" would have masked an encoding mismatch as a rate limit.
//
// Here the classification is STRUCTURAL and happens once, at the boundary where the chain's own error
// value is still in hand. `kind` is what the UI branches on; `errorCopy()` is the only thing that turns
// a failure into prose. Neither can be recovered from the other, so the round-trip is not expressible.
//
// Every module error used to reach the user as raw JSON — a rejected post literally rendered
// `Module: {"type":"Microblog","value":{"type":"NotAllowed"}}` in a toast. The copy table below is
// keyed on the pallet + variant names that PAPI actually decodes (see the shape note on
// `RawDispatchError`), with a raw fallback for anything unmapped.

/**
 * A dispatch error as PAPI decodes it.
 *
 * SHAPE, from the generated descriptors (NOT from a hand-written guess — the one fixture in the repo
 * had this wrong, and it passed only because the old code JSON-stringified it blindly): `DispatchError`
 * is a tagged enum, and PAPI models every enum as `{ type, value }`. So a pallet error arrives as a
 * THREE-level nest:
 *
 *   { type: "Module", value: { type: "Microblog", value: { type: "NotAllowed" } } }
 *            ^ outer            ^ pallet name        ^ variant name
 *
 * The `value` of the innermost is `undefined` (these variants carry no payload).
 *
 * Substrate can ALSO hand back an undecoded numeric module error — `{ index: 10n, error: 3n }` — when
 * the metadata is unavailable. There are no names in that shape, and the frontend has no
 * pallet-index -> name table, so it cannot be mapped to copy. It falls through to `raw`.
 */
export interface RawDispatchError {
  type: string;
  value: unknown;
}

/** A classified chain failure. Branch on `kind`; render with {@link errorCopy}. */
export type ChainError =
  /** The feeless-post spam gate (CheckCapacity -> ExhaustsResources at the pool). Not a real failure —
   *  the user is posting faster than their talk-capacity regenerates. Gets its own toast. */
  | { kind: "rate-limit" }
  /** A pallet rejected the call. `pallet`/`name` are the decoded enum tags. */
  | { kind: "module"; pallet: string; name: string }
  /** Anything else: a signer rejection, a dropped connection, the numeric module arm, a boot-guard
   *  refusal. `detail` is already user-safe prose (it is what we would have shown anyway). */
  | { kind: "raw"; detail: string };

/**
 * User-facing copy for a pallet error, keyed `Pallet::Variant`.
 *
 * Only FE-DISPATCHABLE errors are worth wording: the app calls Microblog (post/vote/follow/quote/poll),
 * Profile (set/clear/pin/unpin) and CognoGate (the two feeless identity binds). Everything else — and
 * every variant not listed — falls through to the raw `Pallet: Variant` string, which is honest rather
 * than absent. Variant names are taken from the generated descriptors, so a renamed variant simply
 * stops matching and degrades to raw; it cannot silently mis-word.
 */
const MODULE_COPY: Record<string, string> = {
  // ── Microblog ──
  "Microblog::TooLong": "That post is too long.",
  "Microblog::NotFound": "That post no longer exists.",
  "Microblog::TooManyPosts": "You've reached the maximum number of posts for one account.",
  "Microblog::NotAllowed": "You need a linked Cardano identity to do that.",
  "Microblog::NotVoted": "You haven't voted on that.",
  "Microblog::SelfFollow": "You can't follow yourself.",
  "Microblog::AlreadyFollowing": "You already follow them.",
  "Microblog::NotFollowing": "You don't follow them.",
  "Microblog::NotEnoughOptions": "A poll needs at least two options.",
  "Microblog::TooManyOptions": "That poll has too many options.",
  "Microblog::OptionTooLong": "One of those poll options is too long.",
  "Microblog::PollNotFound": "That poll no longer exists.",
  "Microblog::InvalidOption": "That isn't one of the poll's options.",
  "Microblog::SelfAccountVote": "You can't vote on your own account.",
  "Microblog::TargetNotAllowed": "That account doesn't have a linked identity.",
  // ── Profile ──
  "Profile::NotAllowed": "You need a linked Cardano identity to edit your profile.",
  "Profile::NameTooLong": "That display name is too long.",
  "Profile::BioTooLong": "That bio is too long.",
  "Profile::AvatarTooLong": "That avatar URL is too long.",
  "Profile::BannerTooLong": "That banner URL is too long.",
  "Profile::LocationTooLong": "That location is too long.",
  "Profile::WebsiteTooLong": "That website URL is too long.",
  "Profile::NoProfile": "You don't have a profile to clear.",
  "Profile::NotPinned": "You don't have a pinned post.",
  // ── CognoGate (the feeless identity binds) ──
  "CognoGate::AccountAlreadyBound": "This account is already linked to a Cardano identity.",
  "CognoGate::PkhAlreadyBound": "That Cardano identity is already linked to another account.",
  "CognoGate::ProofInvalid": "That signature didn't verify. Try signing again.",
  "CognoGate::WrongGenesis": "That signature was made for a different chain.",
  "CognoGate::IdentityTombstoned": "That Cardano identity has been revoked.",
  "CognoGate::NotPaymentBound": "Link your payment identity before linking a stake key.",
  "CognoGate::AccountAlreadyStakeBound": "This account already has a stake key linked.",
  "CognoGate::StakeCredAlreadyBound": "That stake key is already linked to another account.",
  "CognoGate::StakeCredTombstoned": "That stake key has been revoked.",
};

/** Bigint-safe JSON (a u64-bearing error value must not throw on the way to a toast). */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? "";
  } catch {
    return "";
  }
}

/** Is this the decoded `{ type, value }` enum shape PAPI produces? */
function isTagged(v: unknown): v is { type: string; value: unknown } {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

/**
 * Classify a dispatch error (a call that made it into a block, then failed).
 *
 * The `Module` arm is unwrapped to pallet + variant when PAPI decoded it by name. The numeric arm
 * (`{index, error}`) has no names to key on and degrades to `raw` carrying the JSON — which is what
 * shipped before, and is the honest floor: a wrong sentence is worse than an opaque one.
 */
export function classifyDispatchError(err: RawDispatchError | undefined): ChainError {
  if (!err) return { kind: "raw", detail: "Transaction failed (no dispatch error reported)." };
  if (err.type === "Module" && isTagged(err.value)) {
    const pallet = err.value;
    if (isTagged(pallet.value)) {
      return { kind: "module", pallet: pallet.type, name: pallet.value.type };
    }
  }
  const detail = safeJson(err.value);
  return {
    kind: "raw",
    detail: detail && detail !== "{}" && detail !== "null" ? `${err.type}: ${detail}` : err.type,
  };
}

/**
 * Classify a THROWN error (signer rejection, dropped socket, pool rejection).
 *
 * The pool rejects an over-capacity feeless post as `ExhaustsResources` before it ever reaches a block,
 * so it never becomes a dispatch error — this is the only place the rate limit can be recognised, and
 * recognising it HERE (rather than re-deriving it from prose downstream) is the whole point of the file.
 */
export function classifyThrown(err: unknown): ChainError {
  let raw: string;
  if (err instanceof Error) raw = err.message;
  else if (typeof err === "string") raw = err;
  else raw = safeJson(err) || String(err);

  if (/ExhaustsResources/i.test(raw)) return { kind: "rate-limit" };
  return { kind: "raw", detail: raw || "Transaction failed." };
}

/**
 * The ONE prose producer. Every user-visible error string in the app comes from here.
 *
 * Note the rate-limit copy lives in exactly one place now. It used to exist as two subtly different
 * sentences — "You are over the rate limit." in the chain layer and "You're over the rate limit." in
 * the toaster — the first of which was written, matched by a regex, and then thrown away on every path.
 */
export function errorCopy(e: ChainError): string {
  switch (e.kind) {
    case "rate-limit":
      return "You're over the rate limit. Try again shortly.";
    case "module":
      return MODULE_COPY[`${e.pallet}::${e.name}`] ?? `${e.pallet}: ${e.name}`;
    case "raw":
      return e.detail || "Transaction failed.";
  }
}
