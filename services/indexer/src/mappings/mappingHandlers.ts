import { SubstrateEvent } from "@subql/types";
import { Author, Post, Thread } from "../types";

// ── decode helpers ───────────────────────────────────────────────────────────
// Event args arrive as @polkadot/api Codec values; decode positionally + defensively.

/** UTF-8 body of a Microblog.Posts `text` (BoundedVec<u8>). `toU8a(true)` = bare bytes, no prefix. */
function textToUtf8(textCodec: any): string {
  if (!textCodec) return "";
  if (typeof textCodec.toUtf8 === "function") return textCodec.toUtf8();
  return Buffer.from(textCodec.toU8a(true)).toString("utf8");
}

/** Read the stored Post row at the CURRENT indexed block (api.query reads at the event's block). */
async function readStoredPost(
  postIdCodec: any,
): Promise<{ text: string; parentId?: string }> {
  const stored: any = await api.query.microblog.posts(postIdCodec);
  if (!stored || stored.isNone) return { text: "", parentId: undefined };
  const post = stored.unwrap();
  const parentId =
    post.parent && post.parent.isSome
      ? post.parent.unwrap().toString()
      : undefined;
  return { text: textToUtf8(post.text), parentId };
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

// ── handlers ───────────────────────────────────────────────────────────────

export async function handlePostCreated(event: SubstrateEvent): Promise<void> {
  const {
    event: {
      data: [idCodec, authorCodec],
    },
  } = event;
  const postId = idCodec.toString();
  const authorId = authorCodec.toString(); // AccountId -> SS58 (chain ss58Format)

  const blockHeight = event.block.block.header.number.toNumber();
  const timestamp = event.block.timestamp ?? new Date(0);

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
}

export async function handlePostDeleted(event: SubstrateEvent): Promise<void> {
  const {
    event: {
      data: [idCodec],
    },
  } = event;
  // SOFT-DELETE: keep the row, flip the tombstone (preserves thread structure + reproducibility).
  const post = await Post.get(idCodec.toString());
  if (post) {
    post.deleted = true;
    await post.save();
  }
}

export async function handleIdentityLinked(
  event: SubstrateEvent,
): Promise<void> {
  const {
    event: {
      data: [whoCodec, identityCodec],
    },
  } = event;
  const author = await ensureAuthor(whoCodec.toString());
  author.identityHash = identityCodec.toHex(); // [u8;32] -> 0x… (== beacon token_name, DR-01)
  author.banned = false; // a (re-)bind clears the ban
  await author.save();
}

export async function handleRevoked(event: SubstrateEvent): Promise<void> {
  const {
    event: {
      data: [whoCodec],
    },
  } = event;
  // On-chain revoke removes PkhOf/AccountOf but LEAVES the posts. Mark the author banned so the
  // feed can withhold/flag their (still-present) posts. identityHash kept as the historical record.
  const author = await Author.get(whoCodec.toString());
  if (author) {
    author.banned = true;
    await author.save();
  }
}

export async function handleStakeSet(event: SubstrateEvent): Promise<void> {
  const {
    event: {
      data: [whoCodec, weightCodec],
    },
  } = event;
  const author = await ensureAuthor(whoCodec.toString());
  author.weight = (weightCodec as any).toBigInt();
  await author.save();
}
