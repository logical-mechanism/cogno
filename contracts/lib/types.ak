//// cogno-chain L1 types (DR-01/DR-18).

use cardano/address.{Address}
use cardano/assets.{AssetName}

/// The vault datum. The owner is the WHOLE CIP-19 Address (DR-01) — payment credential
/// (v1: VerificationKey only) + stake credential. The beacon `token_name` is DERIVED from this
/// (`blake2b_256(cbor.serialise(owner))`), never stored. NO `lock_until` (v1 dropped the timelock).
pub type VaultDatum {
  owner: Address,
}

/// The spend redeemer. One on-chain code path: the validator logic is identical regardless of
/// intent (top-up / partial-withdraw / full-exit are distinguished by the continuing-output count,
/// not the redeemer). The variant exists only so a spend has a well-typed redeemer.
pub type VaultRedeemer {
  Spend
}

/// The mint redeemer entries. `Mint(Address)` registers (token_name = blake2b_256(serialise(owner)));
/// `Burn(AssetName)` leaves (exactly -1). A tx may carry a list (one entry per minted/burned beacon).
pub type MintTypeRedeemer {
  Mint(Address)
  Burn(AssetName)
}

pub type MintRedeemer =
  List<MintTypeRedeemer>
