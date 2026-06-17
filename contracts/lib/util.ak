//// cogno-chain L1 utilities.

use aiken/cbor
use aiken/crypto
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, quantity_of}
use cardano/transaction.{Output}

/// The beacon `token_name` (DR-01): `blake2b_256(cbor.serialise(owner))` — a 32-byte digest of the
/// WHOLE owner Address. EXACTLY 32 bytes (the asset-name maximum; no CIP-67 label — would overflow).
///
/// ⚑ The mint arm, the spend arm, AND the L2 follower MUST compute this over the IDENTICAL
/// serialization. On-chain that serialization is the Plutus-Data CBOR of the Aiken `Address`
/// (payment + stake credential; the `Address` type carries NO network byte — the follower must
/// hash the same credential-only CBOR, NOT the raw CIP-19 address bytes).
pub fn beacon_name(owner: Address) -> AssetName {
  crypto.blake2b_256(cbor.serialise(owner))
}

/// The first output whose value holds exactly 1 of `(pid, tkn)`. Fails if none — used by the mint
/// arm to locate the freshly-minted beacon's output and read its datum/stake-cred. (cogno_v3 idiom.)
pub fn search_for_output_by_token(
  outputs: List<Output>,
  pid: PolicyId,
  tkn: AssetName,
) -> Output {
  when outputs is {
    [output, ..rest] ->
      if quantity_of(output.value, pid, tkn) == 1 {
        output
      } else {
        search_for_output_by_token(rest, pid, tkn)
      }
    [] -> fail @"no output holds the beacon"
  }
}
