// Shared, dependency-free detection of the well-known public Substrate dev seeds (//Alice…). These
// public keys must be REFUSED for privileged signing under COGNO_PROFILE=prod — a forgotten
// `source network/env.sh` would otherwise silently sign with //Alice. Single source of truth for the
// committee tooling (services/committee/lib.mjs) AND the relayer's sudo signer (anchor-relayer), which
// previously each defined this regex independently (divergence risk if the dev-key list ever changed).

// The canonical well-known dev accounts (the sr25519/ed25519 //Name derivations on the dev phrase).
export const DEV_KEY_RE = /^\/\/(Alice|Bob|Charlie|Dave|Eve|Ferdie|Grace)$/;

// True iff `uri` is one of the public dev seeds (whitespace-tolerant). `null`/`undefined` ⇒ false.
export const isDevKey = (uri) => DEV_KEY_RE.test((uri || "").trim());
