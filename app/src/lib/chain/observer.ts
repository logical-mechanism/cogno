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

// NO vault policy id here. The runtime API returns one, and mapping it through was a field nothing ever
// read: lib/cardano/vaultPolicy.ts answers "is this bundle's vault the one the chain is watching?" from
// the pallet CONSTANT (`api.constants.CardanoObserver.VaultPolicyId()`) and never calls this function.
// A config field with no consumer is a field that drifts unnoticed, and it carried a fourth private
// byte-to-hex helper to keep it fed. If a caller ever needs it here, add it back WITH that caller, and
// use `toHex` from @polkadot-api/utils (already a dependency, already used by lib/ss58).

/**
 * One in-flight/settled read per chain handle. The config is fixed for the life of a runtime, but the
 * callers are hooks: Settings alone mounts two `useStabilityWindow`s and a `usePendingCapacity`, and
 * /welcome adds two more, so "read once per api" was four or five identical runtime-API round trips
 * for a value that cannot change under them. Keyed by the api handle (weakly, so a destroyed client's
 * entry goes with it), which is exactly the scope the value is constant over.
 */
const configCache = new WeakMap<CognoApi, Promise<ObserverConfig>>();

/** Read the consensus-pinned observer policy (fixed per runtime — read once per api). */
export function readObserverConfig(api: CognoApi): Promise<ObserverConfig> {
  const hit = configCache.get(api);
  if (hit) return hit;

  const p = api.apis.CardanoObserverApi.observer_config()
    .then((c) => ({
      shelleyStartUnix: c.shelley_start_unix,
      shelleyStartSlot: c.shelley_start_slot,
      stabilitySlots: c.stability_slots,
      stakeEpochLookback: c.stake_epoch_lookback,
    }))
    .catch((err: unknown) => {
      // A failure is NOT the answer — drop it so the next caller retries. Caching a rejection would
      // wedge the stability-window copy and the pending-lock countdown for the whole connection.
      configCache.delete(api);
      throw err;
    });

  configCache.set(api, p);
  return p;
}

// EnforceWeight (`false` ⇒ the observer is emergency-frozen and a pending lock will NOT credit) is read
// LIVE by usePendingCapacity via a `watchValue` subscription so a freeze mid-wait is reflected, rather
// than through a one-shot helper here — a one-shot read went stale and ticked a false countdown.

/**
 * The lock-to-credit wait as plain copy, e.g. "about 10 minutes" / "about 36 hours".
 *
 * This is the SAME number the countdown uses, and the pre-lock copy has to agree with it. It used to
 * say "a few minutes" as a static string, which is right at the preprod window (600 slots) and a ~200x
 * understatement at the mainnet one (129,600 slots = 36 hours). Telling someone their 100 ADA credits
 * in minutes when it takes a day and a half is the sort of thing that gets read as the vault eating
 * their funds. Cardano is 1 slot per second in the Shelley era, so slots are seconds.
 */
export function describeStabilityWindow(stabilitySlots: bigint): string {
  const sec = Number(stabilitySlots);
  if (!Number.isFinite(sec) || sec <= 0) return "a moment";
  if (sec < 90) return `about ${Math.round(sec)} seconds`;
  const min = Math.round(sec / 60);
  // Switch to hours at exactly an hour, so this never says "about 60 minutes". Rounding to the nearest
  // hour above that errs LONG for a 60-to-90 minute window, which is the safe direction here: better to
  // overstate a wait someone is deciding whether to lock 100 ADA against than to understate it.
  if (min < 60) return `about ${min} minute${min === 1 ? "" : "s"}`;
  const hours = Math.round(sec / 3600);
  if (hours < 48) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(sec / 86_400);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}

/** The wall-clock unix time (seconds) of a Cardano slot, from the Shelley anchor (1 slot = 1 second). */
export function slotToUnixSec(slot: bigint, cfg: ObserverConfig): number {
  return Number(cfg.shelleyStartUnix + (slot - cfg.shelleyStartSlot));
}

/**
 * Estimate the Cardano slot a lock tx submitted RIGHT NOW will land in, from the observation frontier.
 *
 * This exists to keep a third-party provider off the lock→credit path entirely. The slot used to come
 * from Blockfrost (`fetchTxSlot`, polled every 15 s per client until the tx confirmed), and the project
 * id is a build-time `NEXT_PUBLIC_` value baked into the static bundle — so every visitor shares ONE
 * quota. A signup spike was therefore indistinguishable from a self-inflicted DoS: the burst limit is
 * reached, `fetchTxSlot` returns null for everyone, and every pending lock falls through to the "we
 * cannot compute an ETA" path at once. The frontier answers the same question for free, over the
 * subscription every client already holds to our own node.
 *
 * THE DERIVATION. The observer reads Cardano history older than its stability window, so
 * `frontier = tip − stability` (see `max_reference_for_now` in pallet-cardano-observer). A tx submitted
 * now lands at approximately the current tip, hence `lockSlot ≈ frontier + stability`. Credit follows
 * when the frontier climbs past that, which is what `shouldClearPendingLock` already compares against.
 *
 * ERROR AND ITS DIRECTION. The tx actually lands a Cardano block or two after submission (~20-60 s), so
 * this UNDER-estimates the true slot by that much and therefore predicts credit slightly EARLY. That is
 * the harmless direction, and `usePendingCapacity`'s existing `OVERDUE_GRACE_MS` (3 min) already absorbs
 * it — it was sized for the same class of lag. Against the mainnet window (36 h) the error is ~0.05%;
 * against preprod's 10 min it is under a minute. No artificial bias is added: over-estimating instead
 * would keep the "crediting" narration on screen after the user could already post, which is worse than
 * an ETA that expires a minute early.
 *
 * Returns null when the frontier has never been written (a chain that has not yet observed) or on any
 * read error, in which case the caller keeps the existing "confirming, no ETA yet" behaviour.
 */
export async function estimateLockSlot(api: CognoApi): Promise<number | null> {
  try {
    const [cfg, ref] = await Promise.all([
      readObserverConfig(api),
      api.query.CardanoObserver.LastReference.getValue({ at: "best" }),
    ]);
    if (!ref) return null;
    const slot = Number(ref.slot) + Number(cfg.stabilitySlots);
    return Number.isFinite(slot) && slot > 0 ? slot : null;
  } catch {
    return null;
  }
}

// ── observer liveness ────────────────────────────────────────────────────────────────────────────
//
// The observer inherent is the SOLE writer of talk-capacity weight, voting power and role badges. When
// it stops, none of those three ever changes again: a confirmed lock never credits, an unlock never
// clamps, a claimed SPO tag never confirms. Nothing else in the stack notices. Substrate's own liveness
// is untouched (blocks keep being produced, GRANDPA keeps finalizing), so every dashboard stays green
// while every user watches their posting power quietly stop moving.
//
// The pallet does record it — `CardanoObserver.Stalled` latches in `on_initialize` once the gap exceeds
// `StallAfter` — and until now literally nothing read that flag. The node-side Prometheus gauges
// (`cogno_observer_*`) are a separate signal and are only written by the AUTHORING producer, and
// deploy/monitoring/alertmanager.yml ships with every notifier commented out under a header saying, in
// as many words, that it pages nobody. So the alarm reached no one at all. This is the read half.

/** What the observer is doing, from the chain's own state. */
export type ObserverHealth =
  /** Observing normally. Weight, voting power and role tags are all live. */
  | { kind: "ok" }
  /** Not enough has been read yet to say. NEVER an assertion — an unresolved read is not a diagnosis. */
  | { kind: "unknown" }
  /**
   * This chain has never applied a single observation, so nothing has stopped. `--dev` is exactly this
   * (no db-sync, so the inherent abstains on every block), and so is a chain whose observer has never
   * worked. Distinct from "stalled" because "the sole weight writer has STOPPED" is a false statement
   * about a chain that never started, and because the on-chain latch deliberately cannot fire here.
   */
  | { kind: "never-started" }
  /** Observation has stopped. `blocks` is how long the gap has run. */
  | { kind: "stalled"; blocks: number };

/** The four chain reads the classification needs. `null` means "not resolved yet", never "zero". */
export interface ObserverLiveness {
  /** `CardanoObserver.Stalled` — the latched on-chain alarm. */
  latched: boolean | null;
  /** `CardanoObserver.LastAppliedAt` — the block an observation last landed in. */
  lastAppliedAt: number | null;
  /** The chain's current best block. */
  bestBlock: number | null;
  /** The `StallAfter` pallet constant, in blocks. */
  stallAfter: number | null;
  /**
   * Whether `CardanoObserver.LastReference` is `Some` — i.e. whether this chain has EVER accepted an
   * observation. This is the discriminator, and it is not `lastAppliedAt === 0`: `on_initialize`
   * re-anchors a zero clock to the current block on its first run, so a zero is unobservable on a live
   * chain and would misread a fresh chain as freshly-observed.
   */
  everObserved: boolean | null;
}

/**
 * Classify observer liveness. Pure, so the rule is testable and cannot drift from the pallet.
 *
 * The derived gap is computed as well as read, rather than trusting the latch alone, because the latch
 * is a lagging signal by design: `on_initialize` runs before the block's inherents, so it fires on a
 * gap that is ALREADY over the threshold. Deriving it too means the UI and the chain agree on the same
 * block instead of the UI trailing by one. The comparison is a strict `>` to match the pallet exactly
 * (`if blocks <= T::StallAfter::get() { return ... }`).
 *
 * Ordering matters. `never-started` is checked BEFORE the derived gap, because a chain that has never
 * observed has an arbitrarily large gap and would otherwise be reported as stalled forever.
 */
export function classifyObserverHealth(live: ObserverLiveness): ObserverHealth {
  const { latched, lastAppliedAt, bestBlock, stallAfter, everObserved } = live;

  // Fail SILENT, not alarming. A momentary RPC failure must not tell every reader the chain is broken.
  if (everObserved === null || bestBlock === null || stallAfter === null) return { kind: "unknown" };

  if (everObserved === false) return { kind: "never-started" };

  if (latched === true) {
    // The latch is authoritative once armed; the gap is only for the copy, and it is bounded below by
    // stallAfter so a lagging `lastAppliedAt` read cannot render "stalled for -3 blocks".
    const blocks = lastAppliedAt === null ? stallAfter : Math.max(stallAfter, bestBlock - lastAppliedAt);
    return { kind: "stalled", blocks };
  }

  if (lastAppliedAt === null) return { kind: "unknown" };
  const gap = bestBlock - lastAppliedAt;
  if (gap > stallAfter) return { kind: "stalled", blocks: gap };

  return { kind: "ok" };
}
