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
// `aiken/fuzz` is used ONLY by the property tests + benchmarks below — never by the validator,
// so it is not linked into the compiled on-chain script.
use aiken/fuzz
use aiken/option
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
                  // ⛔ no reference-script bloat on the continuation — mirror the mint arm
                  //    (validate.ak `option.is_none(reference_script)`), close L-01's perimeter gap.
                  option.is_none(cont.reference_script)?,
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

// I-03 fixture variant: a vault output whose `reference_script` slot can be populated. The default
// builder hardcodes `None`; this one lets a negative test attach `Some(_)` to exercise the mint-arm
// pin (validate.ak) and the L-01 spend-continuation pin.
fn vault_output_ref(
  addr: Address,
  lovelace: Int,
  owner: Address,
  reference_script: Option<ByteArray>,
) -> Output {
  Output {
    address: addr,
    value: assets.from_lovelace(lovelace)
      |> assets.add(vault_hash, beacon(), 1),
    datum: InlineDatum(VaultDatum { owner }),
    reference_script,
  }
}

// a SECOND, distinct owner (other payment vkey + same stake key) — for cross-owner negative tests.
fn other_owner_addr() -> Address {
  address.from_verification_key(other_vkh)
    |> address.with_delegation_key(stake_vkh)
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

// §8.5 #1 — the cross-side agreement (the L1↔L2↔L5 join key). The beacon name for a known owner
// (vkey a1*28 payment + vkey b2*28 stake) is LOCKED here and proven byte-identical to the pycardano
// follower's beacon_name() — services/cogno-follower/test_beacon.py asserts the SAME value. The
// serialization is cbor.serialise(Address) = Plutus-Data CBOR (Constr 0 / tag 121, indefinite
// arrays), NOT the raw CIP-19 address bytes (the Aiken Address type carries no network byte).
test beacon_name_matches_follower() {
  beacon() == #"6e2f65e9160dfbef407bfd9bce3a0aa733e12b562a856327acc3092060e0ca50"
}

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

test mint_with_no_beacon_bearing_output_fails() fail {
  // search exhaustion (util.ak `search_for_output_by_token`): the beacon is minted (+1) but NO output
  // holds it (the lone output is a plain wallet UTxO) → the search hits its `[]` arm and `fail`s with
  // the new "searched N outputs" trace. Exercises the one explicit error-message path in the layer.
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
      outputs: [wallet],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
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

test mint_at_exact_floor_succeeds() {
  // floor boundary (validate.ak:57 `>= min_lock`): fund the vault with EXACTLY the floor and pass
  // that SAME value as min_lock — proving the comparison is `>=` (inclusive), not `>` (exclusive).
  // Uses a floor distinct from `lock` so it can't pass by accident of the 100M constant.
  let floor = 5_000_000
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [vault_output(vault_addr(), floor, owner_addr())],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
    }
  talk_vault.mint(floor, [Mint(owner_addr())], vault_hash, tx)
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

test continuation_with_double_beacon_fails() fail {
  // beacon-quantity pin (talk_vault.ak:94 `quantity_of(cont) == 1`): a continuation carrying TWO
  // beacon units must be rejected. (This also trips the token-set freeze on talk_vault.ak:97 since
  // the input holds only 1 — both are correct rejectors; there is no single-guard isolation because
  // a valid 1-beacon input can never legitimately continue into a 2-beacon output.)
  let cont =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock + 50_000_000)
        |> assets.add(vault_hash, beacon(), 2),
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

test full_exit_with_beacon_in_other_output_fails() fail {
  // belt-and-suspenders isolation (talk_vault.ak:82-85): a FULL EXIT correctly burns the beacon
  // (mint -1, so the first conjunct passes), but a NON-vault change output still carries 1 beacon
  // unit → the `list.all(... quantity == 0)` scan must find it and reject. This isolates the scan:
  // delete the list.all line and this tx would pass (the -1 mint alone is satisfied).
  let change_with_beacon =
    Output {
      address: owner_addr(),
      value: assets.from_lovelace(lock) |> assets.add(vault_hash, beacon(), 1),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [change_with_beacon],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), -1),
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

// ── REFERENCE-SCRIPT PERIMETER (L-01 + I-03) ──────────────────────────────────────────────
// The address perimeter has four slots: payment cred, stake cred, reference_script, datum/value.
// Both the mint arm AND the spend continuation must pin reference_script == None. These tests
// drive the I-03 fixture variant that can attach Some(_).

test continuation_with_no_reference_script_succeeds() {
  // positive regression guard for the L-01 pin: a well-formed continuation (ref-script None) accepts.
  let cont = vault_output_ref(vault_addr(), lock + 50_000_000, owner_addr(), None)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [cont],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test continuation_with_reference_script_fails() fail {
  // L-01: a continuation may NOT carry a reference script (min-ADA bloat); the new pin rejects it.
  let cont =
    vault_output_ref(vault_addr(), lock + 50_000_000, owner_addr(), Some(vault_hash))
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [cont],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test mint_into_output_with_reference_script_fails() fail {
  // I-03 / mint arm: the beacon output may not carry a reference script (validate.ak pin).
  let out = vault_output_ref(vault_addr(), lock, owner_addr(), Some(vault_hash))
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [out],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

// ── LOAD-BEARING GUARD NEGATIVES (I-04) ───────────────────────────────────────────────────
// One `fail` test per guard that previously had no dedicated negative, each tweaking exactly one
// load-bearing line off a valid base tx.

test continuation_adds_foreign_token_fails() fail {
  // token-set freeze: a foreign token riding the continuation breaks `without_lovelace` equality.
  let cont =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock + 50_000_000)
        |> assets.add(vault_hash, beacon(), 1)
        |> assets.add(other_vkh, "junk", 1),
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

test continuation_mutates_owner_datum_fails() fail {
  // datum freeze: the continuation names a DIFFERENT owner → `cont.datum == input.datum` rejects.
  let cont =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock + 50_000_000)
        |> assets.add(vault_hash, beacon(), 1),
      datum: InlineDatum(VaultDatum { owner: other_owner_addr() }),
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

test continuation_below_floor_fails() fail {
  // floor (isolated): input is BELOW min_lock so the NON-DECREASE holds (lock-1 >= lock-100),
  // leaving the floor `>= min_lock` (lock-1 >= lock) as the SOLE rejector — deleting it un-fails this.
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock - 100)],
      outputs: [vault_output(vault_addr(), lock - 1, owner_addr())],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test two_continuing_outputs_fan_out_fails() fail {
  // fan-out reject: two own-script continuing outputs → `find_script_outputs` hits the `_ -> False`.
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [
        vault_output(vault_addr(), lock + 50_000_000, owner_addr()),
        vault_output(vault_addr(), lock, owner_addr()),
      ],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test mint_datum_names_other_owner_fails() fail {
  // mint-side datum binding: the beacon output's datum names a DIFFERENT owner than the redeemer.
  let out =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock) |> assets.add(vault_hash, beacon(), 1),
      datum: InlineDatum(VaultDatum { owner: other_owner_addr() }),
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

test mint_redeemer_length_mismatch_fails() fail {
  // length/uniqueness: one redeemer entry but TWO distinct tokens under the policy → size != length.
  let out = vault_output(vault_addr(), lock, owner_addr())
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [out],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1)
        |> assets.add(vault_hash, "second_beacon", 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

test mint_duplicate_redeemer_entry_fails() fail {
  // uniqueness ISOLATED (validate.ak:93): two DISTINCT tokens are minted under the policy (size == 2)
  // and the redeemer has length 2 — so the length guard (validate.ak:92) is satisfied — but the two
  // redeemer entries are IDENTICAL `Mint(owner)`, so `list.unique != mint_redeemer` is the SOLE
  // rejector. (A plain [Mint(a), Mint(a)] for a single token can't reach here: one distinct token vs
  // length-2 trips the length guard first, since a Value never carries a zero-quantity entry.)
  let beacon_out = vault_output(vault_addr(), lock, owner_addr())
  // a separate output parks the 2nd distinct beacon so size(tokens)==2 without dirtying beacon_out.
  let second_out =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock) |> assets.add(vault_hash, "second", 1),
      datum: InlineDatum(VaultDatum { owner: owner_addr() }),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [beacon_out, second_out],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1)
        |> assets.add(vault_hash, "second", 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr()), Mint(owner_addr())], vault_hash, tx)
}

test mint_into_non_inline_datum_fails() fail {
  // non-inline-datum trap: the beacon output carries NoDatum → the mint arm's `expect InlineDatum`.
  let out =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock) |> assets.add(vault_hash, beacon(), 1),
      datum: NoDatum,
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

// ── DOCUMENTED CREATOR FOOTGUNS (I-05 / I-06) ─────────────────────────────────────────────
// These prove the two always-true datum arms are an intentional liveness sweep for MISCONFIGURED,
// non-protocol deposits — and that a real (beacon-bearing, VaultDatum) vault can never reach them.

test no_datum_utxo_is_spendable_by_anyone() {
  // hyper-02: a NoDatum UTxO at the vault address is spendable by anyone (no sig, no value check).
  talk_vault.spend(lock, None, Spend, oref(), transaction.placeholder)
}

test non_vault_datum_utxo_is_spendable_by_anyone() {
  // hyper-01: a datum that does NOT decode to VaultDatum falls through to the permissive arm.
  let not_a_vault: Data = 42
  talk_vault.spend(lock, Some(not_a_vault), Spend, oref(), transaction.placeholder)
}

test beacon_bearing_vault_not_spendable_via_bad_datum_arm() fail {
  // A real VaultDatum ALWAYS enters the owner-gated branch, never the permissive arm: owner signs,
  // but with no continuation and no -1 burn the gated path rejects → the arm cannot sweep a vault.
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test mint_with_script_owner_fails() fail {
  // I-06: the mint arm rejects a Script-payment-credential owner (v1: VerificationKey only) — the
  // structural mitigation that makes the lock-forever footgun unreachable through the protocol.
  let script_owner =
    address.from_script(other_vkh) |> address.with_delegation_key(stake_vkh)
  let nm = util.beacon_name(script_owner)
  let out =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock) |> assets.add(vault_hash, nm, 1),
      datum: InlineDatum(VaultDatum { owner: script_owner }),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: [out],
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, nm, 1),
    }
  talk_vault.mint(lock, [Mint(script_owner)], vault_hash, tx)
}

test vault_with_no_stake_delegation_succeeds() {
  // DR-01 edge: an owner with NO stake delegation (stake_credential == None). The continuation pin
  // `cont.address.stake_credential == owner.stake_credential` (talk_vault.ak:99) must accept
  // None == None — i.e. the whole-Address freeze treats absence-of-delegation as a first-class state.
  // The beacon name is derived over THIS owner, so every fixture below must use it consistently.
  let bare_owner = address.from_verification_key(owner_vkh)
  let bare_vault = address.from_script(vault_hash)
  let bare_beacon = util.beacon_name(bare_owner)
  let bare_datum: Data = VaultDatum { owner: bare_owner }
  let bare_input =
    Input {
      output_reference: oref(),
      output: Output {
        address: bare_vault,
        value: assets.from_lovelace(lock)
          |> assets.add(vault_hash, bare_beacon, 1),
        datum: InlineDatum(VaultDatum { owner: bare_owner }),
        reference_script: None,
      },
    }
  let cont =
    Output {
      address: bare_vault,
      value: assets.from_lovelace(lock + 50_000_000)
        |> assets.add(vault_hash, bare_beacon, 1),
      datum: InlineDatum(VaultDatum { owner: bare_owner }),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [bare_input],
      outputs: [cont],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(bare_datum), Spend, oref(), tx)
}

test spend_equal_value_continuation_succeeds() {
  // I-06 positive + value-rule boundary: a vkey owner may top up with EXACTLY equal value (no-op).
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [vault_output(vault_addr(), lock, owner_addr())],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

// ── PROPERTY / FUZZ TESTS (I-01) ──────────────────────────────────────────────────────────
// `via`-driven properties over the adversarial input distribution (default 100 samples each): every
// fuzzed perimeter break is rejected; every well-formed non-decreasing top-up is accepted. A fuzzer
// over `reference_script` is precisely what would have surfaced L-01.

test prop_continuation_rejects_any_reference_script(h via fuzz.bytearray_fixed(28)) {
  // any attached reference script (any 28-byte hash) → reject (L-01 pin).
  let cont = vault_output_ref(vault_addr(), lock + 50_000_000, owner_addr(), Some(h))
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [cont],
      extra_signatories: [owner_vkh],
    }
  !talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test prop_continuation_rejects_any_foreign_token(nm via fuzz.bytearray_between(0, 32)) {
  // any foreign token (under a non-vault policy) riding the continuation → reject (token freeze).
  let cont =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(lock + 50_000_000)
        |> assets.add(vault_hash, beacon(), 1)
        |> assets.add(other_vkh, nm, 1),
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
  !talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test prop_continuation_rejects_any_stake_cred_drift(h via fuzz.bytearray_fixed(28)) {
  // any continuation stake credential != the owner's → reject (DR-01 stake pin).
  if h == stake_vkh {
    True
  } else {
    let bad_addr =
      address.from_script(vault_hash) |> address.with_delegation_key(h)
    let tx =
      Transaction {
        ..transaction.placeholder,
        inputs: [vault_input(lock)],
        outputs: [vault_output(bad_addr, lock + 50_000_000, owner_addr())],
        extra_signatories: [owner_vkh],
      }
    !talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
  }
}

test prop_mint_rejects_any_non_owner_signer(h via fuzz.bytearray_fixed(28)) {
  // any single signer that is NOT the owner → mint rejects (owner-gated creation).
  if h == owner_vkh {
    True
  } else {
    let tx =
      Transaction {
        ..transaction.placeholder,
        outputs: [vault_output(vault_addr(), lock, owner_addr())],
        extra_signatories: [h],
        mint: assets.from_asset(vault_hash, beacon(), 1),
      }
    !talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
  }
}

test prop_continuation_accepts_any_nonneg_topup(delta via fuzz.int_at_least(0)) {
  // any non-decreasing top-up (delta >= 0) with a frozen perimeter → accept.
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock)],
      outputs: [vault_output(vault_addr(), lock + delta, owner_addr())],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

test prop_beacon_name_differs_on_payment_cred_change(
  h via fuzz.bytearray_fixed(28),
) {
  // beacon-name COMPOSITION (util.ak:17): the name is blake2b_256(cbor.serialise(owner Address)),
  // so changing the PAYMENT credential (stake fixed) must change the name — proving the hash binds
  // the whole Address, not just part of it. (Skip the one collision: h == the baseline payment vkh.)
  if h == owner_vkh {
    True
  } else {
    let other =
      address.from_verification_key(h) |> address.with_delegation_key(stake_vkh)
    util.beacon_name(other) != beacon()
  }
}

test prop_beacon_name_differs_on_stake_cred_change(
  h via fuzz.bytearray_fixed(28),
) {
  // companion to the above on the STAKE leg: changing the stake credential (payment fixed) must
  // change the beacon name — DR-01's whole-Address binding includes the delegation part.
  if h == stake_vkh {
    True
  } else {
    let other =
      address.from_verification_key(owner_vkh) |> address.with_delegation_key(h)
    util.beacon_name(other) != beacon()
  }
}

// ── BENCHMARKS (I-02) — realistic-context budget baselines (run with `aiken bench`). ─────────
// The samplers vary the number of filler (non-own) inputs/outputs to model a real tx carrying
// change + payment UTxOs alongside the single vault UTxO — the dimension the validator's
// `list.count` (inputs), `find_script_outputs` / `list.all` (outputs), and the mint-side
// `search_for_output_by_token` scan all grow on. `--max-size` caps the filler count.

// a plain wallet output (change/payment) — never carries the vault payment credential or a beacon.
fn filler_output() -> Output {
  Output {
    address: owner_addr(),
    value: assets.from_lovelace(2_000_000),
    datum: NoDatum,
    reference_script: None,
  }
}

// a plain wallet input — counted by `list.count` but never matches the own-script predicate.
fn filler_input() -> Input {
  Input {
    output_reference: OutputReference { transaction_id: tx_id, output_index: 1 },
    output: filler_output(),
  }
}

// Sampler: 0..size filler UTxOs — the realistic-context size knob aiken sweeps for the baseline.
fn fillers(size: Int) -> Fuzzer<Int> {
  fuzz.int_between(0, size)
}

bench talk_vault__spend__topup(n via fillers) {
  // one continuing vault output + n change outputs; vault input + n wallet inputs.
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock), ..list.repeat(filler_input(), n)],
      outputs: [
        vault_output(vault_addr(), lock + 50_000_000, owner_addr()),
        ..list.repeat(filler_output(), n)
      ],
      extra_signatories: [owner_vkh],
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

bench talk_vault__spend__full_exit(n via fillers) {
  // exit + burn with n+1 change outputs (the `list.all` beacon-absence scan covers every output).
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [vault_input(lock), ..list.repeat(filler_input(), n)],
      outputs: list.repeat(filler_output(), n + 1),
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), -1),
    }
  talk_vault.spend(lock, Some(owner_datum()), Spend, oref(), tx)
}

bench talk_vault__mint(n via fillers) {
  // the beacon output sits AFTER n filler outputs, so `search_for_output_by_token` scans past them.
  // NOTE: this sweeps the OUTPUTS dimension only; the redeemer list stays length-1, which is the v1
  // path (one beacon per tx). A multi-entry-redeemer baseline is out of scope until batch mint lands.
  let tx =
    Transaction {
      ..transaction.placeholder,
      outputs: list.concat(
        list.repeat(filler_output(), n),
        [vault_output(vault_addr(), lock, owner_addr())],
      ),
      extra_signatories: [owner_vkh],
      mint: assets.from_asset(vault_hash, beacon(), 1),
    }
  talk_vault.mint(lock, [Mint(owner_addr())], vault_hash, tx)
}

bench talk_vault__burn(_n via fillers) {
  // cold path: a -1 beacon burn (cost is independent of tx size — single baseline row).
  let tx =
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(vault_hash, beacon(), -1),
    }
  talk_vault.mint(lock, [Burn(beacon())], vault_hash, tx)
}
