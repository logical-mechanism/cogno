// The Cardano ROLE-tag proof flow (verifiable role tags — SPO first). A role key (a Calidus pool key /
// key-based dRep key / committee hot key) is UNRELATED to the posting wallet and is typically an OFFLINE
// key, so — unlike the in-browser CIP-8 payment/stake binds (lib/cardano/cip8.ts) — the wallet does NOT
// sign here. Instead this module bakes a fully-pinned `cardano-signer` command the operator runs offline
// with their `.skey`, then a strict paste-back pre-flight verifies the returned COSE blobs against THIS
// session's request before they are submitted via `cardano-roles.claim_role_signed` (lib/chain/roles.ts).
//
// The runtime verifier (pallets/cogno-gate/src/cip8.rs::verify_bind_proof_role) is the authority: it
// re-checks the Ed25519 signature, the `blake2b_224(pubkey) == payment credential` address bind, and the
// pinned `cogno-chain/role/v1;…;role=<spo|drep|cc>` payload grammar. This pre-flight mirrors those checks
// on-device so a wrong key / stale command / mismatched address is caught BEFORE a doomed on-chain submit,
// exactly as cip8.ts's client pre-flight fronts the payment/stake binds.
//
// MeshJS (@meshsdk/core-cst) is browser-only + heavy, so it is dynamically imported INSIDE the async
// functions — this module stays import-safe during the static export. `blakejs` is pure JS (used already
// by lib/signer/wallet-derive.ts) and safe to import at module scope.

import { blake2b } from "blakejs";
import { bech32 } from "bech32";
import { hexToBytes } from "@/lib/util/hex";
import { isUserRejection } from "@/lib/cardano/cip8";

/** The domain separator + payload grammar the runtime verifier pins (cip8.rs::parse_role_payload):
 *  `cogno-chain/role/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>;role=<spo|drep|cc>`. Distinct from
 *  the payment/stake bind domain (`cogno-chain/bind/v1`) so a bind proof can never be replayed as a role
 *  proof, and the trailing `role=` token pins which role a proof is for. */
const ROLE_DOMAIN = "cogno-chain/role/v1";

/** The on-wire role token the payload's `role=` field carries. SPO + dRep are lit; CC rides the identical
 *  pipeline once its observer branch lands. */
export type RoleToken = "spo" | "drep" | "cc";

/** The conventional secret-key filename shown in the baked command, per role (a placeholder path the
 *  operator replaces with their real key file). */
const SKEY_NAME: Record<RoleToken, string> = {
  spo: "calidus.skey",
  drep: "drep.skey",
  cc: "cc-hot.skey",
};

/** Human role label for the parser's error copy (the SPO role's key is a Calidus key). */
const ROLE_LABEL: Record<RoleToken, string> = { spo: "Calidus", drep: "dRep", cc: "CC hot" };

/** The bech32 HRPs accepted per role — an ALLOWLIST, so an `addr…` / `pool…` / `stake…` pasted into the
 *  wrong field is rejected outright rather than silently mis-derived (a 29-byte enterprise address would
 *  otherwise decode to the right length and look like a CIP-129 credential). Each role covers the id
 *  (CIP-105 28-byte / CIP-129 29-byte), the verification key (`_vk`), and the key hash (`_vkh`). */
const ROLE_BECH32_HRPS: Record<RoleToken, readonly string[]> = {
  spo: ["calidus", "calidus_vk", "calidus_vkh"],
  drep: ["drep", "drep_vk", "drep_vkh"],
  cc: ["cc_hot", "cc_hot_vk", "cc_hot_vkh"],
};

/**
 * Try to decode a bech32 role id/key (`drep1…`, `drep_vk1…`, `calidus_vk1…`, …) into the 28-byte credential
 * the synthetic address commits. Returns null when `s` isn't bech32 at all, so the caller falls through to
 * the hex/JSON paths. THROWS a specific error when it IS bech32 but wrong for this role (foreign HRP, a
 * script credential, or an unexpected length) — those are user mistakes worth naming, not silent fall-through.
 *   • 32-byte payload → a verification key → credential = blake2b_224(key);
 *   • 28-byte payload → CIP-105 id / key hash → the bare credential;
 *   • 29-byte payload → CIP-129 id (1 header byte + 28-byte cred): low nibble 3 = a SCRIPT credential (can't
 *     sign) → rejected; otherwise the header is stripped.
 */
function decodeBech32Credential(
  s: string,
  role: RoleToken,
): { credentialHex: string; fromKeyHash: boolean } | null {
  let prefix: string;
  let data: Uint8Array;
  try {
    const dec = bech32.decode(s, 128);
    prefix = dec.prefix.toLowerCase();
    data = Uint8Array.from(bech32.fromWords(dec.words));
  } catch {
    return null; // not bech32 — let the hex paths try
  }
  const label = ROLE_LABEL[role];
  if (!ROLE_BECH32_HRPS[role].includes(prefix)) {
    throw new Error(`that's a "${prefix}…" key, not a ${label} key — paste your ${label} key`);
  }
  if (data.length === 32) {
    return { credentialHex: toHex(blake2b(data, undefined, 28)), fromKeyHash: false };
  }
  if (data.length === 28) {
    return { credentialHex: toHex(data), fromKeyHash: true };
  }
  if (data.length === 29) {
    if ((data[0] & 0x0f) === 0x03) {
      throw new Error(`that ${label} is script-based — only a key-based ${label} can sign`);
    }
    return { credentialHex: toHex(data.slice(1)), fromKeyHash: true };
  }
  throw new Error(
    `that ${label} bech32 key decoded to ${data.length} bytes — expected a 28/29-byte id or a 32-byte key`,
  );
}

/** A built role-proof request: the exact payload/address/command handed to the operator, held in the
 *  wizard between "generate command" and "paste result" so the pre-flight can compare byte-for-byte. */
export interface RoleProofRequest {
  role: RoleToken;
  /** the bare 28-byte role credential (56 hex) = `blake2b_224(role key)` = the synthetic address's payment cred. */
  credentialHex: string;
  /** the synthetic enterprise address the proof signs over (bech32, `addr_test…` on preprod). */
  syntheticAddress: string;
  /** the same address as raw bytes (29 = header + 28-byte cred), lowercase hex — the pre-flight compares this. */
  syntheticAddressHex: string;
  /** the exact payload string the command signs (compared byte-for-byte on paste-back). */
  payload: string;
  /** the client-generated 16-byte nonce (32 hex) tying the command to this session. */
  nonce: string;
  /** the fully-baked `cardano-signer` command to copy + run offline. */
  command: string;
  /** true when the user entered a bare 28-byte key hash (we could not self-check it vs a pubkey until
   *  paste-back). Purely informational for the UI. */
  fromKeyHash: boolean;
}

/** The outcome of the paste-back pre-flight: the two COSE blobs ready to submit, or a structured error. */
export interface RolePasteback {
  ok: boolean;
  /** COSE_Sign1 hex (submitted as `claim_role_signed.cose_sign1`). */
  coseSign1?: string;
  /** COSE_Key hex (submitted as `claim_role_signed.cose_key`). */
  coseKey?: string;
  error?: string;
}

/** Crypto-random 16-byte nonce as 32 lowercase-hex chars (the pinned payload grammar's nonce format). */
function randomNonceHex(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Bytes → lowercase hex (no 0x). Local so credential derivation needs no MeshJS import. */
function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Normalize a hex-ish input: trim, strip a leading 0x, lowercase. */
function normHex(s: string): string {
  return s.trim().replace(/^0x/i, "").toLowerCase();
}

const hexByteLen = (h: string) => normHex(h).length / 2;

/**
 * Derive the 28-byte role credential from an operator's entered role key. Accepts the forms a user has,
 * whether from a wallet or from disk (`cardano-signer keygen`):
 *   • a bech32 id / key — the canonical wallet-facing form: `drep1…` (CIP-105/129 dRep id), `drep_vk1…`,
 *     `calidus_vk1…`, etc. (see `decodeBech32Credential`),
 *   • a `.vkey` JSON (its `cborHex` field is used),
 *   • a CBOR-hex verification key (`5820` + 32-byte pubkey),
 *   • a bare 32-byte Ed25519 verification key (64 hex) → credential = `blake2b_224(pubkey)`,
 *   • a bare 28-byte key hash / credential (56 hex) → used directly.
 * `role` scopes the error copy and the bech32 HRP allowlist. The runtime is the authority — this only pins
 * the address the offline command signs over.
 */
export function deriveRoleCredential(
  keyInput: string,
  role: RoleToken,
): { credentialHex: string; fromKeyHash: boolean } {
  const label = ROLE_LABEL[role];
  let raw = keyInput.trim();
  if (!raw) throw new Error(`enter your ${label} verification key`);
  // A pasted `.vkey` file → pull out its cborHex.
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as { cborHex?: unknown };
      if (typeof j.cborHex === "string") raw = j.cborHex;
    } catch {
      // not JSON after all — fall through and treat the whole thing as hex
    }
  }
  // A bech32 id/key (`drep1…`, `calidus_vk1…`) — the form a wallet shows. Non-bech32 input returns null and
  // falls through to the hex paths; a bech32 string that's wrong for this role throws a named error.
  const fromBech32 = decodeBech32Credential(raw, role);
  if (fromBech32) return fromBech32;

  let hex = normHex(raw);
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`${label} key is not hex, a .vkey JSON, or a bech32 id`);
  }
  // Strip a CBOR bytestring header (0x5820 = a 32-byte bstr) if the cborHex form was pasted.
  if (hex.length === 68 && hex.startsWith("5820")) hex = hex.slice(4);
  if (hex.length === 64) {
    // a 32-byte Ed25519 verification key → the credential is its blake2b-224 hash
    return { credentialHex: toHex(blake2b(hexToBytes(hex), undefined, 28)), fromKeyHash: false };
  }
  if (hex.length === 56) {
    // already a 28-byte key hash / credential
    return { credentialHex: hex, fromKeyHash: true };
  }
  throw new Error(
    `expected a 32-byte ${label} verification key (64 hex / .vkey cborHex), its 28-byte key hash (56 hex), or a bech32 id`,
  );
}

/**
 * Build a role-proof request: derive the credential, mint the synthetic ENTERPRISE address whose payment
 * credential is `blake2b_224(role key)` (header 0x60 = enterprise-key on network 0 / preprod), pin the
 * `role/v1` payload committing MY posting account + THIS chain's genesis + a fresh nonce + the role, and
 * bake the offline `cardano-signer` command. Returns everything the wizard needs to render + later verify.
 * Never signs anything — the operator runs the command offline.
 */
export async function buildRoleProofRequest(opts: {
  /** the operator's Calidus verification key (hex / .vkey JSON / key hash — see deriveRoleCredential). */
  keyInput: string;
  /** the sr25519 posting account the proof commits (0x-prefixed or bare hex). */
  sr25519PubkeyHex: string;
  /** THIS chain's block-0 (genesis) hash, read via PAPI (0x-prefixed or bare hex) — anti-cross-chain. */
  genesisHex: string;
  /** which role this proof is for (SPO for now). */
  role: RoleToken;
}): Promise<RoleProofRequest> {
  const account = normHex(opts.sr25519PubkeyHex);
  const genesis = normHex(opts.genesisHex);
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error("posting account is not a 32-byte hex pubkey");
  if (!/^[0-9a-f]{64}$/.test(genesis)) throw new Error("chain genesis is not a 32-byte hex hash");

  const { credentialHex, fromKeyHash } = deriveRoleCredential(opts.keyInput, opts.role);

  const cst = await import("@meshsdk/core-cst");
  // The synthetic enterprise address (network 0 / preprod, key-hash payment credential). cardano-signer
  // embeds this verbatim in the COSE_Sign1 protected header; the runtime binds blake2b_224(pubkey) to it.
  const syntheticAddress = String(
    cst.buildEnterpriseAddress(0, cst.Hash28ByteBase16(credentialHex)).toAddress().toBech32(),
  );
  // The raw address bytes (29 = header + 28-byte cred), lowercase hex — what the pre-flight compares the
  // signed COSE_Sign1's embedded address against. Derived FROM the same bech32 so the two can't drift.
  const syntheticAddressHex = String(cst.Address.fromBech32(syntheticAddress).toBytes()).toLowerCase();

  const nonce = randomNonceHex();
  const payload = `${ROLE_DOMAIN};genesis=${genesis};account=${account};nonce=${nonce};role=${opts.role}`;

  // The offline command. The `--secret-key` filename is a placeholder — the operator points it at their
  // real key file. Single line so it copies cleanly; the payload is safe inside double quotes (only `;` `=`).
  const command =
    `cardano-signer sign --cip8 --data "${payload}" ` +
    `--secret-key ${SKEY_NAME[opts.role]} --address ${syntheticAddress} --json-extended`;

  return {
    role: opts.role,
    credentialHex,
    syntheticAddress,
    syntheticAddressHex,
    payload,
    nonce,
    command,
    fromKeyHash,
  };
}

/**
 * Pull every plausible even-length hex blob out of a pasted `cardano-signer --json-extended` result (or a
 * bare pair of hex blobs). Structural, not field-name-dependent: the caller identifies which blob is the
 * COSE_Sign1 vs the COSE_Key by trying to parse each, so cardano-signer field-name changes can't break it.
 */
function candidateHexes(input: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    const h = normHex(v);
    if (/^[0-9a-f]+$/.test(h) && h.length >= 16 && h.length % 2 === 0) out.add(h);
  };
  const trimmed = input.trim();
  try {
    const visit = (v: unknown) => {
      if (typeof v === "string") add(v);
      else if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") Object.values(v).forEach(visit);
    };
    visit(JSON.parse(trimmed));
  } catch {
    // not JSON — treat the input as whitespace/punctuation-separated hex tokens
    for (const tok of trimmed.split(/[^0-9a-fx]+/i)) add(tok);
  }
  return [...out];
}

/**
 * Paste-back pre-flight: verify the operator's `cardano-signer` output against THIS session's request
 * before submitting. Mirrors the runtime verifier's checks on-device (best-effort — the runtime is the
 * authority): find the COSE_Sign1 + COSE_Key, then assert
 *   1. the COSE_Key holds a 32-byte Ed25519 key (no 64-byte extended keys — the runtime rejects them),
 *   2. `blake2b_224(pubkey) == credential` (the key really is the claimed Calidus credential),
 *   3. the embedded signing address == the synthetic address (they signed the right address),
 *   4. the signed payload == the app-generated payload, byte-for-byte (right chain / account / role / nonce),
 *   5. the COSE blobs fit the on-chain bounds (cose_sign1 ≤ 512, cose_key ≤ 128).
 * Returns the two blobs on success, or a specific, actionable error. Never throws.
 */
export async function preflightRolePasteback(
  pasted: string,
  req: RoleProofRequest,
): Promise<RolePasteback> {
  try {
    const cands = candidateHexes(pasted);
    if (cands.length === 0) {
      return { ok: false, error: "no hex found in the pasted output — paste the cardano-signer --json-extended result" };
    }

    const cst = await import("@meshsdk/core-cst");

    // The COSE_Key is the blob getPublicKeyFromCoseKey accepts (a CBOR map with a 32-byte OKP key).
    let coseKey: string | undefined;
    let pubkey: Uint8Array | undefined;
    for (const h of cands) {
      try {
        const pk = cst.getPublicKeyFromCoseKey(h);
        const bytes = new Uint8Array(pk);
        if (bytes.length === 32) {
          coseKey = h;
          pubkey = bytes;
          break;
        }
      } catch {
        // not a COSE_Key — keep scanning
      }
    }

    // The COSE_Sign1 is the blob that decodes to a signed message with a payload + an embedded address.
    let coseSign1: string | undefined;
    for (const h of cands) {
      if (h === coseKey) continue;
      try {
        const cs = cst.CoseSign1.fromCbor(h);
        const pl = cs.getPayload();
        const ad = cs.getAddress();
        if (pl && pl.length > 0 && ad && ad.length > 0) {
          coseSign1 = h;
          break;
        }
      } catch {
        // not a COSE_Sign1 — keep scanning
      }
    }

    if (!coseKey || !pubkey) {
      return { ok: false, error: "couldn't find the COSE_Key in the pasted output" };
    }
    if (!coseSign1) {
      return { ok: false, error: "couldn't find the COSE_Sign1 signature in the pasted output" };
    }

    const cs = cst.CoseSign1.fromCbor(coseSign1);

    // (4) payload byte-for-byte — the strongest anti-stale check (wrong chain / account / role / nonce).
    const payloadHex = cst.bytesToHex(new Uint8Array(cs.getPayload() as Uint8Array)).toLowerCase();
    if (payloadHex !== cst.utf8ToHex(req.payload).toLowerCase()) {
      return {
        ok: false,
        error: "the signed payload doesn't match this session — regenerate the command and sign again",
      };
    }

    // (3) embedded address == the synthetic role address (they passed the exact --address).
    const addrHex = cst.bytesToHex(new Uint8Array(cs.getAddress())).toLowerCase();
    if (addrHex !== req.syntheticAddressHex) {
      return { ok: false, error: "the signed address isn't the synthetic role address — pass the exact --address shown" };
    }

    // (1) 32-byte Ed25519 key only (a 64-byte extended key is rejected on-chain).
    if (pubkey.length !== 32) {
      return { ok: false, error: "the signing key is not a 32-byte Ed25519 key" };
    }
    // (2) the key really is the claimed Calidus credential.
    const credHex = toHex(blake2b(pubkey, undefined, 28));
    if (credHex !== req.credentialHex) {
      return { ok: false, error: "blake2b_224(signing key) ≠ the Calidus credential — you signed with a different key" };
    }
    // Belt-and-suspenders single-key-source check (the runtime enforces kid == key when a kid is present):
    // if the COSE_Sign1 carries its own key, it must equal the COSE_Key.
    try {
      const embedded = new Uint8Array(cs.getPublicKey());
      if (embedded.length === 32 && toHex(embedded) !== toHex(pubkey)) {
        return { ok: false, error: "the COSE_Sign1 key and COSE_Key disagree — re-run the command cleanly" };
      }
    } catch {
      // no embedded key in the signature header — fine, the address is the binding
    }

    // (5) on-chain size bounds (decode would reject an over-bound blob).
    if (hexByteLen(coseSign1) > 512) return { ok: false, error: "COSE_Sign1 exceeds the 512-byte on-chain bound" };
    if (hexByteLen(coseKey) > 128) return { ok: false, error: "COSE_Key exceeds the 128-byte on-chain bound" };

    return { ok: true, coseSign1, coseKey };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** CIP-129 header byte for a KEY-based dRep credential (0x22 = dRep + key-hash). */
const CIP129_DREP_KEY = 0x22;

/** Encode a 28-byte credential (56 hex) as a CIP-129 `drep1…` id. Used only to hand a wallet a well-formed
 *  DRepID when the user pasted a non-bech32 form — MeshJS routes `signData(payload, "drep1…")` to CIP-95 by
 *  the `drep1` prefix, so we always pass it a `drep1…`. Pure. */
export function encodeDrepId(credentialHex: string): string {
  const cred = normHex(credentialHex);
  if (!/^[0-9a-f]{56}$/.test(cred)) throw new Error("credential is not a 28-byte (56 hex) key hash");
  const bytes = Uint8Array.from([CIP129_DREP_KEY, ...hexToBytes(cred)]);
  return bech32.encode("drep", bech32.toWords(bytes), 128);
}

/**
 * IN-BROWSER role proof via a CIP-95 wallet (the wallet-pops-up path — no offline `cardano-signer`). Enables
 * the wallet WITH the CIP-95 extension, signs the pinned `role/v1` payload with the account's dRep key
 * (`cip95.signData`, reached via MeshJS's `signData(payload, "drep1…")` routing), and runs the SAME paste-back
 * pre-flight the offline path uses. Returns the two COSE blobs to submit, or a structured error (never throws)
 * — a wallet without CIP-95 / a declined prompt / a mismatched key each degrades to a specific, actionable
 * message so the card can fall back to the offline command. dRep only: a Calidus pool key isn't in a wallet.
 */
export async function produceRoleProofWallet(opts: {
  walletId: string;
  /** the already-built request (payload + synthetic address + credential) to sign + verify against. */
  request: RoleProofRequest;
  /** the pasted key input — a `drep1…` id is passed straight through; any other form is re-encoded to one. */
  keyInput: string;
}): Promise<RolePasteback> {
  try {
    const { BrowserWallet } = await import("@meshsdk/core");
    // Request the CIP-95 governance extension — without it the wallet exposes no dRep key / signData.
    const wallet = await BrowserWallet.enable(opts.walletId, [{ cip: 95 }]);
    if ((await wallet.getNetworkId()) !== 0) {
      return { ok: false, error: "wrong network: switch your wallet to preprod (testnet), then reconnect" };
    }
    // Capability gate: a wallet without CIP-95 returns no dRep key → point at the offline command.
    const pubDRep = await wallet.getPubDRepKey().catch(() => undefined);
    if (!pubDRep) {
      return {
        ok: false,
        error: "this wallet doesn't offer in-wallet dRep signing (CIP-95) — use the offline command instead",
      };
    }
    // Hand the wallet a well-formed drep1… (so MeshJS routes to cip95.signData) and the pinned payload.
    const raw = opts.keyInput.trim();
    const drepId = raw.toLowerCase().startsWith("drep1") ? raw : encodeDrepId(opts.request.credentialHex);
    const sig = (await wallet.signData(opts.request.payload, drepId)) as { signature: string; key: string };
    // Reuse the offline path's pre-flight verbatim — validates payload/address/credential/bounds byte-for-byte.
    return await preflightRolePasteback(JSON.stringify(sig), opts.request);
  } catch (e) {
    if (isUserRejection(e)) return { ok: false, error: "signing was cancelled in the wallet" };
    const msg = e instanceof Error ? e.message : String(e);
    console.error("cogno: produceRoleProofWallet failed:", msg);
    // A missing cip95 surfaces as a TypeError on `.signData` — steer to the fallback rather than a raw error.
    if (/cip95|signData|undefined/i.test(msg)) {
      return { ok: false, error: "this wallet couldn't sign with the dRep key (CIP-95) — use the offline command instead" };
    }
    return { ok: false, error: msg };
  }
}
