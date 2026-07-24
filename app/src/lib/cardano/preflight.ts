// Client-side safety gate before submitting a lock — fail closed on anything that doesn't match
// the contract's create rule, so a UI bug can't park funds in an unspendable shape. The validator
// is the authority; this is belt-and-suspenders that mirrors its mint arm.
import { MIN_LOCK } from "./blueprint";
import { beaconNameHex } from "./beacon";

export interface LockPreflight {
  paymentKeyHash: string;
  stakeKeyHash: string;
  lockLovelace: bigint;
  /** the beacon name about to be minted (must equal blake2b_256(owner)). */
  beacon: string;
}

export function preflightLock(p: LockPreflight): void {
  if (!/^[0-9a-f]{56}$/i.test(p.paymentKeyHash)) {
    throw new Error("Couldn't read your wallet address. Reconnect and try again.");
  }
  if (!/^[0-9a-f]{56}$/i.test(p.stakeKeyHash)) {
    throw new Error("Use a wallet address that has a stake key.");
  }
  if (p.lockLovelace < MIN_LOCK) {
    throw new Error(`lock must be at least ${MIN_LOCK} lovelace (the min_lock floor)`);
  }
  const expected = beaconNameHex(p.paymentKeyHash, p.stakeKeyHash);
  if (p.beacon.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Nothing was locked. Reconnect your wallet and try again.");
  }
}
