# How talk-capacity works

cogno-chain has **no per-post fees**. Instead, the right to post is metered by a regenerating,
stake-weighted budget called **talk-capacity**. You earn it by locking ADA in a Cardano L1 contract
(`talk_vault`); it refills over time while the ADA stays locked; each post spends a little of it.

**Your stake is your rate limit.** That one sentence is the whole economic model. No money is spent
per post — you only ever tie up ADA, and you can free it whenever you like.

## Why feeless

The predecessor of this project, Cogno, was a Cardano-native forum where every message was an L1
transaction. That model collapsed at any real volume: per-post transaction fees plus min-ADA-per-byte
made high-frequency posting economically pointless. This is not a hypothetical — it is the proven
failure mode of a real, shipped dApp. The entire pivot to an app-chain exists to remove that per-post
cost.

Removing fees creates one problem you must then solve: if posting is free, what stops spam? On this
chain the answer is talk-capacity. For the social calls there is no fee floor underneath it — capacity
**is** the anti-spam mechanism (see [Where the check runs](#where-the-check-runs), and the block-weight
backstop below). Fees survive only on the admin surface capacity doesn't meter; see
[governance-fuel](#the-other-budget-governance-fuel).

## The token-bucket mechanic

Talk-capacity is a classic **token bucket** (a "battery"). Each identity has a capacity that fills up
to a ceiling while idle, then throttles to a steady refill rate. It is computed **lazily on read** —
there is no per-block sweep over accounts. Only two numbers are stored per identity: the banked
capacity at its last touch, and the block it was last touched.

Given the account's stake `weight`, the runtime derives everything from a few tunable constants:

```
cap     = min( weight * CapRatio, Ceiling )          # the bucket size (burst)
rate    = weight * RegenPerBlock                      # refill per block (sustained)
current = min( cap, capacity_last + rate * (now - last_block) )

need    = BaseCost + PerByteCost * text_len           # cost of this post
allow   iff  current >= need
on include:  capacity_last := current - need ;  last_block := now
```

A bigger lock means a bigger bucket **and** a faster refill, so heavier stakers post more often. Cost
scales with size: a one-word `gm` costs `BaseCost`; a 500-byte essay costs `BaseCost + 500·PerByteCost`.
Everything is done in fine-grained micro-capacity units with saturating arithmetic, so an account idle
for years simply clamps at `cap` instead of overflowing.

There is a hard entry price: **`MinLock` = 100 ADA** (100,000,000 lovelace). It is enforced twice — the
`talk_vault` validator refuses a lock below it, and the observer maps any observed balance under it to
weight 0. Below the floor you get nothing; there is no partial credit.

The current dev-tuned constants (all runtime-configurable, none consensus-critical) are
`CapRatio = 50`, `RegenPerBlock = 2`, `Ceiling = 5·10¹²` (~100k posts), `BaseCost = 50_000_000` (one
post), `PerByteCost = 50_000`, and `MaxLength = 512` bytes. Under these, a floor lock of 100 ADA
(weight 10⁸) gives `cap = min(10⁸·50, Ceiling) = 5·10⁹` ≈ 100 posts of burst, refilling at
`10⁸·2 = 2·10⁸` per block (≈4 posts/block), so ~25 blocks empty→full. 1,000 ADA gives ten times that,
up to the `Ceiling`. The curve is deliberately **linear with a hard ceiling** ("capped-linear"): weight
is proportional to locked lovelace, then flattened at the top so no single whale can dominate the
mempool. Linear is the one split-neutral choice — an anti-whale (concave) curve would actually *reward*
splitting stake across identities, so it stays off the table until the identity gate is proven stronger.

The bucket, its constants, and the check-and-consume logic all live folded into **`pallet-microblog`**.

## Posting capacity vs voting power

Two different Cardano-derived quantities feed the social layer, and they must not be confused:

- **Posting capacity** comes from **`AllowedStake`** — the lovelace in the account's largest qualifying
  `talk_vault` UTxO (below the 100-ADA `MinLock` floor it is zero). Lock more, post more. Unlock, and it
  goes to zero.
- **Voting power** comes from **`VotingPower`** — the *total* Cardano stake behind the bound stake
  credential (its `epoch_stake`), whether or not any of it is locked. This weights votes and polls.

Locking 100 ADA buys you a posting rate; it does not, by itself, buy vote weight — that tracks your
whole delegated stake. Both live in the call-less **`pallet-talk-stake`** ledger (`AllowedStake` and
`VotingPower`), keyed by posting account.

There is one further, opt-in weight (spec 207) that neither of these drives: on a **governance poll** a
verified SPO or dRep also counts for its *delegated* Cardano stake — the pool's total delegated stake, or
the dRep's delegated voting stake — in a separate, display-only chamber tally kept beside the ordinary
`VotingPower` vote and never summed with it. That weight rides with the role tag (`ObservedRole.weight`),
not talk-stake, and only ever applies to a governance-kind poll. See
[`VERIFIABLE-ROLE-TAGS.md`](VERIFIABLE-ROLE-TAGS.md#governance-polls-spec-207).

## Where the weight comes from

Weight is not self-declared and there is no trusted `set_stake` extrinsic. It enters the chain through
exactly one path: the **`cardano-observer` inherent**, a consensus-verified reduction of Cardano
db-sync state that every node recomputes identically and seals against a stable Cardano block. The
observer credits locked vault lovelace to `AllowedStake` and delegated `epoch_stake` to `VotingPower`,
block by block. See [`IN-PROTOCOL-OBSERVATION.md`](IN-PROTOCOL-OBSERVATION.md) for how that read is
made deterministic, and [`TRUSTLESS-IDENTITY.md`](TRUSTLESS-IDENTITY.md) for the CIP-8 binding that
ties a Cardano address to a posting account.

That 1:1 identity binding is load-bearing, not decoration. Every stake-weighted scheme is farmable by
splitting stake across many identities unless **one bucket = one verified Cardano identity**. The gate
enforces a hard one-to-one map between a Cardano owner address and a single posting account, and the
observer credits only the **single largest** qualifying vault UTxO per identity — it never sums them, so
splitting a lock across many UTxOs buys nothing (and each split piece under 100 ADA is worth zero).
Break either half and capacity multiplies for free.

## Anti-toggle rules

Because you can unlock your ADA at any time, the design has to make lock/unlock/relock toggling
worthless. There is **no on-chain timelock and no unlock cooldown** — the commitment is structural
instead:

- A brand-new identity's bucket **starts empty** and charges up. Full-on-first-touch plus cheap
  identities would be an instant burst farm.
- Capacity accrues **only while the lock stays parked**, and **clamps to zero on unlock** (the observer
  writes `weight = 0`, which drops the ceiling to zero).
- The capacity row is **never deleted** on unlock — only the weight goes to zero. So a later relock
  cannot read an empty first-touch slot and re-mint a fresh full bucket; it resumes from zero and must
  charge up again.

Together these mean toggling buys nothing: you forfeit accrued capacity the moment you spend the lock,
and you cannot launder it back by relocking.

## Where the check runs

Since there are no fees, all spam protection rests on the capacity check — and **it runs at the
mempool layer**, in the `CheckCapacity` transaction extension's `validate()`, not only as an on-chain
check. An on-chain-only check fires too late: a valid-but-over-budget transaction would already have
entered the mempool and been gossiped for free, which on a feeless chain *is* the spam. `validate()`
does a couple of cheap reads and rejects an over-budget post from the pool with `ExhaustsResources`.

Capacity is **consumed only on inclusion**, in `post_dispatch` — never in `validate()` (the pool may
call it many times per transaction). The block author re-validates at build time, so only about `cap`
posts from an account can actually land. FRAME's per-block weight limits are the backstop that caps
per-block execution regardless.

One honest scoping note: capacity disciplines **users**, not the operator. On a single-operator PoA
chain the operator builds the blocks and could include their own over-budget posts. This is a live,
operator-run preprod testnet (spec_version 204 / transaction_version 3, genesis `0x73eaa4bf`), not a
trustless network — consensus trust, not capacity, is the real security boundary. Capacity's job is to
rate-limit everyone else, exactly as fees once did.

## The other budget: governance-fuel

Why does a feeless chain have fees at all? Because `CheckCapacity` only meters the *social* calls.
Everything else a signed account can submit — `System::remark`, a validator's `Session::set_keys`, a
seated member's committee propose/vote/close — is unmetered, and some of it is permissionless. Fees are
the only thing pricing that surface: set them to zero and any keypair can flood the mempool with free
remarks. So the fee mechanism stays, and the native token exists solely to feed it.

That leaves a second, entirely separate resource for the handful of fee-bearing **admin** calls an
operator submits: **governance-fuel**, held in `pallet-governance-fuel`.

Fuel is a committee-granted, self-refilling budget. The 3-of-5 committee sets a per-account standing
allowance with `set_allowance`; an `on_initialize` hook mints each funded account back up toward its
ceiling every `RegenPeriod`. This fixes two failure modes at once: fees are burned, so a fixed supply
would eventually starve governance; and a member drained to zero could otherwise not even vote to
approve their own top-up. Mint-on-demand regeneration dissolves both — a drained member auto-recovers
next period.

Fuel is deliberately powerless outside its one job. It is **non-transferable** (the base call filter
blocks the entire balances surface, not just transfers), it can **never post** (the social layer never
reads balances, so granting fuel confers zero posting power), and it is not vote- or consensus-weight.
It is also a *seating prerequisite*: an account must hold an allowance before it can be added as a
validator or committee member. The committee cuts off a spammer with `revoke`, which drops the
allowance and claws back the balance — escape-proof precisely because fuel cannot be moved. So the two
budgets are mirror images: both are non-transferable, non-purchasable, governance-granted, regenerating
rate-limits; neither is money; neither can post.

## Precedents

This shape is production-proven, not novel research. **Hive** (inheriting Steem's 2018 "Velocity"
hardfork) runs 100% feeless posting gated entirely by a regenerating, stake-weighted "manabar" that
refills linearly over five days — social-media scale, almost exactly this model. **Midnight**'s NIGHT → DUST is the
owner's explicit reference: a held token continuously generates a consumable resource up to a
stake-proportional cap, burned to pay fees and refilled while the token is held. Both prove the same
three things cogno-chain needs — feeless posting, gated by a regenerating staked resource, at scale.
