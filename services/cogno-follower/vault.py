"""M2d — observe `talk_vault` UTxOs on Cardano and turn locked ADA into L3 weight.

The follower indexes beacon UTxOs by the vault's policy id (== the validator hash) via db-sync, then
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

⚠ The db-sync query + the set_stake submit need a SYNCED cardano-node + db-sync on preprod/mainnet
(the one external dependency M2d can't satisfy locally). The pure logic below is fixture-tested in
test_vault.py; the live wiring is a thin wrapper named honestly.
"""


def weight_for_lock(lovelace: int, min_lock: int = 100_000_000) -> int:
    """The L3 weight for a vault holding `lovelace`. v1 = the locked lovelace itself (the chain's
    CapRatio/Ceiling apply the capped-linear curve + the per-identity ceiling, ECONOMICS §6.1).
    Defensive floor: below `min_lock` yields 0 (L1 rejects sub-floor locks, so this shouldn't fire)."""
    return lovelace if lovelace >= min_lock else 0


def parse_matches(matches: list, policy_id_hex: str) -> list:
    """From the db-sync vault match JSON, extract `(beacon_name_hex, lovelace)` for every
    UTxO holding exactly one beacon under `policy_id`. Ignores anything not holding a single beacon
    (the on-chain mint guards guarantee 1 beacon per vault, but we never trust that off-chain)."""
    out = []
    for m in matches:
        value = m.get("value", {})
        coins = int(value.get("coins", 0))
        assets = value.get("assets", {}) or {}
        # Assets are keyed as "<policyid>.<assetname>" (hex). Find this policy's single beacon.
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


# ── DETERMINISTIC as-of-reference observation (in-protocol-observation step 2 / D4) ─────────────────
# The Python mirror of services/_shared/observation.mjs. The SAME pure logic the off-chain reader, the
# in-node InherentDataProvider, and (eventually) the Rust runtime all run BYTE-IDENTICALLY — proven by
# the cross-language canonical-bytes vector in test_vault.py. See docs/IN-PROTOCOL-OBSERVATION.md §5.
#
# Key difference vs weights_by_identity (which reads "unspent now" + applies the floor): observe_as_of
# reads AS-OF a FIXED reference slot — created ≤ ref AND (spent is None OR spent.slot > ref) — so a UTxO
# spent AFTER the reference is still counted as locked-at-ref (the bug `?unspent` would introduce). It
# returns the RAW largest lovelace per beacon (the observed STATE); the MIN_LOCK floor (weight_for_lock)
# is applied downstream at weight-application, not here.

def cardano_reference_slot(unix_seconds, shelley_start_unix, shelley_start_slot,
                           stability_slots, slot_length_ms: int = 1000):
    """PURE + FAIL-CLOSED: the Cardano slot to observe AS-OF = Shelley-anchored slot at `unix_seconds`
    minus the stability window. Returns an int slot, or None on a degenerate input (pre-Shelley /
    wrong-network / underflow) ⇒ the caller emits the EMPTY observation. Guards BEFORE subtracting so a
    pre-Shelley time can never produce a wrong slot (mirrors the wasm overflow-checks-off guard in Rust).
    Only 1 s Shelley slots; the anchor is the Shelley start, NOT Byron systemStart (§5.2)."""
    if int(slot_length_ms) != 1000:
        raise ValueError(f"cardano_reference_slot supports only 1 s Shelley slots (got {slot_length_ms})")
    t, t0, s0, w = int(unix_seconds), int(shelley_start_unix), int(shelley_start_slot), int(stability_slots)
    if w < 0:
        raise ValueError("stability_slots must be >= 0")
    if t < t0:
        return None  # before the Shelley anchor ⇒ no valid slot (fail closed)
    reference = (s0 + (t - t0)) - w
    if reference < s0:
        return None  # window larger than elapsed Shelley slots ⇒ fail closed
    return reference


def observe_as_of(matches: list, policy_id_hex: str, reference_slot, reasons: dict | None = None) -> dict:
    """`beacon_name_hex -> raw largest lovelace` AS-OF `reference_slot`, LARGEST-WINS per identity (never
    sum). A match counts only if it carries exactly one vault-policy beacon at qty 1, positive lovelace,
    was created ≤ ref, and is unspent as-of ref. Pass `reasons` (a dict) to capture why each skipped UTxO
    was rejected (only surfaced if that beacon was not credited by another UTxO)."""
    if reference_slot is None:
        return {}
    ref = int(reference_slot)
    ph = policy_id_hex.lower()
    largest: dict[str, int] = {}
    rejected: list = []

    def utxo_id(m, fb):
        return f"{m.get('transaction_id', fb)}#{m.get('output_index', 0)}"

    for m in matches:
        value = m.get("value", {}) or {}
        assets = value.get("assets", {}) or {}
        beacons = [(k.split(".", 1)[1], int(q)) for k, q in assets.items()
                   if k.split(".", 1)[0].lower() == ph]
        if len(beacons) != 1 or beacons[0][1] != 1:
            rejected.append((utxo_id(m, str(assets)), None,
                             f"not exactly one beacon at qty 1 ({len(beacons)} vault asset(s))"))
            continue
        beacon = beacons[0][0].lower()
        created = (m.get("created_at") or {}).get("slot_no")
        if created is None:
            rejected.append((utxo_id(m, beacon), beacon, "no created_at.slot_no (fail closed)"))
            continue
        if int(created) > ref:
            rejected.append((utxo_id(m, beacon), beacon, f"created at slot {created} > reference {ref} (too fresh)"))
            continue
        spent = (m.get("spent_at") or {}).get("slot_no") if m.get("spent_at") else None
        if spent is not None and int(spent) <= ref:
            rejected.append((utxo_id(m, beacon), beacon, f"spent at slot {spent} <= reference {ref} (not locked as-of ref)"))
            continue
        coins = int(value.get("coins", 0))
        if coins <= 0:
            rejected.append((utxo_id(m, beacon), beacon, "zero/negative lovelace (swept UTxO not credited)"))
            continue
        if coins > largest.get(beacon, 0):  # strict: equal-lovelace dups collapse to one value-identical entry
            largest[beacon] = coins

    if reasons is not None:
        for uid, beacon, why in rejected:
            if beacon and beacon in largest:
                continue  # credited by another UTxO ⇒ not a real rejection
            reasons[uid] = f"{beacon[:16]}…: {why}" if beacon else why
    return largest


def _compact(n: int) -> bytes:
    """SCALE compact integer (single / two-byte / four-byte modes — enough for any real vault set)."""
    v = int(n)
    if v < 0:
        raise ValueError("compact length must be >= 0")
    if v < 64:
        return bytes([v << 2])
    if v < 16384:
        return ((v << 2) | 0b01).to_bytes(2, "little")
    if v < 1073741824:
        return ((v << 2) | 0b10).to_bytes(4, "little")
    raise ValueError("compact length too large for this encoder")


def canonical_bytes(reference_slot, observed) -> bytes:
    """PURE: the canonical SCALE-compatible byte layout two independent reads must agree on (the
    determinism WITNESS). ObservedVault { reference_slot: u64 LE, entries: Vec<([u8;32], u128 LE)> },
    entries sorted ascending by the 32 raw beacon bytes (≡ lowercased-hex order). `observed` is a dict
    `{beacon_hex: lovelace}` or a list of `(beacon_hex, lovelace)`. Byte-identical to canonicalBytes() in
    services/_shared/observation.mjs (cross-checked in test_vault.py)."""
    items = list(observed.items()) if isinstance(observed, dict) else list(observed)
    entries = sorted(((h.lower(), int(v)) for h, v in items), key=lambda e: e[0])
    out = bytearray()
    out += int(reference_slot).to_bytes(8, "little")          # reference_slot: u64
    out += _compact(len(entries))                              # Vec length
    for h, v in entries:
        b = bytes.fromhex(h)
        if len(b) != 32:
            raise ValueError(f"beacon must be 32 bytes (got {len(b)} from '{h}')")
        out += b                                               # 32 raw beacon bytes
        out += int(v).to_bytes(16, "little")                   # lovelace: u128
    return bytes(out)


def canonical_hex(reference_slot, observed) -> str:
    return canonical_bytes(reference_slot, observed).hex()


# ── live wiring (needs a SYNCED cardano-node + db-sync — the M2d external dependency) ──────────

def query_dbsync(dbsync_url: str, policy_id_hex: str) -> list:
    """SELECT currently-unspent beacon UTxOs under the vault policy from Cardano db-sync. Live; needs a
    synced db-sync. Returns the canonical list of match dicts the pure functions above consume.

    Determinism choices (mirrored from the node + committee JS that already moved to db-sync):
      • spentness comes from the canonical `tx_in` ledger table (NOT the denormalized/unreliable
        `consumed_by_tx_id`) — the NOT EXISTS subquery is the `?unspent` semantics. This REQUIRES a
        tx_in-enabled db-sync: under `--consumed-tx-out` mode tx_in is empty, so we probe
        `EXISTS (SELECT 1 FROM tx_in)` and RAISE (fail-closed) rather than emit spent vaults as unspent;
      • coins/quantities are emitted as `::text` strings: lovelace exceeds 2^53, so they must never
        round-trip through a float/int that loses precision;
      • driven from `tx_out.payment_cred = <vault script hash>` (the vault script address == the
        policy id, indexed via `idx_tx_out_payment_cred`).

    The query returns one row / one column `matches`: a JSON array psycopg returns already parsed as
    a Python list, so we hand it straight to parse_matches/observe_as_of. `spent_at` is always NULL
    because the NOT EXISTS filter already excludes spent UTxOs (these are the live `?unspent` reads).

    ⚠ The connection is plaintext (read-only `cogno_reader` role; the server allows non-SSL). TLS to
    db-sync is a MAINNET PREREQUISITE."""
    import psycopg  # lazy: keeps the pure-logic tests in test_vault.py runnable without psycopg
    sql = """
SELECT (SELECT EXISTS (SELECT 1 FROM tx_in)) AS tx_in_ok,
  COALESCE(json_agg(json_build_object(
  'transaction_id', encode(ctx.hash,'hex'),
  'output_index',   o.index,
  'value', json_build_object(
     'coins',  o.value::text,
     'assets', (SELECT json_object_agg(encode(a.policy,'hex')||'.'||encode(a.name,'hex'), m.quantity::text)
                FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident
                WHERE m.tx_out_id = o.id AND a.policy = decode(%(pol)s,'hex'))),
  'created_at', json_build_object('slot_no', cb.slot_no),
  'spent_at',   NULL)), '[]'::json) AS matches
FROM tx_out o
JOIN tx ctx   ON ctx.id = o.tx_id
JOIN block cb ON cb.id = ctx.block_id
WHERE o.payment_cred = decode(%(pol)s,'hex')
  AND NOT EXISTS (SELECT 1 FROM tx_in ti WHERE ti.tx_out_id = o.tx_id AND ti.tx_out_index = o.index)
  AND EXISTS (SELECT 1 FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident
              WHERE m.tx_out_id = o.id AND a.policy = decode(%(pol)s,'hex'))
"""
    with psycopg.connect(dbsync_url) as conn, conn.cursor() as cur:
        cur.execute(sql, {"pol": policy_id_hex.lower()})
        row = cur.fetchone()
        # Fail-closed: under db-sync `--consumed-tx-out` mode tx_in is empty, which would emit a spent
        # vault as unspent (a wrong read). Mirror Midnight's `EXISTS (SELECT 1 FROM tx_in)` probe + RAISE.
        if not row or not row[0]:
            raise RuntimeError("db-sync tx_in table is empty (--consumed-tx-out mode?); requires a "
                               "tx_in-enabled db-sync (fail closed)")
        return row[1] if row[1] else []


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
