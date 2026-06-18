// On-chain data builders — a browser port of app/scripts/m2d-beacon.mjs, byte-for-byte identical
// to the Aiken `talk_vault` types (and to the follower's beacon.py). Uses Uint8Array (no Node
// `Buffer`) so it runs unchanged inside the Next.js static-export bundle.
//
// /!\ The stake credential is the canonical THREE-level `Some(Inline(VerificationKey(skh)))` —
// MeshJS's `addrBech32ToPlutusDataHex` emits a 2-level form the contract REJECTS. The beacon name
// is `blake2b_256` of this exact CBOR, so getting it wrong = a mint the validator rejects.
import { blake2b } from "blakejs";

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  if (h.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const u8 = (...nums: number[]) => Uint8Array.from(nums);

// tag 121 (Constr 0) + indefinite-length array … break
const constr0 = (...fields: Uint8Array[]) => concat(u8(0xd8, 0x79, 0x9f), ...fields, u8(0xff));
const indefList = (...items: Uint8Array[]) => concat(u8(0x9f), ...items, u8(0xff));
function bstr(hex: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length < 24) return concat(u8(0x40 + b.length), b);
  if (b.length < 256) return concat(u8(0x58, b.length), b);
  throw new Error("bytestring too long for this minimal encoder");
}

/** The Plutus-Data CBOR of a base owner Address (vkey payment + vkey stake), matching Aiken. */
export function addressCbor(pkhHex: string, skhHex: string): Uint8Array {
  const payment = constr0(bstr(pkhHex)); // VerificationKey(pkh)
  const stake = constr0(constr0(constr0(bstr(skhHex)))); // Some(Inline(VerificationKey(skh)))
  return constr0(payment, stake); // Address { payment, stake }
}

/** The 32-byte beacon name / identity hash for this owner (== beacon.py / the contract). */
export function beaconNameHex(pkhHex: string, skhHex: string): string {
  return bytesToHex(blake2b(addressCbor(pkhHex, skhHex), undefined, 32));
}

/** `VaultDatum { owner }` as inline-datum CBOR (hex). */
export function vaultDatumCborHex(pkhHex: string, skhHex: string): string {
  return bytesToHex(constr0(addressCbor(pkhHex, skhHex)));
}

/** The mint redeemer `[Mint(owner)]` (List<MintTypeRedeemer>, Mint = Constr 0 [Address]) as hex. */
export function mintRedeemerCborHex(pkhHex: string, skhHex: string): string {
  return bytesToHex(indefList(constr0(addressCbor(pkhHex, skhHex))));
}

/** The burn redeemer `[Burn(assetName)]` (Burn = Constr 1 / tag 122 [AssetName]) as hex. */
export function burnRedeemerCborHex(assetNameHex: string): string {
  const burn = concat(u8(0xd8, 0x7a, 0x9f), bstr(assetNameHex), u8(0xff));
  return bytesToHex(indefList(burn));
}

/** `VaultRedeemer::Spend` = Constr 0 [] — the validator ignores the value but it must type-decode. */
export const SPEND_REDEEMER_CBOR = "d87980";
