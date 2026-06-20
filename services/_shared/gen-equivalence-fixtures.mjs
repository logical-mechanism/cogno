// Generator for the Rust↔JS observation determinism EQUIVALENCE fixture (in-protocol-observation, D4).
//
//   node services/_shared/gen-equivalence-fixtures.mjs        # writes fixtures/observation-equivalence.json
//
// The fixture is the SINGLE SOURCE OF TRUTH shared by two test suites in two languages:
//   • services/_shared/observation-equivalence.test.mjs  (JS — guards observation.mjs against drift)
//   • node/src/cardano_observer.rs  #[test] rust_matches_js_observation_equivalence_fixture
//     (Rust — re-derives observe_as_of + SCALE encoding and asserts it equals the JS golden byte-for-byte)
//
// This mirrors Midnight's primitives/mainchain-follower/tests/cnight_equivalence.rs (which asserts two
// observation implementations return byte-identical output for the same input). Here the two
// implementations are in DIFFERENT languages, so instead of comparing in one process we pin a committed
// golden — computed here by the canonical JS spec (observation.mjs) — and have BOTH suites re-derive and
// assert against it. A divergence on EITHER side fails its suite (the determinism a consensus inherent
// rests on: same Cardano state + same reference slot ⇒ byte-identical observed state on every node).
//
// Regenerate (and re-commit) this fixture only on a DELIBERATE change to observation.mjs's output; the
// committed golden is the regression contract, so an accidental change makes both suites fail loudly.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { observeAsOf, canonicalHex, candidateHex } from "./observation.mjs";

const V = "168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7"; // the live talk_vault policy id
const A = "aa".repeat(32); // beacon A (0xAA…) — sorts before B before C by raw bytes
const B = "bb".repeat(32); // beacon B
const C = "cc".repeat(32); // beacon C
const OTHER = "ff".repeat(28); // a non-vault policy id

// A Kupo-shaped /matches entry: exactly one vault beacon at qty 1, `coins` lovelace (string, as Kupo
// encodes it), created/spent slots, optional extra (non-vault or second-vault) assets. Mirrors the `mk`
// in observation.test.mjs and the field layout node/src/cardano_observer.rs::observe_as_of reads.
const mk = (beacon, coins, { created = 0, spent = null, extra = {}, tx = "tx", ix = 0 } = {}) => ({
	transaction_id: tx,
	output_index: ix,
	value: { coins: String(coins), assets: { [`${V}.${beacon}`]: "1", ...extra } },
	created_at: { slot_no: created, header_hash: "hh" },
	spent_at: spent == null ? null : { slot_no: spent, header_hash: "hh" },
});

const REF = 1_000_000; // a reference slot well past the Shelley anchor

// REAL preprod db-sync output for the two live talk_vault UTxOs (captured via services/committee/dbsync.mjs).
// The EXACT shape the db-sync SQL emits: `coins` a ::text string, `slot_no` a JSON number, `spent_at` either
// `{slot_no}` or null, and NO `header_hash` (the SQL omits it — the reduction never reads it). Used by the
// two `dbsync-live-preprod-*` cases below so the cross-language golden is grounded in real db-sync data.
const BEACON_287 = "287a99d244b41967cd6944ad096d57d0cbad6d152c40cd803b9a9cec0ae6be75";
const BEACON_8C2 = "8c2ef2a09dd01694d4a9052665c787b954a572451662b01ff6ed2a18b68779ce";
const DBSYNC_LIVE_MATCHES = [
	{
		transaction_id: "33202448b66e91389fc6ba68f555fdf02b673bb420cd143959fbf26fdcc87e30",
		output_index: 0,
		value: { coins: "100000000", assets: { [`${V}.${BEACON_287}`]: "1" } },
		created_at: { slot_no: 126066527 },
		spent_at: null,
	},
	{
		transaction_id: "169232476681d885b23463fecc93677ecca9486411d6f82273f85639351205c8",
		output_index: 0,
		value: { coins: "100000000", assets: { [`${V}.${BEACON_8C2}`]: "1" } },
		created_at: { slot_no: 126071260 },
		spent_at: { slot_no: 126075034 },
	},
];

// The cases — each exercises a determinism-relevant rule the Rust port must reproduce EXACTLY.
const rawCases = [
	{ name: "empty", referenceSlot: 0, matches: [] },
	{ name: "single-beacon", referenceSlot: REF, matches: [mk(A, 200_000_000, { created: 5 })] },
	{
		name: "largest-wins-never-sum",
		referenceSlot: REF,
		// three UTxOs for the SAME beacon → keep the single largest (250M), never the sum.
		matches: [
			mk(A, 100_000_000, { created: 1, tx: "lo" }),
			mk(A, 250_000_000, { created: 2, tx: "hi" }),
			mk(A, 180_000_000, { created: 3, tx: "mid" }),
		],
	},
	{
		name: "two-beacons-shuffled-with-noise",
		referenceSlot: REF,
		// shuffled input order + a smaller dup of A + a too-fresh A + a spent-before-ref A — none may
		// change the canonical output (A:250M, B:150M sorted ascending by beacon bytes).
		matches: [
			mk(B, 150_000_000, { created: 20, tx: "b" }),
			mk(A, 100_000_000, { created: 9, tx: "a-dup-lo" }),
			mk(A, 250_000_000, { created: 10, tx: "a-hi" }),
			mk(A, 999_999_999_999, { created: REF + 500, tx: "a-fresh" }), // created after ref — excluded
			mk(A, 777_000_000, { created: 4, spent: REF - 1, tx: "a-spent" }), // spent before ref — excluded
		],
	},
	{
		name: "spent-after-ref-still-locked",
		referenceSlot: REF,
		// spent strictly AFTER the reference ⇒ still counted as locked as-of ref (the `?unspent` trap).
		matches: [mk(A, 300_000_000, { created: 10, spent: REF + 500 })],
	},
	{
		name: "spent-at-ref-excluded",
		referenceSlot: REF,
		// spent exactly AT the reference ⇒ not locked as-of ref.
		matches: [mk(A, 300_000_000, { created: 10, spent: REF })],
	},
	{
		name: "too-fresh-excluded",
		referenceSlot: REF,
		matches: [mk(A, 300_000_000, { created: REF + 1 })],
	},
	{
		name: "raw-lovelace-below-min-lock-still-observed",
		referenceSlot: REF,
		// observeAsOf returns RAW lovelace; the MIN_LOCK floor is applied on-chain at weight-application,
		// NOT here — so a below-floor value is still part of the observed state (carried raw).
		matches: [mk(A, 99_000_000, { created: 5 })],
	},
	{
		name: "multi-vault-beacon-utxo-rejected",
		referenceSlot: REF,
		// a UTxO carrying TWO vault beacons is anti-Sybil-rejected (not exactly one vault asset at qty 1).
		matches: [mk(A, 900_000_000, { created: 5, extra: { [`${V}.${B}`]: "1" } })],
	},
	{
		name: "zero-coin-excluded",
		referenceSlot: REF,
		matches: [mk(A, 0, { created: 5 })],
	},
	{
		name: "wrong-policy-empty",
		referenceSlot: REF,
		// a beacon under a DIFFERENT policy id is not ours.
		matches: [
			{
				transaction_id: "t",
				output_index: 0,
				value: { coins: "500000000", assets: { [`${OTHER}.${A}`]: "1" } },
				created_at: { slot_no: 5, header_hash: "hh" },
				spent_at: null,
			},
		],
	},
	{
		name: "short-beacon-name-dropped",
		referenceSlot: REF,
		// Exactly one vault asset at qty 1 but a NON-32-byte beacon name (10 bytes). Dropped by BOTH the JS
		// spec (isBeacon32 guard) and the Rust hex32 → empty. Guards the [review] beacon-length divergence
		// (JS used to credit it, then canonicalBytes threw, while Rust silently dropped it).
		matches: [mk("aa".repeat(10), 200_000_000, { created: 5 })],
	},
	{
		name: "non-integer-qty-dropped",
		referenceSlot: REF,
		// qty "1.0": Number("1.0")===1 (the old loose gate) but strict asU64 and Rust u64::from_str both
		// REJECT it ⇒ both drop the UTxO → empty. Guards the [review] qty-parse divergence.
		matches: [{
			transaction_id: "q", output_index: 0,
			value: { coins: "200000000", assets: { [`${V}.${A}`]: "1.0" } },
			created_at: { slot_no: 5, header_hash: "hh" }, spent_at: null,
		}],
	},
	{
		name: "non-integer-coins-dropped",
		referenceSlot: REF,
		// coins "200000000.5": strict asU128 and Rust u128::from_str both REJECT it ⇒ both drop → empty.
		// Guards the [review] coins-parse divergence (the old BigInt(coins) would have thrown).
		matches: [{
			transaction_id: "c", output_index: 0,
			value: { coins: "200000000.5", assets: { [`${V}.${A}`]: "1" } },
			created_at: { slot_no: 5, header_hash: "hh" }, spent_at: null,
		}],
	},
	{
		name: "compact-length-2-byte-boundary-64-beacons",
		referenceSlot: REF,
		// 64 DISTINCT beacons ⇒ Vec length 64 ⇒ the SCALE compact length flips from 1-byte (<64) to 2-byte
		// (0x0101). Crosses the boundary the other fixtures never reach; proves pushCompact's 2-byte branch
		// matches Rust Vec::encode for both the entries and the candidate pre-image.
		matches: Array.from({ length: 64 }, (_, i) =>
			mk(i.toString(16).padStart(64, "0"), 100_000_000 + i, { created: 5, tx: `b${i}` })),
	},
	{
		name: "candidate-sort-spent-and-coins-tiebreak",
		referenceSlot: REF,
		// THREE candidates with the SAME beacon AND the same created slot, differing only in spent (None vs
		// Some) then coins — exercises the full candidate tuple Ord (beacon, created, spent[None<Some],
		// coins) so the Rust derived-Ord sort and the JS comparator must agree byte-for-byte on the
		// pre-image. (All three reduce to one entry A:300M via largest-wins; the Some spend is after ref so
		// still locked.) Guards the None<Some tiebreak no other case makes the deciding comparison.
		matches: [
			mk(A, 300_000_000, { created: 42, spent: REF + 10, tx: "a-some-hi" }),
			mk(A, 100_000_000, { created: 42, spent: null, tx: "a-none-lo" }),
			mk(A, 200_000_000, { created: 42, spent: null, tx: "a-none-hi" }),
		],
	},
	{
		name: "realistic-mixed",
		referenceSlot: REF,
		// three beacons; A largest-wins over two UTxOs; B single; C spent-after-ref; plus excluded noise.
		matches: [
			mk(C, 500_000_000, { created: 100, spent: REF + 9000, tx: "c1" }),
			mk(A, 120_000_000, { created: 50, tx: "a1" }),
			mk(B, 100_000_000, { created: 60, tx: "b1" }),
			mk(A, 480_000_000, { created: 70, tx: "a2" }), // largest A
			mk(B, 90_000_000, { created: 80, spent: REF - 5, tx: "b-spent" }), // spent before ref — excluded
			mk(A, 5_000_000_000, { created: REF + 1, tx: "a-fresh" }), // too fresh — excluded
		],
	},
	{
		name: "dbsync-live-preprod-locked-both",
		// REAL preprod db-sync output (services/committee/dbsync.mjs / node/src/dbsync.rs) at a reference
		// BETWEEN the two live vaults' creation and the 8c2ef2a0 spend (slot 126075034) — both locked. Pins
		// db-sync's EXACT emitted shape — `coins` as a ::text STRING (precision-safe), `slot_no` as a JSON
		// number, `spent_at` either `{slot_no}` or null, and NO `header_hash` (the SQL omits it) — reducing
		// byte-identically cross-language. Captured live (tip ≈ 126.22M, vault policy 168a9710…).
		referenceSlot: 126073000,
		matches: DBSYNC_LIVE_MATCHES,
	},
	{
		name: "dbsync-live-preprod-one-spent",
		// The SAME real UTxOs, reference AFTER the 8c2ef2a0 spend (126075034) ⇒ only 287a99d2 stays locked
		// (8c2ef2a0 spent-before-ref is excluded). The two cases straddle the spent-before/after-ref split.
		referenceSlot: 126080000,
		matches: DBSYNC_LIVE_MATCHES,
	},
];

const cases = rawCases.map(({ name, referenceSlot, matches }) => {
	const observed = observeAsOf(matches, { vaultHash: V, referenceSlot });
	// Canonical order: ascending by raw beacon bytes (≡ lowercased-hex order) — the order the runtime
	// SCALE-compares against. observeAsOf's Map preserves first-seen order, so sort here for the golden.
	const expectedEntries = [...observed.entries()]
		.map(([hex, lovelace]) => [hex.toLowerCase(), lovelace.toString()])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const expectedCanonicalHex = canonicalHex({ referenceSlot, observed });
	// The input-commitment PRE-IMAGE (the partner-chains selection_inputs_hash analog): the canonical
	// SCALE bytes of the pre-reduction structural candidate set. The runtime hashes these with blake2_256;
	// the Rust↔JS equivalence pins the pre-image (blake2_256 of byte-identical input is identical).
	const expectedCandidateHex = candidateHex(matches, { vaultHash: V });
	return { name, vaultHash: V, referenceSlot, matches, expectedEntries, expectedCanonicalHex, expectedCandidateHex };
});

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "observation-equivalence.json");
const doc = {
	_comment:
		"GENERATED by services/_shared/gen-equivalence-fixtures.mjs from the canonical observation.mjs " +
		"spec. The Rust↔JS determinism equivalence regression (observation-equivalence.test.mjs + " +
		"node/src/cardano_observer.rs) re-derives each case and asserts it equals expectedCanonicalHex " +
		"byte-for-byte. Do not hand-edit; regenerate after a deliberate observation.mjs output change.",
	cases,
};
writeFileSync(outPath, JSON.stringify(doc, null, "\t") + "\n");
console.log(`wrote ${cases.length} cases → ${outPath}`);
