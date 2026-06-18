// PAPI submitter the Cogno-Follower shells out to, to write a verified identity binding.
//
//   node scripts/submit-link.mjs <identity_hash_hex> <account_pubkey_hex> [<thread_pointer_hex>]
//
// Submits sudo(CognoGate.link_identity{ identity_hash, substrate_account, thread_pointer }) signed
// by the chain's sudo key — the DR-07 sudo escape hatch (FollowerOrigin = EnsureRoot in v1). The
// signer is SUDO_SEED (default dev //Alice); set it to your chain's sudo secret. The follower
// VERIFIES the CIP-8 proof (pycardano); this script only submits. Prints one line of JSON:
//   { ok, identity_hash, account, error? }  and exits 0 on a successful bind, 1 otherwise.
//
// The proven PAPI path (reused from grant-weight.mjs) — chosen over py-substrate-interface so the
// custom feeless TxExtension set never has to be re-encoded off PAPI.
import { createClient, FixedSizeBinary, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";

const WS = process.env.WS || "ws://127.0.0.1:9944";
// The sudo signer. Default dev `//Alice`; set SUDO_SEED to your chain's sudo secret. A value starting
// with `//` is a derivation path on the well-known dev phrase; anything else is treated as a full
// mnemonic (used directly, no path).
const SUDO_SEED = process.env.SUDO_SEED || "//Alice";
const out = (o) => console.log(JSON.stringify(o));

const [hashHex, accountHex, threadHex] = process.argv.slice(2);
if (!hashHex || !accountHex) { out({ ok: false, error: "usage: submit-link.mjs <identity_hash_hex> <account_pubkey_hex> [<thread_hex>]" }); process.exit(1); }
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

async function main() {
  const client = createClient(getWsProvider(WS));
  const api = client.getTypedApi(cogno);
  const isPath = SUDO_SEED.startsWith("//");
  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(isPath ? DEV_PHRASE : SUDO_SEED)));
  const sudoKp = derive(isPath ? SUDO_SEED : "");
  const sudo = getPolkadotSigner(sudoKp.publicKey, "Sr25519", sudoKp.sign);

  const accountPub = hexToBytes(accountHex);
  const account = ss58Address(accountPub, 42);
  const inner = api.tx.CognoGate.link_identity({
    identity_hash: FixedSizeBinary.fromBytes(hexToBytes(hashHex)),
    substrate_account: account,
    thread_pointer: threadHex ? Binary.fromBytes(hexToBytes(threadHex)) : undefined,
  });
  const res = await api.tx.Sudo.sudo({ call: inner.decodedCall }).signAndSubmit(sudo);

  // Inspect the inner Sudo.Sudid result.
  const ev = (res.events || []).find((e) => e.type === "Sudo" && e.value?.type === "Sudid");
  const r = ev?.value?.value?.sudo_result;
  const innerOk = r ? (r.success === true || r.type === "Ok") : res.ok;
  client.destroy();
  if (innerOk) { out({ ok: true, identity_hash: hashHex, account }); process.exit(0); }
  const d = r?.value ?? r;
  const err = d?.value?.value?.type || d?.value?.type || d?.type || "link_identity failed";
  out({ ok: false, identity_hash: hashHex, account, error: err });
  process.exit(1);
}
main().catch((e) => { out({ ok: false, error: String(e?.message || e) }); process.exit(1); });
