// The WRITE seam: every user action → exactly one extrinsic. This module is the ONLY place the
// frontend builds a microblog / profile / gate call. It is reader-agnostic and returns the phase
// stream (`Observable<TxUpdate>`) for signed writes, or — for the two CIP-8 binds — re-exports the
// bare-unsigned promise submitters from identity.ts.
//
// Cost model (spec 117): post / reply / quote / vote / clear / repost / follow / unfollow / poll
// are FEELESS + capacity-metered SIGNED writes. **Profile writes (set_profile / clear_profile /
// pin_post / unpin_post) are ALSO FEELESS** (pallet-profile carries `#[pallet::feeless_if(...true)]`
// + capacity-metered at ProfileCost) — so they are built exactly like a post: signed, no fee path,
// no balance gate, no funding flow. The old "D9 fee-bearing profile" model is OBSOLETE. They can
// hit `ExhaustsResources` like any other metered write → the same rate-limit handling applies.
// The two CIP-8 binds are the only UNSIGNED (bare) writes — a zero-balance derived account binds
// itself; the CIP-8 proof is the authorization.

import { Binary, Enum } from "polkadot-api";
import type { Observable } from "rxjs";
import { watchTx, submitPost } from "@/lib/chain/post";
import type { CognoApi, PostingSigner, TxUpdate, Ss58 } from "@/lib/types";

/** Minimal shape of a PAPI transaction we can sign + watch. */
interface Signable {
  signSubmitAndWatch(signer: unknown): unknown;
}

/** Wrap a signed `signSubmitAndWatch` into the shared TxUpdate phase stream. */
function watchSigned(
  tx: Signable,
  signer: PostingSigner,
  eventName?: "PostCreated",
): Observable<TxUpdate> {
  return watchTx(
    () =>
      tx.signSubmitAndWatch(signer.signer) as unknown as ReturnType<
        Parameters<typeof watchTx>[0]
      >,
    eventName,
  );
}

// ── posts / threading ──────────────────────────────────────────────────────────────────────

/** A reply is just a post with a parent (emits `PostCreated`). */
export function submitReply(
  api: CognoApi,
  signer: PostingSigner,
  text: string,
  parentId: bigint,
): Observable<TxUpdate> {
  return submitPost(api, signer, text, parentId);
}

/** A quote-post references another post without threading under it (emits `PostCreated`). */
export function submitQuote(
  api: CognoApi,
  signer: PostingSigner,
  text: string,
  quotedId: bigint,
): Observable<TxUpdate> {
  const tx = api.tx.Microblog.quote_post({
    text: Binary.fromText(text),
    quoted_id: quotedId,
  }) as unknown as Signable;
  return watchSigned(tx, signer, "PostCreated");
}

// ── votes ────────────────────────────────────────────────────────────────────────────────────

/** Like == an UP vote; Down == the secondary down-vote. `VoteDir` encodes as `Enum("Up"|"Down")`. */
export function submitVote(
  api: CognoApi,
  signer: PostingSigner,
  postId: bigint,
  dir: "Up" | "Down",
): Observable<TxUpdate> {
  const tx = api.tx.Microblog.vote({
    post_id: postId,
    dir: Enum(dir),
  }) as unknown as Signable;
  return watchSigned(tx, signer);
}

/** Unlike / clear an existing vote. */
export function submitClearVote(
  api: CognoApi,
  signer: PostingSigner,
  postId: bigint,
): Observable<TxUpdate> {
  const tx = api.tx.Microblog.clear_vote({ post_id: postId }) as unknown as Signable;
  return watchSigned(tx, signer);
}

// ── reposts / follows ──────────────────────────────────────────────────────────────────────

/** Repost is PERMANENT (the chain rejects `AlreadyReposted`); the optimistic UI must not double-fire. */
export function submitRepost(
  api: CognoApi,
  signer: PostingSigner,
  postId: bigint,
): Observable<TxUpdate> {
  const tx = api.tx.Microblog.repost({ post_id: postId }) as unknown as Signable;
  return watchSigned(tx, signer);
}

export function submitFollow(
  api: CognoApi,
  signer: PostingSigner,
  target: Ss58,
): Observable<TxUpdate> {
  const tx = api.tx.Microblog.follow({ target }) as unknown as Signable;
  return watchSigned(tx, signer);
}

export function submitUnfollow(
  api: CognoApi,
  signer: PostingSigner,
  target: Ss58,
): Observable<TxUpdate> {
  const tx = api.tx.Microblog.unfollow({ target }) as unknown as Signable;
  return watchSigned(tx, signer);
}

// ── polls ──────────────────────────────────────────────────────────────────────────────────

/**
 * Create a poll: the question IS the host post's text, the options are `Vec<Vec<u8>>`. 2..=4
 * options, each ≤ 80 bytes (validate at the call site with the ByteCounter). Emits `PostCreated`
 * (the host post's id) + `PollCreated`.
 */
export function submitCreatePoll(
  api: CognoApi,
  signer: PostingSigner,
  question: string,
  options: string[],
): Observable<TxUpdate> {
  const tx = api.tx.Microblog.create_poll({
    question: Binary.fromText(question),
    options: options.map((o) => Binary.fromText(o)),
  }) as unknown as Signable;
  return watchSigned(tx, signer, "PostCreated");
}

/** Cast / re-cast a poll vote (re-cast moves the voter's weight to the new option). */
export function submitPollVote(
  api: CognoApi,
  signer: PostingSigner,
  hostId: bigint,
  option: number,
): Observable<TxUpdate> {
  const tx = api.tx.Microblog.cast_poll_vote({
    post_id: hostId,
    option,
  }) as unknown as Signable;
  return watchSigned(tx, signer);
}

// ── profile (FEELESS signed — D9 obsolete) ───────────────────────────────────────────────────

/**
 * Set the whole Profile record (spec-118): display name / bio / avatar / banner / location / website
 * (UTF-8 bytes: ≤ 64 / 256 / 128 / 256 / 64 / 256). Feeless + capacity-metered. `set_profile`
 * overwrites the WHOLE record, so every call must pass all six fields (the editor sends the current
 * value for each, empty to clear).
 */
export function submitSetProfile(
  api: CognoApi,
  signer: PostingSigner,
  name: string,
  bio: string,
  avatar: string,
  banner: string,
  location: string,
  website: string,
): Observable<TxUpdate> {
  const tx = api.tx.Profile.set_profile({
    display_name: Binary.fromText(name),
    bio: Binary.fromText(bio),
    avatar: Binary.fromText(avatar),
    banner: Binary.fromText(banner),
    location: Binary.fromText(location),
    website: Binary.fromText(website),
  }) as unknown as Signable;
  return watchSigned(tx, signer);
}

export function submitClearProfile(
  api: CognoApi,
  signer: PostingSigner,
): Observable<TxUpdate> {
  const tx = api.tx.Profile.clear_profile() as unknown as Signable;
  return watchSigned(tx, signer);
}

export function submitPinPost(
  api: CognoApi,
  signer: PostingSigner,
  id: bigint,
): Observable<TxUpdate> {
  const tx = api.tx.Profile.pin_post({ id }) as unknown as Signable;
  return watchSigned(tx, signer);
}

export function submitUnpinPost(
  api: CognoApi,
  signer: PostingSigner,
): Observable<TxUpdate> {
  const tx = api.tx.Profile.unpin_post() as unknown as Signable;
  return watchSigned(tx, signer);
}

// ── re-exports ───────────────────────────────────────────────────────────────────────────────

// Post (exists in post.ts) — re-exported so every write goes through one module.
export { submitPost } from "@/lib/chain/post";
// The two CIP-8 binds are UNSIGNED bare submitters (resolve a Promise, do not stream).
export { submitLinkIdentityFeeless, submitLinkStakeFeeless } from "@/lib/chain/identity";
