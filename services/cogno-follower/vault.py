"""M2d — observe `talk_vault` UTxOs on Cardano and turn locked ADA into L3 weight.

The follower indexes beacon UTxOs by the vault's policy id (== the validator hash) via Kupo, then
for each identity (= the beacon asset name = blake2b_256(cbor.serialise(owner)), the SAME 32 bytes
the gate binds — see beacon.py) computes a weight from the locked lovelace and writes it via
`TalkStake.set_stake(account, weight)` (sudo in v1 dev). The bound `account` for an identity comes
from the on-chain `CognoGate.AccountOf[beacon_name]` the follower wrote at link time.

Uniqueness rule (L1 can't enforce one-vault-per-pkh; the mint policy is tx-local — L1 §6/DR): the
follower uses **largest-UTxO-wins per identity, NEVER sum**. Self-correcting: duplicates only ever
credit your single biggest vault, so a Sybil can't multiply weight by fragmenting a lock, and nobody
is ever zeroed by it. The capped-linear CURVE + the per-identity ceiling live on L3 (the chain
clamps `min(weight·CapRatio, Ceiling)`); L1 only enforces `min_lock`, so the follower's job is just
"weight = the largest locked lovelace for this identity".

⚠ The Kupo HTTP query + the set_stake submit need a SYNCED cardano-node + Kupo on preprod/mainnet
(the one external dependency M2d can't satisfy locally). The pure logic below is fixture-tested in
test_vault.py; the live wiring is a thin wrapper named honestly.
"""
import json
import urllib.request


def weight_for_lock(lovelace: int, min_lock: int = 100_000_000) -> int:
    """The L3 weight for a vault holding `lovelace`. v1 = the locked lovelace itself (the chain's
    CapRatio/Ceiling apply the capped-linear curve + the per-identity ceiling, ECONOMICS §6.1).
    Defensive floor: below `min_lock` yields 0 (L1 rejects sub-floor locks, so this shouldn't fire)."""
    return lovelace if lovelace >= min_lock else 0


def parse_matches(matches: list, policy_id_hex: str) -> list:
    """From Kupo `/matches/{policy_id}.*` JSON, extract `(beacon_name_hex, lovelace)` for every
    UTxO holding exactly one beacon under `policy_id`. Ignores anything not holding a single beacon
    (the on-chain mint guards guarantee 1 beacon per vault, but we never trust that off-chain)."""
    out = []
    for m in matches:
        value = m.get("value", {})
        coins = int(value.get("coins", 0))
        assets = value.get("assets", {}) or {}
        # Kupo keys assets as "<policyid>.<assetname>" (hex). Find this policy's single beacon.
        beacons = [
            (k.split(".", 1)[1], int(q))
            for k, q in assets.items()
            if k.split(".", 1)[0].lower() == policy_id_hex.lower()
        ]
        if len(beacons) == 1 and beacons[0][1] == 1:
            out.append((beacons[0][0].lower(), coins))
    return out


def weights_by_identity(matches: list, policy_id_hex: str, min_lock: int = 100_000_000) -> dict:
    """`beacon_name_hex -> weight`, applying LARGEST-WINS per identity (never sum)."""
    largest: dict[str, int] = {}
    for beacon_hex, coins in parse_matches(matches, policy_id_hex):
        if coins > largest.get(beacon_hex, -1):
            largest[beacon_hex] = coins
    return {b: weight_for_lock(c, min_lock) for b, c in largest.items()}


# ── live wiring (needs a SYNCED cardano-node + Kupo — the M2d external dependency) ─────────────

def query_kupo(kupo_url: str, policy_id_hex: str) -> list:
    """GET unspent beacon UTxOs under the vault policy from Kupo. Live; needs a synced Kupo."""
    url = f"{kupo_url.rstrip('/')}/matches/{policy_id_hex}.*?unspent"
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)


def plan_set_stakes(matches: list, policy_id_hex: str, account_of, min_lock: int = 100_000_000) -> list:
    """The set_stake plan: for each observed identity, look up the bound account via `account_of`
    (e.g. a CognoGate.AccountOf[beacon] read) and pair it with its weight. Identities with no bound
    account yet are skipped (bind precedes weight). Returns [(account, weight)]."""
    plan = []
    for beacon_hex, weight in weights_by_identity(matches, policy_id_hex, min_lock).items():
        account = account_of(beacon_hex)
        if account is not None:
            plan.append((account, weight))
    return plan
