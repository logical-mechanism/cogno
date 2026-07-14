// Regenerate — or VERIFY — the parameterized `talk_vault` artifact (`vault.json`) from the
// committed blueprint (`contracts/plutus.json`). This is the SINGLE source of the live L1 script
// hash + applied CBOR that every off-chain consumer reads (the CLI's L1 lock/unlock path, the
// committee driver) and that the frontend imports + pins.
//
// Run it after any `aiken build` that changes the validator. Changing the validator moves the
// compiled hash -> the min_lock-applied policy id / vault address -> it ORPHANS any
// previously-deployed vault (old UTxOs must be exited under the old script, a fresh vault
// minted under the new). See contracts/README.md "Redeploy impact".
//
//   node contracts/scripts/regen-vault.mjs --verify      # check-only: recompute + compare, write NOTHING
//   node contracts/scripts/regen-vault.mjs               # -> contracts/vault.json + the frontend's pinned copy
//   node contracts/scripts/regen-vault.mjs --out /tmp/vault.json    # -> that path ONLY (never the pinned copy)
//   node contracts/scripts/regen-vault.mjs --min-lock 100000000 --stake <skhHex>
//
// `--verify` is the reader-facing mode: it proves the committed 168a9710… vault hash is what this
// blueprint actually applies to, and exits non-zero if anything drifted. It never writes.
//
// Method (matches the live `paramForm: "JSON {int}"` and the in-browser lock path):
//   applyParamsToScript(compiledCode, [JSON.stringify({ int: minLock })], "JSON")
//     -> resolveScriptHash(_, "V3")   ==   the policy id == the vault script hash.
// /!\ The Int param MUST be the `{ int: ... }` JSON form. A bare number silently yields a
//     DIFFERENT (wrong) hash -> a vault address nothing can spend: the applied param's type must
//     match the on-chain type (see contracts/README.md).
//
// The @meshsdk deps live in app/node_modules (the Aiken project itself has no node deps), so they
// are resolved from there explicitly rather than relying on cwd — run `npm ci` in app/ first.
//
// Run with the nvm node (v22.12.0). The snap node writes stdout to /dev/null, so it swallows this
// script's output; `--verify`'s EXIT CODE (0 = match, 1 = drift) is authoritative either way, and
// the written artifact is self-describing:
//   jq '{blueprintHash, vaultHash, minLock, paramForm}' contracts/vault.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const require = createRequire(path.join(repoRoot, "app", "package.json"));
const { applyParamsToScript } = require("@meshsdk/core-cst");
const { resolveScriptHash, serializePlutusScript } = require("@meshsdk/core");

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const VERIFY = args.includes("--verify");
// An explicit --out means "write it over there" — so it must NOT also rewrite the frontend's pinned
// copy of the LIVE hash. Only the default (no --out) invocation is the redeploy path that syncs it.
const OUT_EXPLICIT = args.includes("--out");
const MIN_LOCK = getArg("--min-lock", "100000000");
const OUT = path.resolve(getArg("--out", path.join(repoRoot, "contracts", "vault.json")));
// Optional sanity print only: derive the vault address for a known owner stake key. The
// real per-owner address is built at lock time from (appliedCbor, that owner's stake cred).
const STAKE = getArg("--stake", "10133fde075851839bbc21b1d95bf552adb4035e7ea973c3712d58c3");

const blueprintPath = path.join(repoRoot, "contracts", "plutus.json");
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
const compiledCode = blueprint.validators[0].compiledCode;
if (!blueprint.validators.every((v) => v.compiledCode === compiledCode)) {
  throw new Error("validators do not share one compiledCode — blueprint shape changed; review before regenerating");
}

const appliedCbor = applyParamsToScript(compiledCode, [JSON.stringify({ int: Number(MIN_LOCK) })], "JSON");
const vaultHash = resolveScriptHash(appliedCbor, "V3");
const blueprintHash = blueprint.validators[0].hash;

const artifact = {
  minLock: MIN_LOCK,
  blueprintHash, // unparameterized hash from plutus.json (49ffbfc6… after the L-01 audit fix)
  vaultHash, // the min_lock-applied policy id == vault script hash
  appliedCbor,
  paramForm: "JSON {int}",
  compiler: blueprint.preamble?.compiler ?? null,
  generatedFrom: "contracts/plutus.json",
};
// A sample vault address for a known owner stake key — recorded in the artifact for a
// quick eyeball check (the real per-owner address is rebuilt at lock time from this skh).
const { address: sampleAddress } = serializePlutusScript({ code: appliedCbor, version: "V3" }, STAKE, 0, false);
artifact.sampleVaultAddress = { stakeKeyHash: STAKE, address: sampleAddress };

const json = JSON.stringify(artifact, null, 2) + "\n";

// The frontend's pinned copy of the live hash (the in-browser lock imports + asserts this).
const APP_OUT = path.join(repoRoot, "app", "src", "lib", "cardano", "vault.json");

if (VERIFY) {
  const committedPath = path.join(repoRoot, "contracts", "vault.json");
  const fail = [];
  const committed = JSON.parse(fs.readFileSync(committedPath, "utf8"));
  const short = (v) => (typeof v === "string" && v.length > 24 ? `${v.slice(0, 16)}…(${v.length} chars)` : String(v));
  for (const k of ["minLock", "blueprintHash", "vaultHash", "appliedCbor", "paramForm"]) {
    if (committed[k] !== artifact[k]) {
      fail.push(`contracts/vault.json ${k}: committed ${short(committed[k])} != recomputed ${short(artifact[k])}`);
    }
  }
  // The frontend pins the same artifact byte-for-byte — a drift here ships a dead vault address.
  if (fs.existsSync(APP_OUT)) {
    if (fs.readFileSync(APP_OUT, "utf8") !== fs.readFileSync(committedPath, "utf8")) {
      fail.push("app/src/lib/cardano/vault.json differs from contracts/vault.json");
    }
  } else {
    fail.push(`missing pinned copy: ${APP_OUT}`);
  }
  if (fail.length) {
    console.error("VAULT VERIFY: FAIL");
    for (const f of fail) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`VAULT VERIFY: OK  blueprint ${blueprintHash} + min_lock ${MIN_LOCK} -> vault ${vaultHash}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, json);
if (!OUT_EXPLICIT && fs.existsSync(path.dirname(APP_OUT))) fs.writeFileSync(APP_OUT, json);
