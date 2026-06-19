// gen-chainspec.mjs — generate an OPERATOR-KEYED cogno-chain genesis (no well-known dev keys).
//
// Stands up a fresh network you fully control: it generates your validator session keys, your
// 3-of-5 FollowerCommittee seats, and your sudo key, then bakes them into a custom chain spec
// (plain + raw) and writes everything you need to launch + operate it. The polkadot-sdk dev keys
// (//Alice…) are NOT used anywhere in the output.
//
//   node scripts/gen-chainspec.mjs
//
// All knobs are env vars (shown with defaults):
//   NODE_BIN=./target/release/cogno-chain-node   # the built node (does all key derivation)
//   OUT=./network                                # output dir (gitignored)
//   VALIDATORS=1                                 # genesis block-producing authorities
//   COMMITTEE=5                                  # FollowerCommittee seats (origin needs ≥3/5)
//   CHAIN_NAME="Cogno"  CHAIN_ID="cogno"         # network name / id (id picks the base-path subdir)
//   TOKEN_SYMBOL=COGNO  TOKEN_DECIMALS=12  SS58_FORMAT=42  PROTOCOL_ID=$CHAIN_ID  # spec properties
//   BASE=local                                   # preset to source the runtime wasm + shape from
//   ENDOW=1000000000000000000                    # free balance seeded to every generated account
//
// Outputs in OUT/:
//   raw.json            — the chain spec to pass to every node:  --chain OUT/raw.json
//   plain.json          — the human-readable spec it was built from (inspect/diff genesis here)
//   keys.json           — ALL secret mnemonics (chmod 600, GITIGNORED — back this up, keep it safe)
//   env.sh              — `source` it before running the committee/follower services
//   NEXT-STEPS.md       — copy-paste runbook (key insert + launch + onboarding)
//
// No npm dependencies — every key is derived by the node binary's `key` subcommand, so this runs
// with any Node ≥18 (use the nvm node so stdout isn't swallowed by the snap node).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const NODE_BIN = process.env.NODE_BIN || "./target/release/cogno-chain-node";
const OUT = resolve(process.env.OUT || "./network");
const VALIDATORS = Math.max(1, parseInt(process.env.VALIDATORS || "1", 10));
const COMMITTEE = Math.max(1, parseInt(process.env.COMMITTEE || "5", 10));
const CHAIN_NAME = process.env.CHAIN_NAME || "Cogno";
const CHAIN_ID = process.env.CHAIN_ID || "cogno";
const BASE = process.env.BASE || "local";
const ENDOW = process.env.ENDOW || "1000000000000000000";

const node = (...args) => execFileSync(NODE_BIN, args, { encoding: "utf8" });

// Derive a fresh sr25519 keypair (account == aura key) from a new random mnemonic.
function freshAccount() {
  const j = JSON.parse(node("key", "generate", "--scheme", "sr25519", "--output-type", "json"));
  return { mnemonic: j.secretPhrase, account: j.ss58Address, aura: j.ss58Address };
}
// The GRANDPA (finality) key is ed25519 derived from the SAME mnemonic.
function grandpaOf(mnemonic) {
  const j = JSON.parse(node("key", "inspect", "--scheme", "ed25519", "--output-type", "json", mnemonic));
  return j.ss58Address;
}

console.log(`Generating an operator-keyed genesis: ${VALIDATORS} validator(s), ${COMMITTEE} committee seat(s).`);
if (COMMITTEE < 5) {
  console.log(`  ⚠ COMMITTEE=${COMMITTEE}: the on-chain origin requires ≥3/5 (60%) of members; <5 seats still works but re-check your threshold math.`);
}

const validators = [];
for (let i = 0; i < VALIDATORS; i++) {
  const k = freshAccount();
  validators.push({ name: `validator-${i + 1}`, ...k, grandpa: grandpaOf(k.mnemonic) });
}
const committee = [];
for (let i = 0; i < COMMITTEE; i++) committee.push({ name: `committee-${i + 1}`, ...freshAccount() });
const sudo = { name: "sudo", ...freshAccount() };

// Every generated account is endowed (committee propose/vote are fee-bearing; sudo must exist).
const everyAccount = [...validators, ...committee, sudo].map((k) => k.account);
const uniqAccounts = [...new Set(everyAccount)];

const patch = {
  balances: { balances: uniqAccounts.map((a) => [a, Number(ENDOW)]) },
  session: {
    keys: validators.map((v) => [v.account, v.account, { aura: v.aura, grandpa: v.grandpa }]),
  },
  validatorSet: { initialValidators: validators.map((v) => v.account) },
  followerCommittee: { members: committee.map((c) => c.account) },
  sudo: { key: sudo.account },
};

mkdirSync(OUT, { recursive: true });

// 1) Export the base preset's plain spec (for the runtime wasm + the spec scaffolding), then swap
//    its genesis patch for ours and rename the network.
const basePlain = resolve(OUT, "plain.base.json");
node("export-chain-spec", "--chain", BASE, "--output", basePlain);
const spec = JSON.parse(readFileSync(basePlain, "utf8"));
spec.name = CHAIN_NAME;
spec.id = CHAIN_ID;
spec.bootNodes = [];
// Network identity + render metadata (Phase 2): protocolId isolates this chain's p2p gossip from
// other Substrate networks; `properties` tell wallets/explorers how to render balances + addresses
// (without it they fall back to generic defaults and mis-render). ss58Format 42 + tokenDecimals 12
// mirror the runtime (SS58Prefix=42, UNIT=10^12); all overridable via env.
spec.protocolId = process.env.PROTOCOL_ID || CHAIN_ID;
spec.properties = {
  tokenSymbol: process.env.TOKEN_SYMBOL || "COGNO",
  tokenDecimals: Number(process.env.TOKEN_DECIMALS || "12"),
  ss58Format: Number(process.env.SS58_FORMAT || "42"),
};
spec.genesis.runtimeGenesis.patch = patch;
const plain = resolve(OUT, "plain.json");
writeFileSync(plain, JSON.stringify(spec, null, 2));

// 2) Convert to the raw (sealed) spec every node shares.
const raw = resolve(OUT, "raw.json");
node("export-chain-spec", "--chain", plain, "--raw", "--output", raw);

// 3) Persist the secrets (the operator's responsibility to protect + back up).
const keys = { chain: { name: CHAIN_NAME, id: CHAIN_ID }, validators, committee, sudo };
const keysPath = resolve(OUT, "keys.json");
writeFileSync(keysPath, JSON.stringify(keys, null, 2));
chmodSync(keysPath, 0o600);

// 4) env.sh — point the committee/follower services at YOUR keys (replacing the //Alice… defaults).
const envSh =
  `# source this before running the committee tooling + cogno-follower\n` +
  `export COMMITTEE_SEEDS="${committee.map((c) => c.mnemonic).join(",")}"\n` +
  `export SUDO_SEED="${sudo.mnemonic}"\n`;
writeFileSync(resolve(OUT, "env.sh"), envSh);
chmodSync(resolve(OUT, "env.sh"), 0o600);

// 5) NEXT-STEPS.md — the copy-paste runbook.
const insertBlock = (v, basePath) =>
  `# ${v.name} (account ${v.account}):\n` +
  `${NODE_BIN} key insert --base-path ${basePath} --chain ${raw} --scheme sr25519 --key-type aura --suri "<${v.name} mnemonic from keys.json>"\n` +
  `${NODE_BIN} key insert --base-path ${basePath} --chain ${raw} --scheme ed25519 --key-type gran --suri "<${v.name} mnemonic from keys.json>"`;

const steps = `# Launch your cogno-chain network

Generated for **${CHAIN_NAME}** (id \`${CHAIN_ID}\`): ${VALIDATORS} validator(s), ${COMMITTEE} committee seat(s).
Secrets are in \`keys.json\` (chmod 600) — **back it up and keep it private**.

## 1. Insert each validator's session keys into its node keystore

${validators.map((v, i) => insertBlock(v, `/var/lib/cogno/${v.name}`)).join("\n\n")}

(Run each validator's two inserts on the machine that will run that validator.)

## 2. Generate a stable libp2p identity for the boot node

\`\`\`bash
${NODE_BIN} key generate-node-key --file /var/lib/cogno/${validators[0].name}/node-key   # peer id → stderr
${NODE_BIN} key inspect-node-key --file /var/lib/cogno/${validators[0].name}/node-key     # re-print it
# bootnode multiaddr = /ip4/<BOOT_PUBLIC_IP>/tcp/30333/p2p/<PEER_ID>
\`\`\`

## 3. Launch the boot validator (then the rest)

\`\`\`bash
${NODE_BIN} --validator --name ${validators[0].name} \\
  --chain ${raw} --base-path /var/lib/cogno/${validators[0].name} \\
  --node-key-file /var/lib/cogno/${validators[0].name}/node-key \\
  --port 30333 --rpc-port 9944 --state-pruning archive --blocks-pruning archive${VALIDATORS === 1 ? " \\\n  --force-authoring   # REQUIRED for a single validator: it has no peers to confirm against" : ""}
\`\`\`

${validators.length > 1 ? `Other validators dial the boot node with \`--bootnodes /ip4/<BOOT_IP>/tcp/30333/p2p/<PEER_ID>\` (after their step-1 key inserts). Each additional validator needs its OWN libp2p key — either run \`key generate-node-key --file …\` for it too, or pass \`--unsafe-force-node-key-generation\` (a validator refuses to auto-create one). A node only starts authoring once it has ≥1 peer, so authoring + finality begin when the second validator connects.\n` : `Add more validators at runtime — see step 5. (A single validator authors only because of \`--force-authoring\`; GRANDPA still needs ≥2/3 of authorities online to finalize, so a 1-validator chain finalizes alone but a 2- or 3-validator chain needs them all up.)\n`}
A non-validator **tracking** node is the same command minus \`--validator\` (it syncs + serves RPC, and auto-creates its own libp2p key).

> Build the node with a **plain \`cargo build --release\`** (default features). A
> \`--features runtime-benchmarks\` build embeds a runtime a normal node can't run, and the chain
> spec carries that runtime — so generate the spec with the same clean binary you run.

> GRANDPA needs ≥ 2/3 of authorities online to finalize. With ${VALIDATORS} genesis validator(s),
> ${VALIDATORS < 4 ? "finality stalls if one drops — run more validators for fault tolerance." : "you tolerate up to ⌊(n-1)/3⌋ offline."}

## 4. Point the off-chain services at your keys

\`\`\`bash
source ${resolve(OUT, "env.sh")}   # exports COMMITTEE_SEEDS + SUDO_SEED (replacing the //Alice… defaults)
\`\`\`

The committee tooling now signs with your seats and your sudo key (set_stake / anchor_ack / revoke).
Identity binding is the permissionless on-chain self-proof \`cognoGate.link_identity_signed\` — no sudo
key involved; the cogno-follower is a read-only helper.

## 5. Onboard a NEW validator after genesis

Generate its keys (\`node scripts/gen-chainspec.mjs\` style or \`key generate\`), insert them on its
node (step 1), \`session.setKeys\` from its account, then admit it through your committee:

\`\`\`bash
node services/committee/op.mjs --call validatorSet.addValidator --args '["<new-validator-SS58>"]' --via committee
\`\`\`
`;
writeFileSync(resolve(OUT, "NEXT-STEPS.md"), steps);

console.log(`\n✓ Wrote ${OUT}/`);
console.log(`    raw.json        → --chain ${raw}`);
console.log(`    plain.json      → inspect genesis`);
console.log(`    keys.json       → SECRETS (chmod 600 — back up + protect)`);
console.log(`    env.sh          → source before the committee/follower services`);
console.log(`    NEXT-STEPS.md   → launch + onboarding runbook`);
console.log(`\nsudo account:      ${sudo.account}`);
console.log(`validators:        ${validators.map((v) => v.account).join("\n                   ")}`);
console.log(`committee (${committee.length}):     ${committee.map((c) => c.account).join("\n                   ")}`);
