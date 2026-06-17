// L4-M4c — the COMMITTED v1 re-derivation gate (DR-08 / docs/L4-reading.md §6.5, §11).
//
// A skeptic's independent fold: walk the chain from genesis on the --state-pruning archive node,
// fold the PUBLIC Microblog/CognoGate/TalkStake events into the indexer's served entities, then diff
// byte-for-byte against what the SubQuery indexer SERVES over GraphQL. This imports ZERO indexer
// code (no schema, no mappings, no DB) — it reads only public on-chain events via @polkadot/api,
// exactly as any third party would. If A (re-derivation) == B (served), "open reads / anyone can
// reproduce the feed" is a tested property, not a slogan. Any mismatch is a HARD FAIL.
//
// Covered (A==B): per POST {author, text, parent, blockHeight, deleted}; per AUTHOR {banned,
// identityHash, weight, postCount}. NOT folded: Post.timestamp (block wall-clock — verifiable but
// noisy here) and the Thread convenience aggregates (a derived view; the feed reads Post.replies).
//
// Usage:  WS=ws://127.0.0.1:9944 GQL=http://127.0.0.1:3000/ node verify-m4c.mjs
//         (GENESIS pin auto-read from ./GENESIS.txt; override with env GENESIS=0x…)
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

  // (0b) CAUGHT-UP GUARD — the fold range and the served state must be the SAME snapshot. If the
  //      indexer trails the finalized head, the comparison would be two unsynchronized views.
  const lph = Number(meta.lastProcessedHeight);
  console.log(`indexer health    : healthy=${meta.indexerHealthy} lastProcessed=${lph} target=${meta.targetHeight} nodeFinalized=${finalizedNum}`);
  if (meta.indexerHealthy === false)
    throw new Error("INDEXER UNHEALTHY — refusing to compare");
  // Compare over the SAME snapshot: fold only up to what the indexer has PROCESSED. It indexes
  // finalized blocks and naturally lags the node's finalized head by a few blocks, so folding to
  // the node head would race; folding to lph makes both sides the identical range. All M4 seed
  // events are long-finalized + processed, so coverage is total.
  const upTo = Number.isFinite(lph) && lph > 0 ? Math.min(finalizedNum, lph) : finalizedNum;
  console.log(`\nfolding public events from genesis → #${upTo} (indexer-processed snapshot) …\n`);

  // (A) THE INDEPENDENT FOLD (from genesis, public events only)
  const posts = new Map();   // id -> { author, text, parent, blockHeight, deleted }
  const authors = new Map(); // ss58 -> { banned, identityHash, weight, postCount }
  const author = (id) => {
    let a = authors.get(id);
    if (!a) { a = { banned: false, identityHash: null, weight: null, postCount: 0 }; authors.set(id, a); }
    return a;
  };
  for (let n = 1; n <= upTo; n++) {
    const hash = await api.rpc.chain.getBlockHash(n);
    const at = await api.at(hash);
    const events = await at.query.system.events();
    for (const { event } of events) {
      const { section, method, data } = event;
      if (section === "microblog" && method === "PostCreated") {
        const [idC, authorC] = data;
        const acct = authorC.toString();
        author(acct).postCount += 1;
        const stored = await at.query.microblog.posts(idC); // state AFTER block n → row present
        if (stored.isSome) {
          const p = stored.unwrap();
          posts.set(idC.toString(), {
            author: acct,
            text: utf8(p.text),
            parent: p.parent.isSome ? p.parent.unwrap().toString() : null,
            blockHeight: n,
            deleted: false,
          });
        }
      } else if (section === "microblog" && method === "PostDeleted") {
        const rec = posts.get(data[0].toString());
        if (rec) rec.deleted = true; // soft-delete: keep, tombstone
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
  console.log(`re-derived ${posts.size} posts, ${authors.size} authors from events\n`);

  // (B) WHAT THE INDEXER SERVES (current state over GraphQL — historical rows collapsed)
  const pData = await gql(
    `{ posts(first: 1000, orderBy: ID_ASC) { totalCount nodes { id authorId text parentId blockHeight deleted } } }`,
  );
  const served = new Map(
    pData.posts.nodes.map((p) => [
      p.id,
      { author: p.authorId, text: p.text, parent: p.parentId ?? null, blockHeight: p.blockHeight, deleted: p.deleted },
    ]),
  );
  const aData = await gql(`{ authors(first: 1000) { nodes { id banned identityHash weight postCount } } }`);
  const servedAuthors = new Map(
    aData.authors.nodes.map((a) => [
      a.id,
      { banned: a.banned, identityHash: a.identityHash ?? null, weight: a.weight ?? null, postCount: a.postCount },
    ]),
  );

  // (C) BYTE-FOR-BYTE DIFF — posts (union of ids, so neither side can hide an extra row)
  let ok = true;
  if (posts.size !== served.size) { ok = false; console.log(`✗ post count: re-derived ${posts.size} != indexer ${served.size}`); }
  for (const id of [...new Set([...posts.keys(), ...served.keys()])].sort((a, b) => Number(a) - Number(b))) {
    const a = posts.get(id), b = served.get(id);
    const same = a && b && a.author === b.author && a.text === b.text &&
      String(a.parent) === String(b.parent) && a.blockHeight === b.blockHeight && a.deleted === b.deleted;
    if (same) console.log(`  ✓ #${id}${a.deleted ? " (deleted)" : ""}${a.parent ? ` ↳#${a.parent}` : ""}  ${JSON.stringify(a.text.slice(0, 44))}`);
    else { ok = false; console.log(`  ✗ #${id}\n      chain  =${JSON.stringify(a)}\n      indexer=${JSON.stringify(b)}`); }
  }

  // (C') author state — UNION of both sides; compares banned + identityHash + weight + postCount
  console.log("");
  if (authors.size !== servedAuthors.size) { ok = false; console.log(`✗ author count: re-derived ${authors.size} != indexer ${servedAuthors.size}`); }
  for (const id of new Set([...authors.keys(), ...servedAuthors.keys()])) {
    const a = authors.get(id), b = servedAuthors.get(id);
    const same = a && b && a.banned === b.banned && a.identityHash === b.identityHash &&
      String(a.weight) === String(b.weight) && a.postCount === b.postCount;
    if (!same) { ok = false; console.log(`  ✗ author ${id.slice(0, 8)}…\n      chain  =${JSON.stringify(a)}\n      indexer=${JSON.stringify(b)}`); }
    else if (a.banned) console.log(`  ✓ author ${id.slice(0, 8)}… banned (revoked), state matches`);
    else console.log(`  ✓ author ${id.slice(0, 8)}… postCount=${a.postCount} weight=${a.weight} bound=${a.identityHash ? "y" : "n"}`);
  }

  console.log(
    ok
      ? `\n🎯 M4c VERIFIED — posts {author,text,parent,blockHeight,deleted} + authors {banned,identityHash,weight,postCount} are byte-for-byte reproducible from genesis events (A == B). Open reads honestly backed.`
      : `\n✗ M4c FAILED — the indexer diverges from an independent re-derivation. Open-reads claim NOT backed.`,
  );
  await api.disconnect();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("M4c verify error:", e); process.exit(1); });
