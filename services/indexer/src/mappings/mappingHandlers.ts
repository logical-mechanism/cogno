import { SubstrateEvent } from "@subql/types";
import { Author, Post, Thread } from "../types";
import {
  isWellFormedIdentityHash,
  normalizeIdentityHash,
  normalizeParentId,
  timestampDecision,
  utf8FromBytes,
} from "./pure";

// ── decode helpers ───────────────────────────────────────────────────────────
// Event args arrive as @polkadot/api Codec values; decode positionally + defensively.
// The pure branches (utf8/timestamp/parentId normalization) live in ./pure for unit testing.

/** UTF-8 body of a Microblog.Posts `text` (BoundedVec<u8>). `toU8a(true)` = bare bytes, no prefix. */
function textToUtf8(textCodec: any): string {
  if (!textCodec) return "";
  if (typeof textCodec.toUtf8 === "function") return textCodec.toUtf8();
  return utf8FromBytes(textCodec.toU8a(true));
}

/** Read the stored Post row at the CURRENT indexed block (api.query reads at the event's block). */
async function readStoredPost(
  postIdCodec: any,
): Promise<{ text: string; parentId?: string }> {
  const stored: any = await api.query.microblog.posts(postIdCodec);
  if (!stored || stored.isNone) {
    // indexer-12: storage row absent right after PostCreated => events/storage divergence. We do
    // not throw (the empty body is recoverable; the chain remains source of truth) but warn loudly.
    logger.warn(
      `post #${postIdCodec.toString()} not found in storage at its creating block — indexing empty body (events/storage divergence?)`,
    );
    return { text: "", parentId: undefined };
  }
  const post = stored.unwrap();
  const rawParentId =
    post.parent && post.parent.isSome
      ? post.parent.unwrap().toString()
      : undefined;
  return { text: textToUtf8(post.text), parentId: normalizeParentId(rawParentId) };
}

/** Upsert an Author, creating a fresh unbound/unbanned row if absent. */
async function ensureAuthor(id: string): Promise<Author> {
  let author = await Author.get(id);
  if (!author) {
    author = Author.create({
      id,
      identityHash: undefined,
      banned: false,
      weight: undefined,
      postCount: 0,
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
 * whole "anyone can reproduce the feed" property. The frontend's PAPI-direct fallback degrades
 * gracefully while an operator investigates the logged block/event.
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

// ── handlers ───────────────────────────────────────────────────────────────

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

    const { text, parentId } = await readStoredPost(idCodec);

    const author = await ensureAuthor(authorId);
    author.postCount += 1;

    const post = Post.create({
      id: postId,
      authorId: author.id,
      text,
      parentId, // undefined => top-level (NULL column)
      blockHeight,
      timestamp,
      deleted: false,
    });

    await Promise.all([author.save(), post.save()]);

    // Thread bookkeeping — a convenience aggregate keyed on the IMMEDIATE parent (or self for a
    // top-level post). NOTE: this is the immediate-parent segment, NOT the transitive top-level
    // ancestor — for a depth-2+ reply it groups under the direct parent, not the conversation root.
    // The feed's thread view does not rely on this (it uses the faithful Post.parent → `replies`
    // reverse relation); Thread is an optional, deterministic convenience entity.
    const rootId = parentId ?? postId;
    let thread = await Thread.get(rootId);
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
    logger.debug(`thread #${rootId} ${parentId ? "updated" : "created"}: replyCount=${thread.replyCount}`);

    logger.info(`indexed post #${postId} by ${authorId.slice(0, 8)}… @#${blockHeight}${parentId ? ` ↳#${parentId}` : ""}`);
  },
);

export const handlePostDeleted = guarded(
  "handlePostDeleted",
  async (event: SubstrateEvent): Promise<void> => {
    const {
      event: {
        data: [idCodec],
      },
    } = event;
    // SOFT-DELETE: keep the row, flip the tombstone (preserves thread structure + reproducibility).
    const id = idCodec.toString();
    const post = await Post.get(id);
    if (post) {
      post.deleted = true;
      await post.save();
      logger.info(`soft-deleted post #${id}`);
    } else {
      // indexer-13: a delete for a post we never indexed (orphaned/out-of-order event, e.g. after a
      // reorg). We skip rather than fabricate a tombstone row, but surface it for investigation.
      logger.warn(`PostDeleted for unknown post #${id} — nothing to soft-delete (out-of-order/orphaned event?)`);
    }
  },
);

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
    const weight = (weightCodec as any).toBigInt();
    // indexer-7: stake = posting power. Audit every mutation so an operator can reconcile served
    // weights against on-chain TalkStake.StakeSet events.
    logger.info(`stake set → ${whoCodec.toString().slice(0, 8)}… weight=${weight}`);
    author.weight = weight;
    await author.save();
  },
);
