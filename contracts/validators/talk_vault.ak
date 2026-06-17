//// cogno-chain L1 — the `talk_vault` validator (DR-01/DR-18).
////
//// ONE merged validator: an owner-reclaimable ADA vault marked by a per-user beacon NFT whose
//// policy_id IS this validator's own hash. Parameterized by `min_lock` only. The beacon
//// token_name = blake2b_256(cbor.serialise(owner Address)) binds the vault to the WHOLE owner
//// Address (payment + stake credential, DR-01).
////
//// PARKED FUNDS ARE SAFE: every spend path is gated by the owner's payment signature
//// unconditionally before any value moves. The floor / value-non-decrease / single-own-input /
//// token-set-freeze / datum-freeze / stake-cred-consistency / beacon-forward / burn-on-exit guards
//// close every continuation attack. Do not relax any ⛔ line.

use aiken/collection/list
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, lovelace_of, quantity_of, without_lovelace}
use cardano/transaction
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference,
  Transaction}
use types.{Burn, Mint, MintRedeemer, Spend, VaultDatum, VaultRedeemer}
use util
use validate

validator talk_vault(min_lock: Int) {
  // ── Beacon mint/burn. policy_id == this validator's own hash (DR-18). ──
  mint(redeemer: MintRedeemer, policy_id: PolicyId, self: Transaction) {
    let Transaction { outputs, extra_signatories, mint, .. } = self
    and {
      validate.mint_validation(
        redeemer,
        mint,
        policy_id,
        outputs,
        extra_signatories,
        min_lock,
      )?,
      validate.mint_length_and_uniqueness(mint, redeemer, policy_id)?,
    }
  }

  // ── Owner-reclaimable ADA vault. ──
  spend(
    maybe_datum: Option<Data>,
    _redeemer: VaultRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    when maybe_datum is {
      Some(datum) ->
        if datum is VaultDatum {
          let Transaction { inputs, outputs, extra_signatories, mint, .. } = self
          expect Some(this_input): Option<Input> =
            inputs |> transaction.find_input(utxo)
          expect Script(this_hash): Credential =
            this_input.output.address.payment_credential
          let VaultDatum { owner } = datum
          // v1: the payment credential MUST be a VerificationKey (no script owner yet, DR-01).
          expect VerificationKey(owner_vkh): Credential = owner.payment_credential
          let in_value = this_input.output.value
          // Derive the beacon name ON-CHAIN from THIS datum's owner — binds burn-on-exit to THIS
          // vault (blocks burning vault A's beacon while exiting vault B). policy_id == this_hash.
          let beacon = util.beacon_name(owner)

          // ── DOUBLE-SATISFACTION GUARD — every spend, before the branch. Keep == 1, never >= 1.
          let own_input_count =
            list.count(
              inputs,
              fn(i) { i.output.address.payment_credential == Script(this_hash) },
            )
          expect (own_input_count == 1)?

          // ── CONTINUATION / EXIT rule, by continuing-output count. ──
          let continuation_ok =
            when transaction.find_script_outputs(outputs, this_hash) is {
              // [] = FULL EXIT / LEAVE: the beacon bound to THIS datum MUST be burned. NOT `True`.
              [] -> and {
                  (quantity_of(mint, this_hash, beacon) == -1)?,
                  // belt-and-suspenders: the beacon survives in NO output.
                  list.all(
                    outputs,
                    fn(o: Output) { quantity_of(o.value, this_hash, beacon) == 0 },
                  )?,
                }
              // [cont] = top-up (a shrinking continuation is impossible: the non-decrease forbids it).
              [cont] -> and {
                  // ⛔ floor on every continuation.
                  (lovelace_of(cont.value) >= min_lock)?,
                  // ⛔ value NON-DECREASING → no siphon.
                  (lovelace_of(cont.value) >= lovelace_of(in_value))?,
                  // ⛔ SAME beacon carried forward.
                  (quantity_of(cont.value, this_hash, beacon) == 1)?,
                  // ⛔ ADA + that 1 beacon ONLY / token set frozen (no strip, no 2nd beacon, no
                  //    foreign token). With the line above, this pins the beacon as the only token.
                  (without_lovelace(cont.value) == without_lovelace(in_value))?,
                  // ⛔ whole-Address: stake cred consistency on continuation (DR-01).
                  (cont.address.stake_credential == owner.stake_credential)?,
                  // ⛔ owner Address frozen → the beacon name cannot drift either.
                  (cont.datum == this_input.output.datum)?,
                }
              // ⛔ fan-out: more than one own-script output → reject.
              _ -> False
            }

          and {
            // ⛔ owner signed (their payment vkey) — every path, before any value moves.
            list.has(extra_signatories, owner_vkh)?,
            continuation_ok?,
          }
        } else {
          // A bad datum type is spendable (the creator-only footgun idiom).
          True
        }
      // No datum is spendable.
      None -> True
    }
  }

  else(_) {
    fail
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────
// §8.5 — the specification freeze gate. Positives = `test name() { call }` (must return True);
// negatives = `test name() fail { call }` (must return False or trap). Each negative tweaks one
// load-bearing line off a valid base tx, proving that line is the thing that rejects.
// ───────────────────────────────────────────────────────────────────────────────────────

const lock: Int = 100_000_000

// 28-byte credential hashes (blake2b-224) and a 32-byte tx id (blake2b-256).
const vault_hash: ByteArray =
  #"19bcec346695badd915551db1b9e7caf9d1af92a015fc5a446b69c13"
const owner_vkh: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
const stake_vkh: ByteArray =
  #"b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
const other_vkh: ByteArray =
  #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"
const tx_id: ByteArray =
  #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd00"

// owner = a type-0 base address (payment vkey + stake key) — the identity (DR-01).
fn owner_addr() -> Address {
  address.from_verification_key(owner_vkh)
    |> address.with_delegation_key(stake_vkh)
}

// the vault address = script payment cred + the SAME stake cred as the owner (DR-01).
fn vault_addr() -> Address {
  address.from_script(vault_hash) |> address.with_delegation_key(stake_vkh)
}

fn beacon() -> ByteArray {
  util.beacon_name(owner_addr())
}

// The owner datum, upcast to `Data` (the spend handler takes `Option<Data>`).
fn owner_datum() -> Data {
  let d: Data = VaultDatum { owner: owner_addr() }
  d
}

// a vault output holding `lovelace` ADA + 1 beacon, datum = VaultDatum { owner }.
fn vault_output(addr: Address, lovelace: Int, owner: Address) -> Output {
  Output {
    address: addr,
    value: assets.from_lovelace(lovelace)
      |> assets.add(vault_hash, beacon(), 1),
    datum: InlineDatum(VaultDatum { owner }),
    reference_script: None,
  }
}

fn oref() -> OutputReference {
  OutputReference { transaction_id: tx_id, output_index: 0 }
}

fn vault_input(value_lovelace: Int) -> Input {
  Input {
    output_reference: oref(),
    output: vault_output(vault_addr(), value_lovelace, owner_addr()),
  }
}

// ── MINT (register / leave) ──────────────────────────────────────────────────────────────

test mint_create_succeeds() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [vault_output(vault_addr(), lock, owner_addr())],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

test mint_without_owner_sig_fails() fail {
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [vault_output(vault_addr(), lock, owner_addr())],
      extra_signatories: [other_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

test mint_below_floor_fails() fail {
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [vault_output(vault_addr(), lock - 1, owner_addr())],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

test mint_into_non_own_address_fails() fail {
  // beacon lands at a DIFFERENT script address (output_hash != policy_id).
  let bad_addr =
    address.from_script(other_vkh) |> address.with_delegation_key(stake_vkh)
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [vault_output(bad_addr, lock, owner_addr())],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

test mint_wrong_stake_cred_fails() fail {
  // vault address stake cred != owner.stake_cred (DR-01).
  let bad_addr =
    address.from_script(vault_hash) |> address.with_delegation_key(other_vkh)
  let out =
    Output {
      address: bad_addr,
      value: assets.from_lovelace(lock) |> assets.add(vault_hash, beacon(), 1),
      datum: InlineDatum(VaultDatum { owner: owner_addr() }),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [out],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

test mint_plus_two_fails() fail {
  // quantity +2 of the same name (also trips length/uniqueness).
  let out =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock) |> assets.add(vault_hash, beacon(), 2),
      datum: InlineDatum(VaultDatum { owner: owner_addr() }),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [out],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 2),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

test mint_into_trashy_output_fails() fail {
  // a foreign token rides along in the beacon output (policies length != 2).
  let out =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock)
        |> assets.add(vault_hash, beacon(), 1)
        |> assets.add(other_vkh, "junk", 1),
      datum: InlineDatum(VaultDatum { owner: owner_addr() }),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [out],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

test burn_minus_one_succeeds() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(vault_hash, beacon(), -1),
    }
  talk_vault.mint(lock, [Burn(beacon())], vault_hash, tx)
}

test burn_other_amount_fails() fail {
  let tx =
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(vault_hash, beacon(), -2),
    }
  talk_vault.mint(lock, [Burn(beacon())], vault_hash, tx)
}

// ── SPEND (top-up / partial / full exit) ─────────────────────────────────────────────────

test spend_topup_succeeds() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [vault_output(vault_addr(), lock + 50_000_000, owner_addr())],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test non_owner_cannot_spend_fails() fail {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [vault_output(vault_addr(), lock + 50_000_000, owner_addr())],
      extra_signatories: [other_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test two_own_inputs_fails() fail {
  let other_oref = OutputReference { transaction_id: tx_id, output_index: 1 }
  let second =
    Input {
      output_reference: other_oref,
      output: vault_output(vault_addr(), lock, owner_addr()),
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock), second],
      outputs: [vault_output(vault_addr(), lock * 2, owner_addr())],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test continuation_shrinks_value_fails() fail {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock + 50_000_000)],
      outputs: [vault_output(vault_addr(), lock, owner_addr())],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test continuation_drops_beacon_fails() fail {
  let cont =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock + 50_000_000),
      datum: InlineDatum(VaultDatum { owner: owner_addr() }),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [cont],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test continuation_changes_stake_cred_fails() fail {
  let bad_cont_addr =
    address.from_script(vault_hash) |> address.with_delegation_key(other_vkh)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [vault_output(bad_cont_addr, lock + 50_000_000, owner_addr())],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test full_exit_burns_beacon_succeeds() {
  // no continuing output; beacon burned -1; ADA goes to the owner's wallet.
  let wallet =
    Output {
      address: owner_addr(),
      value: assets.from_lovelace(lock),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [wallet],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), -1),
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test full_exit_without_burn_fails() fail {
  let wallet =
    Output {
      address: owner_addr(),
      value: assets.from_lovelace(lock),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [wallet],
      extra_signatories: [owner_vkh],
      // mint left empty → no -1 burn → must fail.
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}
