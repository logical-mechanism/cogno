// Regenerate the parameterized `talk_vault` artifact (`vault.json`) from the committed
// blueprint (`contracts/plutus.json`). This is the SINGLE source of the live L1 script
// hash + applied CBOR that every off-chain consumer reads (the m2d lock/unlock scripts,
// the committee sync-weight driver, the follower) and that the frontend imports + pins.
//
// Run it after any `aiken build` that changes the validator. Changing the validator moves
// the compiled hash -> the min_lock-applied policy id / vault address -> it ORPHANS any
// previously-deployed vault (old UTxOs must be exited under the old script, a fresh vault
// minted under the new). See contracts/README.md "Redeploy impact".
//
//   node contracts/scripts/regen-vault.mjs                      # -> contracts/vault.json
//   node contracts/scripts/regen-vault.mjs --out /tmp/cogno-m2/vault.json
//   node contracts/scripts/regen-vault.mjs --min-lock 100000000 --stake <skhHex>
//
// Method (matches the live `paramForm: "JSON {int}"` and the in-browser lock path):
//   applyParamsToScript(compiledCode, [JSON.stringify({ int: minLock })], "JSON")
//     -> resolveScriptHash(_, "V3")   ==   the policy id == vault hash (DR-18).
// /!\ The Int param MUST be the `{ int: ... }` JSON form. A bare number silently yields a
//     DIFFERENT (wrong) hash -> a vault address nothing can spend (docs/L1-cardano.md
//     "Param types in applyParamsToScript must match the on-chain types").
//
// The @meshsdk deps live in app/node_modules (the Aiken project itself has no node deps),
// so resolve them from there explicitly rather than relying on cwd.
//
// NOTE: importing @meshsdk/core-cst instantiates the UPLC apply-params WASM, which redirects
// this process's stdout/stderr at load time — so console output after the import is swallowed.
// The written artifact is therefore the canonical, self-describing output: inspect it with
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
  vaultHash, // the min_lock-applied policy id == vault script hash (DR-18)
  appliedCbor,
  paramForm: "JSON {int}",
  compiler: blueprint.preamble?.compiler ?? null,
  generatedFrom: "contracts/plutus.json",
};
// A sample vault address for a known owner stake key — recorded in the artifact for a
// quick eyeball check (the real per-owner address is rebuilt at lock time from this skh).
const { address: sampleAddress } = serializePlutusScript({ code: appliedCbor, version: "V3" }, STAKE, 0, false);
artifact.sampleVaultAddress = { stakeKeyHash: STAKE, address: sampleAddress };

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
