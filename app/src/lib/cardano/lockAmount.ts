// The vault's lock amount as USER-FACING COPY, in a module that costs nothing to import.
//
// WHY IT IS NOT IN blueprint.ts. `LOCK_ADA_WHOLE` used to live there, derived from `MIN_LOCK` →
// `currentVaultScript()` → `vaults.ts` → `import vault from "./vault.json"`. That is a 6 KB file of
// applied Plutus CBOR, and importing it is correct for anything that BUILDS a transaction. It is not
// correct for rendering the string "100".
//
// The number is named in copy on surfaces that are in the app-shell / first-load chunk for a cold
// visitor who may never lock anything: the composer's guest prompt, the sign-in sheet, the walled-route
// notice, the home sign-in card, and the root layout's `description` metadata. Reaching `MIN_LOCK` from
// any of those pulled the vault artifact into the chunk every first-time reader downloads. `layout.tsx`
// spotted the hazard and worked around it by hardcoding "100" in its own string with a comment asking
// the next person to remember — which is exactly the drift `LOCK_ADA_WHOLE` was created to end.
//
// So both halves live here: the copy string with no dependencies, and a test
// (`lockAmount.test.ts`) that asserts it against the script's own `minLock`. A redeploy that moves the
// floor fails the suite rather than shipping a sentence that misquotes the price of posting.
//
// Anything that MOVES ADA still reads `MIN_LOCK` (lib/cardano/blueprint) or the per-script
// `info.script.minLock`. This is display only, and must never be parsed back into an amount.

/**
 * The current vault's lovelace floor rendered as whole ADA, for sentences like "lock 100 ADA".
 *
 * Pinned to `MIN_LOCK / 1_000_000n` by lockAmount.test.ts. `formatAda` is deliberately not used: it
 * renders a decimal place ("100.0 ADA"), which reads as a precision none of these sentences is making
 * a claim about.
 */
export const LOCK_ADA_WHOLE = "100";
