// Seed the adversarial fixture catalogue onto a LOCAL dev chain.
//
//   ./target/release/cogno-chain-node run --dev            # in another terminal, from the repo root
//   npm run seed                                           # then sweep with `npm run shoot`
//   npm run seed -- --ws ws://127.0.0.1:9955 --posts-only
//
// WHY THIS EXISTS. Every render defect found so far was found by pasting text into the real composer,
// which cannot produce most of what needs testing: a paste carries no raw C0 byte, cannot land on
// exactly 512 bytes, and turns a `"‮"` JS expression into six literal ASCII characters — which is
// how a whole spoof battery reached preprod having tested nothing. Fixtures are built from escapes and
// submitted as extrinsics, so the bytes on chain are exactly the bytes intended.
//
// AND WHY IT REFUSES ANYTHING BUT LOOPBACK. `delete_post` is a permanently vacant call index: content on
// this chain is FOREVER. Seeding 40-odd deliberate junk posts onto preprod would be an unfixable mistake,
// so the endpoint guard below is not a convenience — do not add a --force to it.
//
// `--dev` genesis seeds //Alice..//Eve with posting weight and voting power (see the runtime's
// `dev_weights`), so no Cardano, no db-sync and no identity bind is needed to write.

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { cogno } from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";
import { toHex } from "@polkadot-api/utils";
import { Binary } from "polkadot-api";
import { blake2b } from "blakejs";
import { POSTS, PROFILES } from "./fixtures/adversarial.mjs";
import { mintBindProof } from "./lib/cip8-mint.mjs";

function parseArgs(argv) {
  const opts = { ws: "ws://127.0.0.1:9944", postsOnly: false, profilesOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ws") opts.ws = argv[++i];
    else if (a === "--posts-only") opts.postsOnly = true;
    else if (a === "--profiles-only") opts.profilesOnly = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

/**
 * Refuse any endpoint that is not loopback.
 *
 * Parsed with `new URL` rather than a substring test on purpose: `ws://127.0.0.1.evil.com/` and
 * `wss://cogno.forum/rpc#127.0.0.1` both contain "127.0.0.1" and neither is local.
 */
function assertLoopback(ws) {
  let host;
  try {
    ({ hostname: host } = new URL(ws));
  } catch {
    throw new Error(`--ws is not a URL: ${ws}`);
  }
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!local) {
    throw new Error(
      `refusing to seed ${host}. This writes ~40 deliberate junk posts and content on this chain is ` +
        `PERMANENT (delete_post is a vacant call index). Point --ws at a local --dev node.`,
    );
  }
}

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
function devKeypair(uri) {
  return derive(uri);
}
function devSigner(uri) {
  const kp = devKeypair(uri);
  return getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign);
}

/**
 * Bind `uri`'s identity if it is not bound already.
 *
 * This is not optional plumbing. `Microblog::current_capacity` returns 0 for an account with no
 * `Capacity` row, the row is created ONLY by the identity-bind hook (`on_first_bind`), and the trusted
 * bind was removed — so an unbound account fails every post with `ExhaustsResources` however much
 * genesis weight it holds. `link_identity_signed` is unsigned and feeless: the CIP-8 proof IS the
 * authorization, so it is submitted with no signer at all.
 */
async function ensureBound(uri, genesisHex) {
  const kp = devKeypair(uri);
  const accountHex = toHex(kp.publicKey);
  const ss58 = ss58Address(kp.publicKey, 42);
  if (await api.query.CognoGate.PkhOf.getValue(ss58)) return { ss58, outcome: "already bound" };

  // A per-account seed so each dev identity is a distinct Cardano key, and re-running rebinds the same
  // one rather than minting a second identity for the same account.
  const seed = Buffer.from(blake2b(new TextEncoder().encode(`cogno-dev-fixture:${uri}`), undefined, 32));
  const { coseSign1, coseKey } = mintBindProof({ seed, accountHex, genesisHex });

  const tx = api.tx.CognoGate.link_identity_signed({
    cose_sign1: Binary.fromHex(coseSign1),
    cose_key: Binary.fromHex(coseKey),
  });
  try {
    // BARE (unsigned) + feeless — the same path the app uses (lib/chain/identity.ts): `getBareTx`
    // produces the unsigned extrinsic bytes and `client.submit` broadcasts them. Signing it instead
    // gives a signed origin, which `ensure_none` rejects as BadOrigin.
    const r = await client.submit(await tx.getBareTx());
    return {
      ss58,
      outcome: r.ok ? "bound" : `dispatch error: ${JSON.stringify(r.dispatchError ?? {}).slice(0, 90)}`,
    };
  } catch (e) {
    return { ss58, outcome: `BIND FAILED: ${String(e.message ?? e).slice(0, 140)}` };
  }
}

/** Submit one extrinsic and resolve to a short outcome string; never throws. */
async function submit(tx, signer, label) {
  try {
    const r = await tx.signAndSubmit(signer);
    return r.ok ? "ok" : `dispatch error: ${JSON.stringify(r.dispatchError ?? {}).slice(0, 90)}`;
  } catch (e) {
    return `FAILED: ${String(e.message ?? e).slice(0, 110)}`;
  }
}

const opts = parseArgs(process.argv.slice(2));
assertLoopback(opts.ws);

const client = createClient(getWsProvider(opts.ws));
const api = client.getTypedApi(cogno);

const spec = await client.getChainSpecData().catch(() => null);
const genesisHex = spec?.genesisHash ?? (await client.getBlockHash?.(0));
console.log(`seeding ${opts.ws}${spec ? ` (${spec.name})` : ""}\ngenesis ${genesisHex}\n`);

// Every writer must be identity-bound before it can post — see ensureBound.
const uris = ["//Alice", ...PROFILES.map((p) => p.uri)];
for (const uri of uris) {
  const { ss58, outcome } = await ensureBound(uri, genesisHex);
  console.log(`  bind  ${uri.padEnd(20)} ${ss58.slice(0, 8)}…  ${outcome}`);
  if (outcome.startsWith("BIND FAILED")) {
    console.log("\nCannot seed without a bind — an unbound account has no capacity row.");
    client.destroy();
    process.exit(1);
  }
}
console.log("");

const alice = devSigner("//Alice");
const results = [];

if (!opts.profilesOnly) {
  for (const f of POSTS) {
    const bytes = new TextEncoder().encode(f.body).length;
    // Bodies are submitted as raw UTF-8 — the pallet bounds LENGTH only and validates no characters,
    // which is exactly the property under test.
    const tx = api.tx.Microblog.post_message({ text: new TextEncoder().encode(f.body) });
    const outcome = await submit(tx, alice, f.label);
    results.push({ kind: "post", label: f.label, bytes, outcome, note: f.note });
    console.log(`  post  ${f.label.padEnd(20)} ${String(bytes).padStart(3)}B  ${outcome}`);
  }
}

if (!opts.postsOnly) {
  for (const p of PROFILES) {
    const enc = (s) => new TextEncoder().encode(s);
    const tx = api.tx.Profile.set_profile({
      display_name: enc(p.displayName),
      bio: enc(p.bio),
      avatar: enc(p.avatar),
      banner: enc(p.banner),
      location: enc(p.location),
      website: enc(p.website),
    });
    const outcome = await submit(tx, devSigner(p.uri), p.uri);
    results.push({ kind: "profile", label: p.uri, outcome, note: p.note });
    console.log(`  prof  ${p.uri.padEnd(20)}      ${outcome}`);
  }
}

const bad = results.filter((r) => r.outcome !== "ok");
console.log(`\n${results.length - bad.length}/${results.length} seeded`);
if (bad.length) {
  console.log("\nnot seeded:");
  for (const r of bad) console.log(`  ${r.label}: ${r.outcome}`);
}
console.log("\nwhat to look for:");
for (const r of results.filter((x) => x.outcome === "ok")) {
  console.log(`  ${r.label.padEnd(20)} ${r.note}`);
}

client.destroy();
process.exit(bad.length ? 1 : 0);
