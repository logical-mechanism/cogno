//// cogno-chain L1 mint-side validation helpers (DR-01/DR-18).

use aiken/collection/dict
use aiken/collection/list
use aiken/option
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{
  AssetName, PolicyId, Value, lovelace_of, policies, quantity_of, tokens,
}
use cardano/transaction.{InlineDatum, Output}
use types.{Burn, Mint, MintRedeemer, VaultDatum}
use util

/// Validate every beacon mint/burn in the tx (one redeemer entry per token). The merged validator
/// means the beacon `policy_id` IS this validator's own hash (`currency_symbol`), so a freshly
/// minted beacon landing "at its own address" is exactly `output_hash == currency_symbol`.
pub fn mint_validation(
  mint_redeemer: MintRedeemer,
  mint_value: Value,
  currency_symbol: PolicyId,
  outputs: List<Output>,
  extra_signatories: List<ByteArray>,
  min_lock: Int,
) -> Bool {
  when mint_redeemer is {
    [mint_type, ..rest] -> {
      let valid_mint =
        when mint_type is {
          Mint(owner) -> {
            // DR-01: the name binds to the WHOLE owner Address.
            let token_name: AssetName = util.beacon_name(owner)
            // v1: the payment credential MUST be a VerificationKey (no script owner yet).
            expect VerificationKey(owner_vkh): Credential =
              owner.payment_credential
            // Locate the output holding the freshly minted beacon; read its address + datum.
            expect Output {
              address: Address {
                payment_credential: Script(output_hash),
                stake_credential: out_stake,
              },
              value,
              datum: InlineDatum(output_datum_data),
              reference_script,
            } = util.search_for_output_by_token(outputs, currency_symbol, token_name)
            expect VaultDatum { owner: datum_owner }: VaultDatum = output_datum_data
            and {
              // ⛔ beacon goes INTO this script's OWN address (DR-18: policy_id == this_hash).
              (output_hash == currency_symbol)?,
              // ⛔ whole-Address: vault stake cred == owner.stake_cred (DR-01).
              (out_stake == owner.stake_credential)?,
              // ⛔ no reference-script attacks.
              option.is_none(reference_script)?,
              // ⛔ no-trash: ADA + exactly the 1 beacon (policies includes the lovelace "" policy
              //    → exactly 2). Do NOT change to == 1.
              (list.length(policies(value)) == 2)?,
              // ⛔ floor enforced AT MINT (creation runs no spend handler).
              (lovelace_of(value) >= min_lock)?,
              // ⛔ ONLY YOU mint YOURS: the owner's payment vkey must sign.
              list.has(extra_signatories, owner_vkh)?,
              // ⛔ the beacon can't be minted into a vault that names someone else.
              (datum_owner == owner)?,
              // ⛔ EXACTLY +1.
              (quantity_of(mint_value, currency_symbol, token_name) == 1)?,
            }
          }
          // Exactly -1 of the named beacon. The spend side independently binds the burned name to
          // its datum, so a burn cannot strip a beacon out of someone else's exiting vault.
          Burn(tkn) -> (quantity_of(mint_value, currency_symbol, tkn) == -1)?
        }
      valid_mint && mint_validation(
        rest,
        mint_value,
        currency_symbol,
        outputs,
        extra_signatories,
        min_lock,
      )
    }
    [] -> True
  }
}

/// Anti-laundering guard: the number of distinct beacon tokens minted/burned under THIS policy must
/// equal the redeemer length, and the redeemer must have no duplicate entries. Together these block
/// a +2, a 2nd name / junk token under the policy, and a same-name burn+remint in one tx.
pub fn mint_length_and_uniqueness(
  mint: Value,
  mint_redeemer: MintRedeemer,
  currency_symbol: PolicyId,
) -> Bool {
  and {
    (dict.size(tokens(mint, currency_symbol)) == list.length(mint_redeemer))?,
    (list.unique(mint_redeemer) == mint_redeemer)?,
  }
}
