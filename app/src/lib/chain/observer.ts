// observer.ts — client reads of the cardano-observer's public state, used to explain and time the lag
// between an L1 lock confirming and the app-chain crediting its posting weight.
//
// The lag is one parameter: the observer only reads Cardano history older than its STABILITY WINDOW
// (StabilitySlots), so a lock created at Cardano slot S is credited once the observed frontier reaches
// S — i.e. once wall-clock cardano_slot(now) >= S + stability_slots. All the inputs are already on-chain:
//   • observer_config() (CardanoObserverApi runtime API) → stability window + Shelley anchors (slot↔time)
//   • CardanoObserver.LastReference → the current observation frontier {slot, block_hash}
//   • CardanoObserver.EnforceWeight → false ⇒ observation is emergency-frozen (weights won't advance)
// Cardano is 1 slot per second in the Shelley era (the only era the observer's anchors cover), so the
// slot↔wall-clock conversion is a plain offset.

import type { CognoApi } from "@/lib/types";

export interface ObserverConfig {
  /** unix seconds at the Shelley-era anchor slot. */
  shelleyStartUnix: bigint;
  /** the Cardano slot at that anchor. */
  shelleyStartSlot: bigint;
  /** how many slots behind the tip the observer reads (the whole lock→credit lag). */
  stabilitySlots: bigint;
  /** epochs of look-back for the SEPARATE voting-power (epoch_stake) read — not the lock deposit. */
  stakeEpochLookback: bigint;
}

/** Read the consensus-pinned observer policy (fixed per runtime — read once per api). */
export async function readObserverConfig(api: CognoApi): Promise<ObserverConfig> {
  const c = await api.apis.CardanoObserverApi.observer_config();
  return {
    shelleyStartUnix: c.shelley_start_unix,
    shelleyStartSlot: c.shelley_start_slot,
    stabilitySlots: c.stability_slots,
    stakeEpochLookback: c.stake_epoch_lookback,
  };
}

// EnforceWeight (`false` ⇒ the observer is emergency-frozen and a pending lock will NOT credit) is read
// LIVE by usePendingCapacity via a `watchValue` subscription so a freeze mid-wait is reflected, rather
// than through a one-shot helper here — a one-shot read went stale and ticked a false countdown.

/** The wall-clock unix time (seconds) of a Cardano slot, from the Shelley anchor (1 slot = 1 second). */
export function slotToUnixSec(slot: bigint, cfg: ObserverConfig): number {
  return Number(cfg.shelleyStartUnix + (slot - cfg.shelleyStartSlot));
}
