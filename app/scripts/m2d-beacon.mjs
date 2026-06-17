// M2d on-chain data builders — hand-rolled CBOR matching the Aiken `talk_vault` types EXACTLY.
//
// ⚠ MeshJS `addrBech32ToPlutusDataHex` produces a 2-level stake credential (Some(VerificationKey)),
// but the Aiken `Address` type is `stake_credential: Option<Referenced<Credential>>` → the canonical
// 3-level `Some(Inline(VerificationKey(skh)))`. The beacon name is blake2b_256(that canonical CBOR),
// so getting this wrong = a mint the contract rejects. These builders reproduce `beacon.py` / the
// contract byte-for-byte (Constr 0 = tag 121, indefinite-length arrays; proven against beacon.py).
import { blake2b } from "blakejs";

const concat = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const constr0 = (...fields) => concat([0xd8, 0x79, 0x9f], ...fields, [0xff]); // tag 121 + indef array
const indefList = (...items) => concat([0x9f], ...items, [0xff]);
const bstr = (hex) => {
  const b = Buffer.from(hex, "hex");
  if (b.length < 24) return concat([0x40 + b.length], b);
  if (b.length < 256) return concat([0x58, b.length], b);
  throw new Error("bytestring too long for this minimal encoder");
};

/** The Plutus-Data CBOR of a base owner Address (vkey payment + vkey stake), matching Aiken. */
export function addressCbor(pkhHex, skhHex) {
  const payment = constr0(bstr(pkhHex)); // VerificationKey(pkh)
  const stake = constr0(constr0(constr0(bstr(skhHex)))); // Some(Inline(VerificationKey(skh)))
  return constr0(payment, stake); // Address { payment, stake }
}

/** The 32-byte beacon name / identity hash for this owner (== beacon.py / the contract). */
export function beaconNameHex(pkhHex, skhHex) {
  return Buffer.from(blake2b(addressCbor(pkhHex, skhHex), undefined, 32)).toString("hex");
}

/** VaultDatum { owner: Address } as inline-datum CBOR. */
export function vaultDatumCborHex(pkhHex, skhHex) {
  return constr0(addressCbor(pkhHex, skhHex)).toString("hex");
}

/** The mint redeemer `[Mint(owner)]` (List<MintTypeRedeemer>, Mint = Constr 0 [Address]) as CBOR. */
export function mintRedeemerCborHex(pkhHex, skhHex) {
  return indefList(constr0(addressCbor(pkhHex, skhHex))).toString("hex");
}

/** The burn redeemer `[Burn(assetName)]` (Burn = Constr 1 [AssetName]) as CBOR. */
export function burnRedeemerCborHex(assetNameHex) {
  const burn = concat([0xd8, 0x7a, 0x9f], bstr(assetNameHex), [0xff]); // tag 122 (Constr 1) [name]
  return indefList(burn).toString("hex");
}
