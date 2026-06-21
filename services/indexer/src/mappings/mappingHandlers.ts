import { SubstrateEvent } from "@subql/types";
import {
  Author,
  Follow,
  Poll,
  PollOption,
  PollVote,
  Post,
  Repost,
  Thread,
  Vote,
} from "../types";
import {
  applyOption,
  foldVote,
  inc,
  isWellFormedIdentityHash,
  normalizeIdentityHash,
  normalizeParentId,
  normalizeVoteDir,
  reverseOption,
  satDec,
  tallyScore,
  timestampDecision,
  utf8FromBytes,
  type TallyState,
  type VoteSnapshot,
} from "./pure";

// ── decode helpers ───────────────────────────────────────────────────────────
// Event args arrive as @polkadot/api Codec values; decode positionally + defensively.
// The pure branches (utf8/timestamp/parentId/voteDir normalization + the saturating tally fold)
// live in ./pure for unit testing.

/** UTF-8 body of a `BoundedVec<u8>` codec (post text, poll option label, profile field). */
function bytesToUtf8(codec: any): string {
  if (!codec) return "";
  if (typeof codec.toUtf8 === "function") return codec.toUtf8();
  return utf8FromBytes(codec.toU8a(true));
}

/** A u128 codec → bigint (the StakeSet/vote-weight pattern). */
function toBig(codec: any): bigint {
  return typeof codec?.toBigInt === "function" ? codec.toBigInt() : BigInt(codec.toString());
}

/** Compose the deterministic composite id for the per-(target, account) social rows. */
const pairId = (a: string, b: string): string => `${a}-${b}`;

/**
 * Read the stored Post row at the CURRENT indexed block (api.query reads at the event's block).
 * Returns the body plus the optional `parent` (reply) and `quote` (quote-post) ids — both are
 * normalized to a non-empty string or undefined (a NULL column). The on-chain `Posts(id)` struct is
 * `{ author, text, parent: Option<u64>, at, quote: Option<u64> }` (quote added in storage v1).
 */
async function readStoredPost(
  postIdCodec: any,
): Promise<{ text: string; parentId?: string; quoteId?: string }> {
  const stored: any = await api.query.microblog.posts(postIdCodec);
  if (!stored || stored.isNone) {
    // indexer-12: storage row absent right after PostCreated => events/storage divergence. We do
    // not throw (the empty body is recoverable; the chain remains source of truth) but warn loudly.
    logger.warn(
      `post #${postIdCodec.toString()} not found in storage at its creating block — indexing empty body (events/storage divergence?)`,
    );
    return { text: "", parentId: undefined, quoteId: undefined };
  }
  const post = stored.unwrap();
  const rawParentId =
    post.parent && post.parent.isSome ? post.parent.unwrap().toString() : undefined;
  const rawQuoteId =
    post.quote && post.quote.isSome ? post.quote.unwrap().toString() : undefined;
  return {
    text: bytesToUtf8(post.text),
    parentId: normalizeParentId(rawParentId),
    quoteId: normalizeParentId(rawQuoteId),
  };
}

/** Read the stored Poll's option labels (UTF-8) at the event's block. `Polls(id)` is OptionQuery. */
async function readPollOptions(pollIdCodec: any): Promise<string[]> {
  const stored: any = await api.query.microblog.polls(pollIdCodec);
  if (!stored || stored.isNone) {
    // The poll is inserted in the same extrinsic that emits PollCreated, so a None here is a
    // storage divergence. Warn (not halt) and create a poll with no options — verify-m4c reads the
    // SAME storage at the SAME block, so both sides agree (A==B) even in this degenerate case.
    logger.warn(`poll #${pollIdCodec.toString()} not found in storage at its creating block — indexing zero options`);
    return [];
  }
  return stored.unwrap().options.map((o: any) => bytesToUtf8(o));
}

/** Read the stored Profile (UTF-8 fields) at the event's block. `Profiles(who)` is OptionQuery. */
async function readStoredProfile(
  whoCodec: any,
): Promise<{ displayName: string; bio: string; avatar: string } | null> {
  const stored: any = await api.query.profile.profiles(whoCodec);
  if (!stored || stored.isNone) {
    logger.warn(`profile for ${whoCodec.toString().slice(0, 8)}… not found in storage at its ProfileSet block`);
    return null;
  }
  const p = stored.unwrap();
  // @polkadot/api camelCases struct fields (chain field `display_name` → `.displayName`); read both
  // to be robust across decoder versions.
  return {
    displayName: bytesToUtf8(p.displayName ?? p.display_name),
    bio: bytesToUtf8(p.bio),
    avatar: bytesToUtf8(p.avatar),
  };
}

/**
 * Upsert an Author, creating a fresh unbound/unbanned row if absent. This is THE author-creation
 * rule (verify-m4c mirrors it): ANY handled event naming an account touches it here, so the served
 * author set == the re-derived author set. A loaded row is returned as-is (its counts/profile are
 * preserved — only a brand-new row gets the zero defaults).
 */
async function ensureAuthor(id: string): Promise<Author> {
  let author = await Author.get(id);
  if (!author) {
    author = Author.create({
      id,
      identityHash: undefined,
      banned: false,
      weight: undefined,
      postCount: 0,
      displayName: undefined,
      bio: undefined,
      avatar: undefined,
      pinnedPostId: undefined,
      followerCount: 0,
      followingCount: 0,
    });
  }
  return author;
}

/**
 * The block wall-clock for an event (indexer-3). Prefer the block's own timestamp; if absent, read
 * the on-chain `Timestamp.set` value at this block before giving up — and NEVER fall back to epoch 0
 * silently (a `new Date(0)` corrupts the `Post.timestamp` recency ordering, and verify-m4c does not
 * fold timestamp so it would pass the gate undetected).
 */
async function blockTimestamp(event: SubstrateEvent): Promise<Date> {
  if (event.block.timestamp) return event.block.timestamp;
  const height = event.block.block.header.number.toNumber();
  let ms: number | undefined;
  try {
    const now: any = await api.query.timestamp.now();
    ms = Number(typeof now.toBigInt === "function" ? now.toBigInt() : now.toString());
  } catch (e) {
    logger.warn(`Timestamp.now() unreadable at block #${height}: ${e}`);
  }
  const { date, didFallback } = timestampDecision(ms);
  if (didFallback) {
    // indexer-8: surface the ACTUAL bad value, not just "no timestamp" — an operator must be able
    // to tell a 0/negative chain value apart from an unreadable read, both corrupt recency order.
    logger.warn(
      `no valid block timestamp at #${height} (raw=${ms === undefined ? "unreadable" : ms}) — falling back to epoch 0 (recency ordering affected)`,
    );
  } else {
    logger.info(`block #${height} timestamp resolved from Timestamp.now(): ${ms}ms`);
  }
  return date;
}

/**
 * Error policy (indexer-2): wrap every handler so a failure is LOGGED with full context
 * (block / event index / section.method) and then RE-THROWN to HALT indexing. A silent skip would
 * diverge from the verify-m4c re-derivation (served feed != independent fold, A != B), breaking the
 * whole "anyone can reproduce the feed" property. The social handlers deliberately HALT when a
 * prerequisite row is missing (a vote on an unknown post, a clear with no vote, an unfollow of a
 * non-edge): the chain's dispatchables reject those first and the indexer only folds FINALIZED
 * blocks, so a miss is a real bug — warning would risk a silent A != B. The frontend's PAPI-direct
 * fallback degrades gracefully while an operator investigates the logged block/event.
 */
function guarded(
  name: string,
  fn: (event: SubstrateEvent) => Promise<void>,
): (event: SubstrateEvent) => Promise<void> {
  return async (event: SubstrateEvent): Promise<void> => {
    try {
      await fn(event);
    } catch (err) {
      const height = event.block.block.header.number.toNumber();
      const sm = `${event.event.section}.${event.event.method}`;
      const detail = err instanceof Error ? err.stack || err.message : String(err);
      logger.error(`handler ${name} FAILED at block #${height} event #${event.idx} (${sm}) — halting: ${detail}`);
      throw err;
    }
  };
}

// ── posts / threads ──────────────────────────────────────────────────────────

export const handlePostCreated = guarded(
  "handlePostCreated",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [idCodec, authorCodec],
      },
    } = event;
    const postId = idCodec.toString();
    const authorId = authorCodec.toString(); // AccountId -> SS58 (chain ss58Format)

    const blockHeight = event.block.block.header.number.toNumber();
    const timestamp = await blockTimestamp(event);

    // PostCreated is fired by post_message, quote_post AND create_poll. The reply/quote shape is
    // read from storage; isPoll is flipped later by the PollCreated event in the same block.
    const { text, parentId, quoteId } = await readStoredPost(idCodec);

    const author = await ensureAuthor(authorId);
    author.postCount += 1;

    const post = Post.create({
      id: postId,
      authorId: author.id,
      text,
      parentId, // undefined => top-level (NULL column)
      quoteId, // undefined => not a quote
      blockHeight,
      timestamp,
      isPoll: false, // flipped by handlePollCreated if this post carries a poll
      upWeight: 0n,
      downWeight: 0n,
      upCount: 0,
      downCount: 0,
      score: 0n,
      repostCount: 0,
    });

    await Promise.all([author.save(), post.save()]);

    // Thread bookkeeping — a convenience aggregate keyed on the IMMEDIATE parent (or self for a
    // top-level post). NOTE: this is the immediate-parent segment, NOT the transitive top-level
    // ancestor — for a depth-2+ reply it groups under the direct parent, not the conversation root.
    // The feed's thread view does not rely on this (it uses the faithful Post.parent → `replies`
    // reverse relation); Thread is an optional, deterministic convenience entity (excluded from M4c).
    const rootId = parentId ?? postId;
    let thread = await Thread.get(rootId);
    const threadExisted = !!thread;
    if (!thread) {
      thread = Thread.create({
        id: rootId,
        rootId,
        replyCount: 0,
        lastActivity: timestamp,
      });
    }
    if (parentId) thread.replyCount += 1;
    thread.lastActivity = timestamp;
    await thread.save();
    logger.debug(`thread #${rootId} ${threadExisted ? "updated" : "created"}: replyCount=${thread.replyCount}`);

    logger.info(
      `indexed post #${postId} by ${authorId.slice(0, 8)}… @#${blockHeight}${parentId ? ` ↳#${parentId}` : ""}${quoteId ? ` ⟢#${quoteId}` : ""}`,
    );
  },
);

// ── stake-weighted votes (reverse-then-apply fold; mirrors microblog `vote`/`clear_vote`) ──────

export const handleVoted = guarded(
  "handleVoted",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [idCodec, whoCodec, dirCodec, weightCodec],
      },
    } = event;
    const postId = idCodec.toString();
    const voterId = whoCodec.toString();
    // VoteDir is a fieldless enum; `.type` is the active variant name ("Up"/"Down"). normalizeVoteDir
    // pins the exact casing the fold branches on (and throws on an unknown variant).
    const dir = normalizeVoteDir((dirCodec as any).type ?? dirCodec.toString());
    const weight = toBig(weightCodec);

    await (await ensureAuthor(voterId)).save();

    const post = await Post.get(postId);
    if (!post) throw new Error(`Voted on unknown post #${postId} (missed PostCreated?)`);

    const voteId = pairId(postId, voterId);
    const existing = await Vote.get(voteId);
    const prev: VoteSnapshot | null = existing
      ? { dir: normalizeVoteDir(existing.dir), weight: BigInt(existing.weight) }
      : null;

    const before: TallyState = {
      upWeight: BigInt(post.upWeight),
      downWeight: BigInt(post.downWeight),
      upCount: post.upCount,
      downCount: post.downCount,
    };
    const after = foldVote(before, prev, { dir, weight });
    post.upWeight = after.upWeight;
    post.downWeight = after.downWeight;
    post.upCount = after.upCount;
    post.downCount = after.downCount;
    post.score = tallyScore(after);
    await post.save();

    await Vote.create({ id: voteId, postId, voterId, dir, weight }).save(); // upsert
    logger.info(
      `vote ${dir}(${weight}) on #${postId} by ${voterId.slice(0, 8)}… → up=${post.upWeight}/${post.upCount} down=${post.downWeight}/${post.downCount} score=${post.score}`,
    );
  },
);

export const handleVoteCleared = guarded(
  "handleVoteCleared",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [idCodec, whoCodec],
      },
    } = event;
    const postId = idCodec.toString();
    const voterId = whoCodec.toString();

    await (await ensureAuthor(voterId)).save();

    const voteId = pairId(postId, voterId);
    const existing = await Vote.get(voteId);
    // HALT: on-chain `clear_vote` errors `NotVoted` without a record, so a VoteCleared event always
    // had a prior Vote. A missing one means a missed Voted event — diverging from verify-m4c.
    if (!existing) throw new Error(`VoteCleared with no prior Vote ${voteId} (missed Voted?)`);
    const post = await Post.get(postId);
    if (!post) throw new Error(`VoteCleared on unknown post #${postId}`);

    const prev: VoteSnapshot = { dir: normalizeVoteDir(existing.dir), weight: BigInt(existing.weight) };
    const after = foldVote(
      {
        upWeight: BigInt(post.upWeight),
        downWeight: BigInt(post.downWeight),
        upCount: post.upCount,
        downCount: post.downCount,
      },
      prev,
      null,
    );
    post.upWeight = after.upWeight;
    post.downWeight = after.downWeight;
    post.upCount = after.upCount;
    post.downCount = after.downCount;
    post.score = tallyScore(after);
    await post.save();

    await Vote.remove(voteId);
    logger.info(`vote cleared on #${postId} by ${voterId.slice(0, 8)}… → score=${post.score}`);
  },
);

// ── reposts (permanent; only ever increments) ──────────────────────────────────

export const handleReposted = guarded(
  "handleReposted",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [idCodec, whoCodec],
      },
    } = event;
    const postId = idCodec.toString();
    const reposterId = whoCodec.toString();
    const blockHeight = event.block.block.header.number.toNumber();

    await (await ensureAuthor(reposterId)).save();

    const post = await Post.get(postId);
    if (!post) throw new Error(`Reposted unknown post #${postId}`);
    post.repostCount = inc(post.repostCount);
    await post.save();

    // Permanent edge — the chain rejects a duplicate (AlreadyReposted), so the id is unique.
    await Repost.create({ id: pairId(postId, reposterId), postId, reposterId, blockHeight }).save();
    logger.info(`repost of #${postId} by ${reposterId.slice(0, 8)}… → repostCount=${post.repostCount}`);
  },
);

// ── follow graph (toggleable edges + folded counters) ──────────────────────────

export const handleFollowed = guarded(
  "handleFollowed",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [followerCodec, followeeCodec],
      },
    } = event;
    const followerId = followerCodec.toString();
    const followeeId = followeeCodec.toString();

    const follower = await ensureAuthor(followerId);
    const followee = await ensureAuthor(followeeId); // followee need NOT exist on-chain

    await Follow.create({ id: pairId(followerId, followeeId), followerId, followeeId }).save();
    follower.followingCount = inc(follower.followingCount);
    followee.followerCount = inc(followee.followerCount);
    await follower.save();
    await followee.save();
    logger.info(`${followerId.slice(0, 8)}… follows ${followeeId.slice(0, 8)}… (following=${follower.followingCount}, followers=${followee.followerCount})`);
  },
);

export const handleUnfollowed = guarded(
  "handleUnfollowed",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [followerCodec, followeeCodec],
      },
    } = event;
    const followerId = followerCodec.toString();
    const followeeId = followeeCodec.toString();

    const follower = await ensureAuthor(followerId);
    const followee = await ensureAuthor(followeeId);

    const followId = pairId(followerId, followeeId);
    const edge = await Follow.get(followId);
    // HALT: on-chain `unfollow` errors `NotFollowing` without an edge, so an Unfollowed always had a
    // prior Follow. A missing one means a missed Followed event.
    if (!edge) throw new Error(`Unfollowed with no prior Follow ${followId} (missed Followed?)`);
    await Follow.remove(followId);
    follower.followingCount = satDec(follower.followingCount);
    followee.followerCount = satDec(followee.followerCount);
    await follower.save();
    await followee.save();
    logger.info(`${followerId.slice(0, 8)}… unfollowed ${followeeId.slice(0, 8)}… (following=${follower.followingCount}, followers=${followee.followerCount})`);
  },
);

// ── polls (a poll's question IS its host post; options + per-option tally live here) ────────────

export const handlePollCreated = guarded(
  "handlePollCreated",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [idCodec],
      },
    } = event;
    const postId = idCodec.toString();

    // PostCreated fired first in this same extrinsic, so the host Post already exists.
    const post = await Post.get(postId);
    if (!post) throw new Error(`PollCreated for unknown post #${postId} (PostCreated not folded?)`);
    post.isPoll = true;
    await post.save();

    const options = await readPollOptions(idCodec);
    await Poll.create({ id: postId, postId }).save();
    for (let i = 0; i < options.length; i++) {
      await PollOption.create({
        id: pairId(postId, String(i)),
        pollId: postId,
        index: i,
        label: options[i],
        weight: 0n,
        count: 0,
      }).save();
    }
    logger.info(`poll #${postId} created with ${options.length} options`);
  },
);

export const handlePollVoted = guarded(
  "handlePollVoted",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [idCodec, whoCodec, optionCodec, weightCodec],
      },
    } = event;
    const pollId = idCodec.toString();
    const voterId = whoCodec.toString();
    const option = Number(optionCodec.toString()); // u8
    const weight = toBig(weightCodec);

    await (await ensureAuthor(voterId)).save();

    const poll = await Poll.get(pollId);
    if (!poll) throw new Error(`PollVoted on non-poll post #${pollId}`);

    const pvId = pairId(pollId, voterId);
    const prev = await PollVote.get(pvId);
    // 1. REVERSE the previously-chosen option (if any) by its STORED weight. Save it FIRST so a
    //    same-option re-cast re-reads the reversed state below (the per-option reverse-then-apply).
    if (prev) {
      const prevOpt = await PollOption.get(pairId(pollId, String(prev.option)));
      if (!prevOpt) throw new Error(`PollVote points at missing option ${pollId}-${prev.option}`);
      const r = reverseOption({ weight: BigInt(prevOpt.weight), count: prevOpt.count }, BigInt(prev.weight));
      prevOpt.weight = r.weight;
      prevOpt.count = r.count;
      await prevOpt.save();
    }
    // 2. APPLY the new choice with the freshly-snapshotted weight (re-get to pick up step 1's save).
    const newOpt = await PollOption.get(pairId(pollId, String(option)));
    if (!newOpt) throw new Error(`PollVoted for out-of-range option ${pollId}-${option}`);
    const a = applyOption({ weight: BigInt(newOpt.weight), count: newOpt.count }, weight);
    newOpt.weight = a.weight;
    newOpt.count = a.count;
    await newOpt.save();

    await PollVote.create({ id: pvId, pollId, voterId, option, weight }).save(); // upsert
    logger.info(`poll #${pollId} vote opt=${option}(${weight}) by ${voterId.slice(0, 8)}…`);
  },
);

// ── profiles + pinned post (pallet-profile @17) ────────────────────────────────

export const handleProfileSet = guarded(
  "handleProfileSet",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [whoCodec],
      },
    } = event;
    const who = whoCodec.toString();
    const author = await ensureAuthor(who);
    const profile = await readStoredProfile(whoCodec);
    author.displayName = profile?.displayName ?? "";
    author.bio = profile?.bio ?? "";
    author.avatar = profile?.avatar ?? "";
    await author.save();
    logger.info(`profile set → ${who.slice(0, 8)}… name=${JSON.stringify(author.displayName)}`);
  },
);

export const handleProfileCleared = guarded(
  "handleProfileCleared",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [whoCodec],
      },
    } = event;
    const who = whoCodec.toString();
    const author = await ensureAuthor(who);
    author.displayName = undefined;
    author.bio = undefined;
    author.avatar = undefined;
    await author.save();
    logger.info(`profile cleared → ${who.slice(0, 8)}…`);
  },
);

export const handlePostPinned = guarded(
  "handlePostPinned",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [whoCodec, idCodec],
      },
    } = event;
    const who = whoCodec.toString();
    const author = await ensureAuthor(who);
    author.pinnedPostId = idCodec.toString(); // bare id, NOT a relation (chain stores it unvalidated)
    await author.save();
    logger.info(`post #${author.pinnedPostId} pinned by ${who.slice(0, 8)}…`);
  },
);

export const handlePostUnpinned = guarded(
  "handlePostUnpinned",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [whoCodec],
      },
    } = event;
    const who = whoCodec.toString();
    const author = await ensureAuthor(who);
    author.pinnedPostId = undefined;
    await author.save();
    logger.info(`post unpinned by ${who.slice(0, 8)}…`);
  },
);

// ── identity gate + stake (unchanged from M4) ──────────────────────────────────

export const handleIdentityLinked = guarded(
  "handleIdentityLinked",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [whoCodec, identityCodec],
      },
    } = event;
    const author = await ensureAuthor(whoCodec.toString());
    const identityHash = normalizeIdentityHash(identityCodec.toHex()); // [u8;32] -> 0x… (== beacon token_name, DR-01)
    if (!isWellFormedIdentityHash(identityHash)) {
      // indexer-6: a [u8;32] hash must be 0x+64 hex. A wrong shape signals a codec/upgrade mismatch;
      // we still store the chain value (source of truth) but flag it for an operator.
      logger.warn(
        `IdentityLinked for ${whoCodec.toString().slice(0, 8)}… has malformed identityHash=${identityHash} (expected 0x+64 hex) — storing as-is`,
      );
    }
    author.identityHash = identityHash;
    author.banned = false; // a (re-)bind clears the ban
    await author.save();
    logger.info(`identity linked → ${whoCodec.toString().slice(0, 8)}… hash=${identityHash}`);
  },
);

export const handleRevoked = guarded(
  "handleRevoked",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [whoCodec],
      },
    } = event;
    // On-chain revoke removes PkhOf/AccountOf but LEAVES the posts. Mark the author banned so the
    // feed can withhold/flag their (still-present) posts. identityHash kept as the historical record.
    // indexer-5: UPSERT (ensureAuthor), matching the verify-m4c fold which upserts unconditionally —
    // a future event-ordering change must not make the served feed and the gate disagree (A != B).
    const author = await ensureAuthor(whoCodec.toString());
    author.banned = true;
    await author.save();
    logger.info(`identity revoked (banned) → ${whoCodec.toString().slice(0, 8)}…`);
  },
);

export const handleStakeSet = guarded(
  "handleStakeSet",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [whoCodec, weightCodec],
      },
    } = event;
    const author = await ensureAuthor(whoCodec.toString());
    const weight = toBig(weightCodec);
    // indexer-7: stake = posting power. Audit every mutation so an operator can reconcile served
    // weights against on-chain TalkStake.StakeSet events.
    logger.info(`stake set → ${whoCodec.toString().slice(0, 8)}… weight=${weight}`);
    author.weight = weight;
    await author.save();
  },
);
