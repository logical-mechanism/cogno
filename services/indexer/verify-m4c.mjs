// L4-M4c — the COMMITTED re-derivation gate (DR-08 / docs/L4-reading.md §6.5, §11).
//
// A skeptic's independent fold: walk the chain from genesis on the --state-pruning archive node,
// fold the PUBLIC Microblog/Profile/CognoGate/TalkStake events into the indexer's served entities,
// then diff byte-for-byte against what the SubQuery indexer SERVES over GraphQL. This imports ZERO
// indexer code (no schema, no mappings, no DB) — it reads only public on-chain events via
// @polkadot/api, exactly as any third party would, and REIMPLEMENTS the saturating reverse-then-apply
// tally fold here (so the fold is genuinely independent, not the indexer's own code marking its own
// homework). If A (re-derivation) == B (served), "open reads / anyone can reproduce the feed" is a
// tested property, not a slogan. Any mismatch is a HARD FAIL.
//
// Covered (A==B):
//   POST    {author, text, parent, quote, blockHeight, isPoll, upWeight, downWeight, upCount,
//            downCount, score, repostCount}
//   AUTHOR  {banned, identityHash, weight, postCount, followerCount, followingCount, displayName,
//            bio, avatar, pinnedPostId}
//   VOTE / REPOST / FOLLOW / POLL / POLLOPTION / POLLVOTE entity sets.
// DELIBERATELY EXCLUDED (derived/noisy views, both sides agree they are not folded): Post.timestamp
//   (block wall-clock) and the Thread convenience aggregates (the feed reads Post.replies).
//
// Usage:  WS=ws://127.0.0.1:9944 GQL=http://127.0.0.1:3000/ node verify-m4c.mjs
//         (GENESIS pin auto-read from ./GENESIS.txt; override with env GENESIS=0x… for a local --dev)
import { ApiPromise, WsProvider } from "@polkadot/api";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const GQL = process.env.GQL || "http://127.0.0.1:3000/";
const here = dirname(fileURLToPath(import.meta.url));
const PUBLISHED_GENESIS = (
  process.env.GENESIS ||
  (() => { try { return readFileSync(join(here, "GENESIS.txt"), "utf8").trim(); } catch { return ""; } })()
).toLowerCase();

async function gql(query) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) throw new Error("GraphQL error: " + JSON.stringify(j.errors));
  return j.data;
}

const utf8 = (t) =>
  typeof t.toUtf8 === "function" ? t.toUtf8() : Buffer.from(t.toU8a(true)).toString("utf8");

/**
 * Fetch ALL rows of an entity over GraphQL, paginating in deterministic id order. The independent
 * fold (section A) is uncapped, so the served side must be too — a fixed `first: 1000` would make the
 * gate FALSELY report a count mismatch the moment any social set (votes/follows/options grow fastest)
 * exceeds 1000 rows. `orderBy: ID_ASC` pins a deterministic window so paging never skips/dupes a row.
 */
async function gqlAll(entity, fields) {
  const PAGE = 1000;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const data = await gql(`{ ${entity}(first: ${PAGE}, offset: ${offset}, orderBy: ID_ASC) { nodes { ${fields} } } }`);
    const nodes = data[entity].nodes;
    out.push(...nodes);
    if (nodes.length < PAGE) break;
  }
  return out;
}

// ── the INDEPENDENT saturating tally fold (a plain-JS reimplementation of pallets/microblog
//    `vote`/`clear_vote`/`cast_poll_vote` + the indexer's pure.ts — kept SEPARATE on purpose). ──
const satSub = (a, b) => (a > b ? a - b : 0n); // u128 saturating_sub, floors at 0n
const satDec = (n) => (n > 0 ? n - 1 : 0); // u32 saturating_sub(1)
const normDir = (raw) => {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "up") return "Up";
  if (s === "down") return "Down";
  throw new Error(`unknown VoteDir variant: ${raw}`);
};
// reverse `prev` (if any) then apply `next` (if any) on a {upWeight,downWeight,upCount,downCount}.
function foldVote(t, prev, next) {
  if (prev) {
    if (prev.dir === "Up") { t.upWeight = satSub(t.upWeight, prev.weight); t.upCount = satDec(t.upCount); }
    else { t.downWeight = satSub(t.downWeight, prev.weight); t.downCount = satDec(t.downCount); }
  }
  if (next) {
    if (next.dir === "Up") { t.upWeight += next.weight; t.upCount += 1; }
    else { t.downWeight += next.weight; t.downCount += 1; }
  }
  t.score = t.upWeight - t.downWeight;
  return t;
}

// bigint-aware stringify for mismatch prints.
const j = (v) => JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? `${val}` : val));

/**
 * Generic byte-for-byte comparator over the UNION of ids (so neither side can hide an extra row).
 * Compares each listed field via String() equality (bigint→decimal, null→"null", bool→"true"),
 * which is exactly how the served GraphQL serializes BigInt (string) / nullable columns (null).
 */
function compare(label, fold, served, fields) {
  let ok = true;
  let mism = 0;
  if (fold.size !== served.size) {
    ok = false;
    console.log(`  ✗ ${label} COUNT: re-derived ${fold.size} != indexer ${served.size}`);
  }
  const ids = [...new Set([...fold.keys(), ...served.keys()])].sort();
  for (const id of ids) {
    const a = fold.get(id), b = served.get(id);
    const same = a && b && fields.every((f) => String(a[f]) === String(b[f]));
    if (!same) {
      ok = false; mism++;
      console.log(`  ✗ ${label} ${id}\n      chain  =${j(a)}\n      indexer=${j(b)}`);
    }
  }
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${fold.size} row(s) ${ok ? "match" : `— ${mism} mismatch`}`);
  return ok;
}

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(WS) });

  // (0) CHAIN-IDENTITY GUARD — both the WS node AND the GraphQL endpoint must be the chain the
  //     published pin names (else we'd "verify" against a stale / wrong-chain indexer DB).
  const genesis = api.genesisHash.toHex().toLowerCase();
  const meta = (await gql(`{ _metadata { genesisHash chain lastProcessedHeight targetHeight indexerHealthy } }`))._metadata;
  const gqlGenesis = (meta.genesisHash || "").toLowerCase();
  console.log("live node genesis :", genesis);
  console.log("indexer genesis   :", gqlGenesis);
  console.log("published pin     :", PUBLISHED_GENESIS || "(none set)");
  if (PUBLISHED_GENESIS && genesis !== PUBLISHED_GENESIS)
    throw new Error(`DIFFERENT CHAIN — live node ${genesis} != published ${PUBLISHED_GENESIS}`);
  if (gqlGenesis && gqlGenesis !== genesis)
    throw new Error(`INDEXER ON A DIFFERENT CHAIN — GraphQL ${gqlGenesis} != node ${genesis}`);

  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const finalizedNum = (await api.rpc.chain.getHeader(finalizedHash)).number.toNumber();

  // (0b) CAUGHT-UP GUARD — the fold range and the served state must be the SAME snapshot.
  const lph = Number(meta.lastProcessedHeight);
  console.log(`indexer health    : healthy=${meta.indexerHealthy} lastProcessed=${lph} target=${meta.targetHeight} nodeFinalized=${finalizedNum}`);
  if (meta.indexerHealthy === false) throw new Error("INDEXER UNHEALTHY — refusing to compare");
  const upTo = Number.isFinite(lph) && lph > 0 ? Math.min(finalizedNum, lph) : finalizedNum;
  console.log(`\nfolding public events from genesis → #${upTo} (indexer-processed snapshot) …\n`);

  // (A) THE INDEPENDENT FOLD (from genesis, public events only)
  const posts = new Map(); // id -> {author,text,parent,quote,blockHeight,isPoll,upWeight,downWeight,upCount,downCount,score,repostCount}
  const authors = new Map(); // ss58 -> {banned,identityHash,weight,postCount,followerCount,followingCount,displayName,bio,avatar,pinnedPostId}
  const votes = new Map(); // postId-voterId -> {postId,voterId,dir,weight}
  const reposts = new Map(); // postId-reposterId -> {postId,reposterId,blockHeight}
  const follows = new Map(); // followerId-followeeId -> {followerId,followeeId}
  const polls = new Map(); // pollId -> {postId}
  const pollOptions = new Map(); // pollId-index -> {pollId,index,label,weight,count}
  const pollVotes = new Map(); // pollId-voterId -> {pollId,voterId,option,weight}

  // THE author-creation rule (mirrors mappingHandlers `ensureAuthor`): ANY handled event naming an
  // account lazily creates it here, so the re-derived author SET == the served author set.
  const author = (id) => {
    let a = authors.get(id);
    if (!a) {
      a = {
        banned: false, identityHash: null, weight: null, postCount: 0,
        followerCount: 0, followingCount: 0,
        displayName: null, bio: null, avatar: null, pinnedPostId: null,
      };
      authors.set(id, a);
    }
    return a;
  };
  const tallyOf = (rec) => ({ upWeight: rec.upWeight, downWeight: rec.downWeight, upCount: rec.upCount, downCount: rec.downCount });
  const writeTally = (rec, t) => { rec.upWeight = t.upWeight; rec.downWeight = t.downWeight; rec.upCount = t.upCount; rec.downCount = t.downCount; rec.score = t.score; };

  for (let n = 1; n <= upTo; n++) {
    const hash = await api.rpc.chain.getBlockHash(n);
    const at = await api.at(hash);
    const events = await at.query.system.events();
    for (const { event } of events) {
      const { section, method, data } = event;

      if (section === "microblog" && method === "PostCreated") {
        const acct = data[1].toString();
        author(acct).postCount += 1;
        const stored = await at.query.microblog.posts(data[0]); // state AFTER block n → row present
        // MIRROR the handler exactly: handlePostCreated creates the Post UNCONDITIONALLY (empty body on
        // a None storage read — its documented "recoverable" path), so verify-m4c must too, or the gate
        // would false-fail on the very recovery it is meant to prove. (Chain-impossible on a healthy
        // node — Posts::insert is in the same extrinsic as PostCreated — but kept symmetric on purpose.)
        const p = stored.isSome ? stored.unwrap() : null;
        posts.set(data[0].toString(), {
          author: acct,
          text: p ? utf8(p.text) : "",
          parent: p && p.parent.isSome ? p.parent.unwrap().toString() : null,
          quote: p && p.quote && p.quote.isSome ? p.quote.unwrap().toString() : null,
          blockHeight: n,
          isPoll: false,
          upWeight: 0n, downWeight: 0n, upCount: 0, downCount: 0, score: 0n,
          repostCount: 0,
        });
      } else if (section === "microblog" && method === "Voted") {
        const postId = data[0].toString(), voterId = data[1].toString();
        author(voterId);
        const rec = posts.get(postId);
        if (!rec) throw new Error(`Voted on unknown post #${postId}`);
        const dir = normDir(data[2].type ?? data[2].toString());
        const weight = BigInt(data[3].toString());
        const voteId = `${postId}-${voterId}`;
        const prev = votes.get(voteId) || null;
        writeTally(rec, foldVote(tallyOf(rec), prev, { dir, weight }));
        votes.set(voteId, { postId, voterId, dir, weight });
      } else if (section === "microblog" && method === "VoteCleared") {
        const postId = data[0].toString(), voterId = data[1].toString();
        author(voterId);
        const voteId = `${postId}-${voterId}`;
        const prev = votes.get(voteId);
        if (!prev) throw new Error(`VoteCleared with no prior Vote ${voteId}`);
        const rec = posts.get(postId);
        if (!rec) throw new Error(`VoteCleared on unknown post #${postId}`);
        writeTally(rec, foldVote(tallyOf(rec), prev, null));
        votes.delete(voteId);
      } else if (section === "microblog" && method === "Reposted") {
        const postId = data[0].toString(), reposterId = data[1].toString();
        author(reposterId);
        const rec = posts.get(postId);
        if (!rec) throw new Error(`Reposted unknown post #${postId}`);
        rec.repostCount += 1;
        reposts.set(`${postId}-${reposterId}`, { postId, reposterId, blockHeight: n });
      } else if (section === "microblog" && method === "Followed") {
        const followerId = data[0].toString(), followeeId = data[1].toString();
        author(followerId); author(followeeId);
        follows.set(`${followerId}-${followeeId}`, { followerId, followeeId });
        author(followerId).followingCount += 1;
        author(followeeId).followerCount += 1;
      } else if (section === "microblog" && method === "Unfollowed") {
        const followerId = data[0].toString(), followeeId = data[1].toString();
        author(followerId); author(followeeId);
        const followId = `${followerId}-${followeeId}`;
        if (!follows.has(followId)) throw new Error(`Unfollowed with no prior Follow ${followId}`);
        follows.delete(followId);
        author(followerId).followingCount = satDec(author(followerId).followingCount);
        author(followeeId).followerCount = satDec(author(followeeId).followerCount);
      } else if (section === "microblog" && method === "PollCreated") {
        const postId = data[0].toString();
        const rec = posts.get(postId);
        if (!rec) throw new Error(`PollCreated for unknown post #${postId}`);
        rec.isPoll = true;
        const stored = await at.query.microblog.polls(data[0]);
        const opts = stored.isSome ? stored.unwrap().options.map((o) => utf8(o)) : [];
        polls.set(postId, { postId });
        opts.forEach((label, i) =>
          pollOptions.set(`${postId}-${i}`, { pollId: postId, index: i, label, weight: 0n, count: 0 }),
        );
      } else if (section === "microblog" && method === "PollVoted") {
        const pollId = data[0].toString(), voterId = data[1].toString();
        author(voterId);
        const option = Number(data[2].toString());
        const weight = BigInt(data[3].toString());
        if (!polls.has(pollId)) throw new Error(`PollVoted on non-poll #${pollId}`);
        const pvId = `${pollId}-${voterId}`;
        const prev = pollVotes.get(pvId);
        if (prev) {
          const prevOpt = pollOptions.get(`${pollId}-${prev.option}`);
          if (!prevOpt) throw new Error(`PollVote points at missing option ${pollId}-${prev.option}`);
          prevOpt.weight = satSub(prevOpt.weight, prev.weight);
          prevOpt.count = satDec(prevOpt.count);
        }
        // same-option re-cast: Map.get returns the SAME object, so reverse-then-apply lands on one
        // option (matching the handler's save-then-reget), and a cross-option recast hits two.
        const newOpt = pollOptions.get(`${pollId}-${option}`);
        if (!newOpt) throw new Error(`PollVoted for out-of-range option ${pollId}-${option}`);
        newOpt.weight += weight;
        newOpt.count += 1;
        pollVotes.set(pvId, { pollId, voterId, option, weight });
      } else if (section === "profile" && method === "ProfileSet") {
        const who = data[0].toString();
        const a = author(who);
        const stored = await at.query.profile.profiles(data[0]);
        if (stored.isSome) {
          const p = stored.unwrap();
          a.displayName = utf8(p.displayName ?? p.display_name);
          a.bio = utf8(p.bio);
          a.avatar = utf8(p.avatar);
        } else {
          a.displayName = ""; a.bio = ""; a.avatar = "";
        }
      } else if (section === "profile" && method === "ProfileCleared") {
        const a = author(data[0].toString());
        a.displayName = null; a.bio = null; a.avatar = null;
      } else if (section === "profile" && method === "PostPinned") {
        author(data[0].toString()).pinnedPostId = data[1].toString();
      } else if (section === "profile" && method === "PostUnpinned") {
        author(data[0].toString()).pinnedPostId = null;
      } else if (section === "cognoGate" && method === "IdentityLinked") {
        const a = author(data[0].toString());
        a.identityHash = data[1].toHex();
        a.banned = false; // a (re-)bind clears the ban
      } else if (section === "cognoGate" && method === "Revoked") {
        author(data[0].toString()).banned = true; // identityHash kept as historical record
      } else if (section === "talkStake" && method === "StakeSet") {
        author(data[0].toString()).weight = data[1].toString();
      }
    }
  }
  console.log(
    `re-derived ${posts.size} posts, ${authors.size} authors, ${votes.size} votes, ${reposts.size} reposts, ${follows.size} follows, ${polls.size} polls, ${pollOptions.size} options, ${pollVotes.size} pollVotes\n`,
  );

  // (B) WHAT THE INDEXER SERVES (current state over GraphQL — historical rows collapsed). Every set
  //     is fetched IN FULL via gqlAll (paginated) so the comparison can never false-fail on size.
  const sPosts = new Map(
    (await gqlAll("posts", "id authorId text parentId quoteId blockHeight isPoll upWeight downWeight upCount downCount score repostCount")).map((p) => [
      p.id,
      {
        author: p.authorId, text: p.text, parent: p.parentId ?? null, quote: p.quoteId ?? null,
        blockHeight: p.blockHeight, isPoll: p.isPoll, upWeight: p.upWeight, downWeight: p.downWeight,
        upCount: p.upCount, downCount: p.downCount, score: p.score, repostCount: p.repostCount,
      },
    ]),
  );
  const sAuthors = new Map(
    (await gqlAll("authors", "id banned identityHash weight postCount followerCount followingCount displayName bio avatar pinnedPostId")).map((a) => [
      a.id,
      {
        banned: a.banned, identityHash: a.identityHash ?? null, weight: a.weight ?? null,
        postCount: a.postCount, followerCount: a.followerCount, followingCount: a.followingCount,
        displayName: a.displayName ?? null, bio: a.bio ?? null, avatar: a.avatar ?? null,
        pinnedPostId: a.pinnedPostId ?? null,
      },
    ]),
  );
  const sVotes = new Map(
    (await gqlAll("votes", "id postId voterId dir weight")).map((v) => [v.id, { postId: v.postId, voterId: v.voterId, dir: v.dir, weight: v.weight }]),
  );
  const sReposts = new Map(
    (await gqlAll("reposts", "id postId reposterId blockHeight")).map((r) => [r.id, { postId: r.postId, reposterId: r.reposterId, blockHeight: r.blockHeight }]),
  );
  const sFollows = new Map(
    (await gqlAll("follows", "id followerId followeeId")).map((f) => [f.id, { followerId: f.followerId, followeeId: f.followeeId }]),
  );
  const sPolls = new Map(
    (await gqlAll("polls", "id postId")).map((p) => [p.id, { postId: p.postId }]),
  );
  const sOptions = new Map(
    (await gqlAll("pollOptions", "id pollId index label weight count")).map((o) => [o.id, { pollId: o.pollId, index: o.index, label: o.label, weight: o.weight, count: o.count }]),
  );
  const sPollVotes = new Map(
    (await gqlAll("pollVotes", "id pollId voterId option weight")).map((v) => [v.id, { pollId: v.pollId, voterId: v.voterId, option: v.option, weight: v.weight }]),
  );

  // (C) BYTE-FOR-BYTE DIFF — every entity, union of ids so neither side hides a row.
  let ok = true;
  ok = compare("post", posts, sPosts, ["author", "text", "parent", "quote", "blockHeight", "isPoll", "upWeight", "downWeight", "upCount", "downCount", "score", "repostCount"]) && ok;
  ok = compare("author", authors, sAuthors, ["banned", "identityHash", "weight", "postCount", "followerCount", "followingCount", "displayName", "bio", "avatar", "pinnedPostId"]) && ok;
  ok = compare("vote", votes, sVotes, ["postId", "voterId", "dir", "weight"]) && ok;
  ok = compare("repost", reposts, sReposts, ["postId", "reposterId", "blockHeight"]) && ok;
  ok = compare("follow", follows, sFollows, ["followerId", "followeeId"]) && ok;
  ok = compare("poll", polls, sPolls, ["postId"]) && ok;
  ok = compare("pollOption", pollOptions, sOptions, ["pollId", "index", "label", "weight", "count"]) && ok;
  ok = compare("pollVote", pollVotes, sPollVotes, ["pollId", "voterId", "option", "weight"]) && ok;

  console.log(
    ok
      ? `\n🎯 M4c VERIFIED — posts/authors + the social surface (votes, reposts, follows, polls, poll-options, poll-votes) are byte-for-byte reproducible from genesis events (A == B), including the stake-weighted reverse-then-apply tallies. Open reads honestly backed.`
      : `\n✗ M4c FAILED — the indexer diverges from an independent re-derivation. Open-reads claim NOT backed.`,
  );
  await api.disconnect();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("M4c verify error:", e); process.exit(1); });
