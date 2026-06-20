// fetch-chainspec.mjs — reconstruct a genesis-identical RAW chain spec from a running node's RPC.
//
// A tracking (non-validator) node must share the network's EXACT genesis — same genesis block hash —
// or it forms a different chain and never peers/syncs. The authoritative `raw.json` normally lives on
// the validator host (and embeds the ~500 KB genesis wasm, so it is impractical to copy by hand). This
// script rebuilds it from the node's SAFE, read-only RPC instead: it enumerates every storage key at
// the genesis block (`state_getKeysPaged`) and reads each value AS-OF genesis (`state_getStorage`),
// which is exactly the `genesis.raw.top` map. Copying those byte-for-byte reproduces the genesis state
// root → the genesis block hash matches by construction (printed at the end; verify it). No unsafe RPC
// (`state_getPairs`/`sync_state_genSyncSpec`) and no host file access required.
//
// Usage (point at the HTTP JSON-RPC endpoint — a ws:// proxy usually also accepts HTTP POST):
//   node scripts/fetch-chainspec.mjs http://<host>/rpc \
//     --bootnode /ip4/<host>/tcp/30333/p2p/<peerId> \
//     --out network/raw.json
//
// Flags (env fallbacks in parens), all optional except the RPC URL:
//   --rpc <url>            (RPC_URL)        the node's HTTP JSON-RPC endpoint  [default http://127.0.0.1:9944]
//   --bootnode <multiaddr> (BOOTNODE)       repeatable; baked into the spec's bootNodes
//   --out <path>           (OUT)            output file                       [default ./network/raw.json]
//   --id <chain-id>        (CHAIN_ID)       spec id / base-path subdir        [default <system_chain lowercased>]
//   --protocol-id <id>     (PROTOCOL_ID)    libp2p protocol id                [default <chain-id>]
//   --chain-type <type>    (CHAIN_TYPE)     Development|Local|Live            [default Live]
//
// The chain NAME + properties (ss58/decimals/symbol) are read from the node (system_chain /
// system_properties). Run with the nvm node (the snap node swallows stdout — see CLAUDE.md).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ── tiny arg parser ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = { bootnode: [] };
let positionalRpc = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--bootnode") flags.bootnode.push(argv[++i]);
  else if (a === "--rpc") flags.rpc = argv[++i];
  else if (a === "--out") flags.out = argv[++i];
  else if (a === "--id") flags.id = argv[++i];
  else if (a === "--protocol-id") flags.protocolId = argv[++i];
  else if (a === "--chain-type") flags.chainType = argv[++i];
  else if (!a.startsWith("--") && !positionalRpc) positionalRpc = a;
  else throw new Error(`unrecognized argument: ${a}`);
}

const RPC = flags.rpc || positionalRpc || process.env.RPC_URL || "http://127.0.0.1:9944";
const OUT = resolve(flags.out || process.env.OUT || "./network/raw.json");
const BOOTNODES = flags.bootnode.length
  ? flags.bootnode
  : (process.env.BOOTNODE ? [process.env.BOOTNODE] : []);
const CHAIN_TYPE = flags.chainType || process.env.CHAIN_TYPE || "Live";

if (!/^https?:\/\//.test(RPC)) {
  console.error(
    `RPC endpoint must be http(s): got "${RPC}". A node's ws:// proxy usually also accepts HTTP POST on the\n` +
    `same path — pass that (e.g. http://host/rpc). This script speaks JSON-RPC over HTTP, not WebSocket.`,
  );
  process.exit(1);
}

let rpcId = 0;
async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message} (code ${json.error.code})`);
  return json.result;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

console.log(`Reconstructing a raw chain spec from ${RPC}`);

// 1. Identity + the genesis block hash (everything is read AS-OF this hash).
const genesisHash = await rpc("chain_getBlockHash", [0]);
const name = await rpc("system_chain");
const properties = await rpc("system_properties");
const id = flags.id || process.env.CHAIN_ID || name.toLowerCase().replace(/\s+/g, "_");
const protocolId = flags.protocolId || process.env.PROTOCOL_ID || id;
console.log(`  chain   : ${name} (id ${id}, protocolId ${protocolId})`);
console.log(`  genesis : ${genesisHash}`);

// 2. Enumerate EVERY storage key at genesis (paged; safe RPC).
const keys = [];
let startKey = "";
for (;;) {
  const batch = await rpc("state_getKeysPaged", ["0x", 1000, startKey, genesisHash]);
  if (!batch || batch.length === 0) break;
  keys.push(...batch);
  if (batch.length < 1000) break;
  startKey = batch[batch.length - 1];
}
console.log(`  keys    : ${keys.length} genesis storage entries`);

// 3. Read each value as-of genesis → the raw `top` map (concurrency-limited).
const top = {};
const values = await mapLimit(keys, 16, (k) => rpc("state_getStorage", [k, genesisHash]));
keys.forEach((k, i) => {
  if (values[i] != null) top[k] = values[i]; // null ⇒ key absent at genesis (shouldn't happen); skip
});

// 4. Assemble the raw chain spec. name/id/protocolId/properties/bootNodes/chainType are metadata that
//    do NOT affect the genesis block hash; only `genesis.raw.top` does. childrenDefault is empty for a
//    preset-built genesis (no child tries).
const spec = {
  name,
  id,
  chainType: CHAIN_TYPE,
  bootNodes: BOOTNODES,
  telemetryEndpoints: null,
  protocolId,
  properties,
  codeSubstitutes: {},
  genesis: { raw: { top, childrenDefault: {} } },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(spec, null, 2));

console.log(`\n✓ Wrote ${OUT}`);
if (BOOTNODES.length) console.log(`  bootNodes: ${BOOTNODES.join("\n             ")}`);
else console.log(`  ⚠ no --bootnode given — pass the validator's multiaddr or set --bootnodes at launch.`);
console.log(
  `\nVerify the relay adopts the SAME genesis: launch it with --chain ${OUT}, then\n` +
  `  chain_getBlockHash(0) MUST equal ${genesisHash}\n` +
  `(a mismatch means the reconstruction is incomplete — do not trust it).`,
);
