//! Key handling — cardano-cli-style secret keys linked **by file path**, never seed phrases.
//!
//! The headline requirement: secret keys are loaded from a file path, there is **no** mnemonic /
//! `//derivation` / seed-env code path anywhere, and a `--prod` profile **refuses** the well-known dev
//! keys. This replaces the retired `services/_shared/keys.mjs` (which only knew a `DEV_KEY_RE` string
//! regex) with a pubkey-identity denylist that a renamed dev-key file cannot dodge.
//!
//! This is a SHARED crate (the cogno-dbsync precedent): both the `cogno-chain-cli` (which writes/loads
//! and SIGNS with these keys) and the `cogno-chain-node` `gen-chainspec` subcommand (which READS the
//! operator PUBLIC keys to seat an operator-keyed genesis) use this one definition — so the on-disk key
//! format is a single source of truth that cannot drift between writer and reader.
//!
//! On-disk format is a flat, self-describing JSON envelope:
//! `{ type, description, scheme: sr25519|ed25519, ss58 (advisory), secretHex (32-byte raw seed) }`.
//! The load path keys off `scheme` (authoritative), builds an `sp_core` `Pair` from the 32-byte seed,
//! and recomputes the public key — the stored `ss58` is advisory only (warned on, never trusted).
//!
//! Dev-key refusal is by **public-key identity** (a renamed dev-key file can't dodge a regex), against
//! the well-known `//Alice..//Ferdie` (+ `//*/stash`) pubkeys, pinned below and re-derived in a test.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sp_core::{crypto::Ss58Codec, ed25519, sr25519, Pair as _};
use sp_runtime::{traits::IdentifyAccount, AccountId32, MultiSignature, MultiSigner};

/// The SS58 address format for cogno-chain accounts (`SS58Prefix = 42`, the generic Substrate prefix —
/// runtime/src/configs/mod.rs). Pinned so the CLI's printed/checked addresses match the chain.
pub const SS58_PREFIX: u16 = 42;

/// The signing scheme. sr25519 for accounts / committee / Aura; ed25519 for GRANDPA (session keys).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    /// schnorrkel/sr25519 — accounts, committee seats, Aura session key.
    Sr25519,
    /// ed25519 — the GRANDPA session key.
    Ed25519,
}

impl Scheme {
    fn parse(s: &str) -> anyhow::Result<Self> {
        match s {
            "sr25519" => Ok(Scheme::Sr25519),
            "ed25519" => Ok(Scheme::Ed25519),
            other => anyhow::bail!("unknown scheme {other:?} (expected sr25519|ed25519)"),
        }
    }
    /// The wire string used in the envelope `scheme` field.
    pub fn as_str(self) -> &'static str {
        match self {
            Scheme::Sr25519 => "sr25519",
            Scheme::Ed25519 => "ed25519",
        }
    }
}

/// The on-disk key envelope (cardano-cli `type`/`cborHex` analogue; we use `secretHex` because the
/// bytes are a raw 32-byte seed, not CBOR). `ss58` is advisory — recomputed on load.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEnvelope {
    /// `CognoSigningKey_sr25519` / `CognoSigningKey_ed25519` (informational).
    #[serde(rename = "type")]
    pub kind: String,
    /// Free-text label.
    #[serde(default)]
    pub description: String,
    /// `sr25519` | `ed25519` — the authoritative load discriminator.
    pub scheme: String,
    /// The derived SS58 address (prefix 42) — advisory; recomputed + warned-on at load.
    #[serde(default)]
    pub ss58: String,
    /// The 32-byte raw secret seed, lowercase hex (64 chars), no `0x`.
    #[serde(rename = "secretHex")]
    pub secret_hex: String,
}

/// A loaded signer: an `sp_core` keypair plus its scheme. Holds secret material — never logged.
// The two keypair variants differ in size (schnorrkel vs ed25519); this is a single in-memory key
// holder in a one-shot CLI, not a hot collection — boxing would only add indirection.
#[allow(clippy::large_enum_variant)]
pub enum Signer {
    /// An sr25519 keypair.
    Sr(sr25519::Pair),
    /// An ed25519 keypair.
    Ed(ed25519::Pair),
}

impl Signer {
    /// The scheme of this signer.
    pub fn scheme(&self) -> Scheme {
        match self {
            Signer::Sr(_) => Scheme::Sr25519,
            Signer::Ed(_) => Scheme::Ed25519,
        }
    }

    /// The 32-byte raw public key.
    pub fn public_bytes(&self) -> [u8; 32] {
        match self {
            Signer::Sr(p) => p.public().0,
            Signer::Ed(p) => p.public().0,
        }
    }

    /// The sr25519 public key (e.g. the Aura session key / an account), or an error if this signer is
    /// not sr25519.
    pub fn require_sr25519_public(&self) -> anyhow::Result<sr25519::Public> {
        match self {
            Signer::Sr(p) => Ok(p.public()),
            Signer::Ed(_) => anyhow::bail!("expected an sr25519 key, got ed25519"),
        }
    }

    /// The ed25519 public key (the GRANDPA session key), or an error if this signer is not ed25519.
    pub fn require_ed25519_public(&self) -> anyhow::Result<ed25519::Public> {
        match self {
            Signer::Ed(p) => Ok(p.public()),
            Signer::Sr(_) => anyhow::bail!("expected an ed25519 key, got sr25519"),
        }
    }

    /// The on-chain `AccountId32`, derived exactly as the runtime does (`MultiSigner::into_account`),
    /// so it cannot drift from the chain's account derivation.
    pub fn account_id(&self) -> AccountId32 {
        match self {
            Signer::Sr(p) => MultiSigner::Sr25519(p.public()).into_account(),
            Signer::Ed(p) => MultiSigner::Ed25519(p.public()).into_account(),
        }
    }

    /// The SS58 (prefix 42) string of this signer's account.
    pub fn ss58(&self) -> String {
        self.account_id()
            .to_ss58check_with_version(SS58_PREFIX.into())
    }

    /// Sign a message, wrapping into the runtime's `MultiSignature`. `msg` is the bytes to sign (the
    /// caller has already applied the >256-byte blake2 rule where relevant).
    pub fn sign(&self, msg: &[u8]) -> MultiSignature {
        match self {
            Signer::Sr(p) => MultiSignature::Sr25519(p.sign(msg)),
            Signer::Ed(p) => MultiSignature::Ed25519(p.sign(msg)),
        }
    }

    /// Sign a message and return the RAW 64-byte signature (no `MultiSignature` wrapper). Used to build
    /// the session-key proof-of-possession (`set-keys`), where the proof is the SCALE tuple of the
    /// fixed-size per-key signatures.
    pub fn sign_raw(&self, msg: &[u8]) -> Vec<u8> {
        match self {
            Signer::Sr(p) => p.sign(msg).0.to_vec(),
            Signer::Ed(p) => p.sign(msg).0.to_vec(),
        }
    }
}

/// Build a `Signer` from a secret seed + scheme. (Shared by load + key-gen.) `key gen` always writes a
/// 32-byte mini-secret; on load we also accept a 64-byte sr25519 expanded secret (the form a hard
/// `//derivation` produces — `sr25519::Pair::from_seed_slice` natively takes both lengths). ed25519
/// accepts only its 32-byte seed. The pubkey is recomputed regardless, so the dev-key denylist still
/// catches a dev key in either form.
fn signer_from_seed(scheme: Scheme, seed: &[u8]) -> anyhow::Result<Signer> {
    Ok(match scheme {
        Scheme::Sr25519 => {
            anyhow::ensure!(
				seed.len() == 32 || seed.len() == 64,
				"sr25519 secretHex must be a 32-byte mini-secret or a 64-byte expanded secret, got {} bytes",
				seed.len()
			);
            Signer::Sr(
                sr25519::Pair::from_seed_slice(seed)
                    .map_err(|e| anyhow::anyhow!("invalid sr25519 seed: {e:?}"))?,
            )
        }
        Scheme::Ed25519 => {
            anyhow::ensure!(
                seed.len() == 32,
                "ed25519 secretHex must be a 32-byte seed, got {} bytes",
                seed.len()
            );
            Signer::Ed(
                ed25519::Pair::from_seed_slice(seed)
                    .map_err(|e| anyhow::anyhow!("invalid ed25519 seed: {e:?}"))?,
            )
        }
    })
}

/// Read + JSON-parse a key-file PATH into its envelope. Shared by [`load_signer`] and
/// [`load_secret_suri`] so the file/JSON layer (and its two error messages) has ONE definition.
fn read_envelope(path: &Path) -> anyhow::Result<KeyEnvelope> {
    let bytes = std::fs::read(path)
        .map_err(|e| anyhow::anyhow!("cannot read key file {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| anyhow::anyhow!("malformed key envelope {}: {e}", path.display()))
}

/// Load a signer from a key-file PATH. There is no seed-phrase / URI path here by construction: the
/// only secret input is `secretHex`, validated as exactly 32 bytes of hex (a `//Alice` string fails
/// hex-decode and is rejected). Warns (never fails) if the advisory `ss58` disagrees with the recomputed
/// address.
pub fn load_signer(path: &Path) -> anyhow::Result<Signer> {
    let env = read_envelope(path)?;
    let scheme = Scheme::parse(&env.scheme)?;
    let hexstr = env.secret_hex.strip_prefix("0x").unwrap_or(&env.secret_hex);
    let seed = hex::decode(hexstr)
        .map_err(|e| anyhow::anyhow!("secretHex in {} is not valid hex: {e}", path.display()))?;
    let signer = signer_from_seed(scheme, &seed)?;

    // Advisory ss58 cross-check (warn-only — the recomputed public is authoritative).
    if !env.ss58.is_empty() && env.ss58 != signer.ss58() {
        eprintln!(
            "warning: key file {} ss58 field {} != recomputed {} (using the recomputed key)",
            path.display(),
            env.ss58,
            signer.ss58()
        );
    }
    Ok(signer)
}

/// Extract the node-keystore SURI (`0x`-prefixed secret hex) + scheme from an already-parsed envelope,
/// validating the secret exactly as [`load_signer`] does (hex decode + seed length/validity). Shared by
/// [`load_secret_suri`]; split out so it is testable without file IO.
fn secret_suri_from_envelope(env: &KeyEnvelope) -> anyhow::Result<(Scheme, String)> {
    let scheme = Scheme::parse(&env.scheme)?;
    let hexstr = env.secret_hex.strip_prefix("0x").unwrap_or(&env.secret_hex);
    let seed =
        hex::decode(hexstr).map_err(|e| anyhow::anyhow!("secretHex is not valid hex: {e}"))?;
    // Validate the seed builds a real keypair for this scheme (the same check load_signer runs), so a
    // malformed file fails HERE rather than at first block authoring.
    let _ = signer_from_seed(scheme, &seed)?;
    // The node keystore SURI is inserted via sp_core's `Pair::from_string` (the `0x`-hex raw-seed path),
    // which requires EXACTLY the scheme's 32-byte seed. `signer_from_seed` additionally accepts a 64-byte
    // expanded sr25519 secret, but that form can't round-trip as a SURI — reject it HERE with a clear
    // message rather than letting the node's `key insert-file` fail cryptically with `InvalidSeed` later.
    anyhow::ensure!(
		seed.len() == 32,
		"secretHex is a {}-byte secret, but `key insert-file` needs a 32-byte seed (regenerate with \
		 `cogno-chain-cli key gen`, which always writes a 32-byte seed)",
		seed.len()
	);
    Ok((scheme, format!("0x{}", hexstr.to_lowercase())))
}

/// Read a key-file PATH and return the node-keystore SURI (`0x`-prefixed secret hex) + its scheme, WITHOUT
/// constructing a `Signer` for the caller. This is what `cogno-chain-node key insert-file` needs to insert
/// a session secret into the keystore BY FILE PATH — mirroring the CLI's by-file signing, so an operator
/// never extracts the secret by hand. The secret stays inside this one audited crate (the node re-derives
/// the public key from the SURI, exactly as the SDK's `key insert` does).
pub fn load_secret_suri(path: &Path) -> anyhow::Result<(Scheme, String)> {
    let env = read_envelope(path)?;
    secret_suri_from_envelope(&env).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
}

/// Generate a fresh random key (from the OS CSPRNG via `Pair::generate`) and return the signer plus its
/// envelope. The seed is 32 random bytes; there is no import-from-phrase mode anywhere.
pub fn generate(scheme: Scheme, description: &str) -> anyhow::Result<(Signer, KeyEnvelope)> {
    let seed: [u8; 32] = match scheme {
        Scheme::Sr25519 => sr25519::Pair::generate().1,
        Scheme::Ed25519 => ed25519::Pair::generate().1,
    };
    let signer = signer_from_seed(scheme, &seed)?;
    let env = KeyEnvelope {
        kind: format!("CognoSigningKey_{}", scheme.as_str()),
        description: description.to_string(),
        scheme: scheme.as_str().to_string(),
        ss58: signer.ss58(),
        secret_hex: hex::encode(seed),
    };
    Ok((signer, env))
}

/// Write a key envelope to `path` as pretty JSON, with restrictive permissions (0600 on unix) — the
/// file holds a raw secret seed. On unix the file is created restricted-FROM-BIRTH (`O_CREAT|O_EXCL`
/// with mode 0600) so there is NO window in which the raw secret is readable at the default umask
/// (typically 0644) before a later chmod; `O_EXCL` also makes the "refuse to overwrite" check atomic
/// (no TOCTOU on a separate `path.exists()`).
pub fn write_envelope(path: &Path, env: &KeyEnvelope) -> anyhow::Result<()> {
    let json = serde_json::to_string_pretty(env)?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true) // O_CREAT | O_EXCL — fails (AlreadyExists) if the file is already there
            .mode(0o600) // masked by umask, but 0600 has no group/other bits to strip
            .open(path)
            .map_err(|e| {
                anyhow::anyhow!(
                    "cannot create key file {} (already exists? move it aside first): {e}",
                    path.display()
                )
            })?;
        f.write_all(json.as_bytes())
            .map_err(|e| anyhow::anyhow!("cannot write key file {}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        anyhow::ensure!(
            !path.exists(),
            "refusing to overwrite existing key file {} (move it aside first)",
            path.display()
        );
        std::fs::write(path, json.as_bytes())
            .map_err(|e| anyhow::anyhow!("cannot write key file {}: {e}", path.display()))?;
    }
    Ok(())
}

/// The well-known sr25519 dev pubkeys (`//Alice..//Ferdie` + their `//*/stash`), pinned at sp-core
/// 40.0.0. Refused for account/committee/Aura keys under `--prod`. Re-derived in [`tests`].
const DEV_SR25519: &[[u8; 32]] = &[
    hex_lit("d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"), // //Alice
    hex_lit("8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48"), // //Bob
    hex_lit("90b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe22"), // //Charlie
    hex_lit("306721211d5404bd9da88e0204360a1a9ab8b87c66c1bc2fcdd37f3c2222cc20"), // //Dave
    hex_lit("e659a7a1628cdd93febc04a4e0646ea20e9f5f0ce097d9a05290d4a9e054df4e"), // //Eve
    hex_lit("1cbd2d43530a44705ad088af313e18f80b53ef16b36177cd4b77b846f2a5f07c"), // //Ferdie
    hex_lit("be5ddb1579b72e84524fc29e78609e3caf42e85aa118ebfe0b0ad404b5bdd25f"), // //Alice//stash
    hex_lit("fe65717dad0447d715f660a0a58411de509b42e6efb8375f562f58a554d5860e"), // //Bob//stash
    hex_lit("1e07379407fecc4b89eb7dbd287c2c781cfb1907a96947a3eb18e4f8e7198625"), // //Charlie//stash
    hex_lit("e860f1b1c7227f7c22602f53f15af80747814dffd839719731ee3bba6edc126c"), // //Dave//stash
    hex_lit("8ac59e11963af19174d0b94d5d78041c233f55d2e19324665bafdfb62925af2d"), // //Eve//stash
    hex_lit("101191192fc877c24d725b337120fa3edc63d227bbc92705db1e2cb65f56981a"), // //Ferdie//stash
];

/// The well-known ed25519 dev pubkeys (`//Alice..//Ferdie`), pinned at sp-core 40.0.0. Refused for
/// GRANDPA keys under `--prod`.
const DEV_ED25519: &[[u8; 32]] = &[
    hex_lit("88dc3417d5058ec4b4503e0c12ea1a0a89be200fe98922423d4334014fa6b0ee"), // //Alice
    hex_lit("d17c2d7823ebf260fd138f2d7e27d114c0145d968b5ff5006125f2414fadae69"), // //Bob
    hex_lit("439660b36c6c03afafca027b910b4fecf99801834c62a5e6006f27d978de234f"), // //Charlie
    hex_lit("5e639b43e0052c47447dac87d6fd2b6ec50bdd4d0f614e4299c665249bbd09d9"), // //Dave
    hex_lit("1dfe3e22cc0d45c70779c1095f7489a8ef3cf52d62fbd8c2fa38c9f1723502b5"), // //Eve
    hex_lit("568cb4a574c6d178feb39c27dfc8b3f789e5f5423e19c71633c748b9acf086b5"), // //Ferdie
];

/// `const` hex → `[u8; 32]` (compile-time; panics on a malformed literal — a typo fails the build).
const fn hex_lit(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    assert!(b.len() == 64, "dev-key hex literal must be 64 chars");
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (hex_nyb(b[2 * i]) << 4) | hex_nyb(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn hex_nyb(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("non-hex char in dev-key literal"),
    }
}

/// Fail-closed dev-key guard: under `--prod`, refuse to sign with a well-known dev key (`//Alice..`),
/// matched by **public-key identity** for the loaded scheme. No-op when `prod` is false (so `cogno-dev`
/// / `local` still drive with `//Alice`). Keyed on pubkey, not on a seed-string regex (there are no seed
/// strings here).
pub fn assert_not_dev_key(signer: &Signer, prod: bool) -> anyhow::Result<()> {
    if !prod {
        return Ok(());
    }
    let pubkey = signer.public_bytes();
    let banned = match signer.scheme() {
        Scheme::Sr25519 => DEV_SR25519,
        Scheme::Ed25519 => DEV_ED25519,
    };
    anyhow::ensure!(
        !banned.contains(&pubkey),
        "--prod: refusing to sign with a well-known dev key (//Alice..//Ferdie). \
		 Generate a real key with `cogno-chain-cli key gen` and pass it by file path \
		 (e.g. --committee-signing-key-file)."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Re-derive the dev-key denylist from `//Alice..//Ferdie` via sp-keyring and assert it matches the
    /// hardcoded constants — so a future sp-core derivation change fails CI rather than silently
    /// weakening the prod refusal. (Belt-and-suspenders.)
    #[test]
    fn dev_key_denylist_matches_sp_keyring() {
        use sp_keyring::{Ed25519Keyring as E, Sr25519Keyring as S};
        let sr = [
            S::Alice,
            S::Bob,
            S::Charlie,
            S::Dave,
            S::Eve,
            S::Ferdie,
            S::AliceStash,
            S::BobStash,
            S::CharlieStash,
            S::DaveStash,
            S::EveStash,
            S::FerdieStash,
        ];
        assert_eq!(sr.len(), DEV_SR25519.len());
        for (k, want) in sr.iter().zip(DEV_SR25519) {
            assert_eq!(&k.public().0, want, "sr25519 denylist mismatch for {k:?}");
        }
        let ed = [E::Alice, E::Bob, E::Charlie, E::Dave, E::Eve, E::Ferdie];
        assert_eq!(ed.len(), DEV_ED25519.len());
        for (k, want) in ed.iter().zip(DEV_ED25519) {
            assert_eq!(&k.public().0, want, "ed25519 denylist mismatch for {k:?}");
        }
    }

    /// gen → envelope → load round-trips to the same account, and the advisory ss58 is correct.
    #[test]
    fn keygen_roundtrip_sr25519() {
        let (signer, env) = generate(Scheme::Sr25519, "test").unwrap();
        let acct = signer.account_id();
        assert_eq!(env.scheme, "sr25519");
        assert_eq!(env.ss58, signer.ss58());
        // Reload from the envelope bytes (no file IO) and assert identity.
        let seed = hex::decode(&env.secret_hex).unwrap();
        let reloaded = signer_from_seed(Scheme::Sr25519, &seed).unwrap();
        assert_eq!(reloaded.account_id(), acct);
        assert_eq!(reloaded.public_bytes(), signer.public_bytes());
    }

    /// `secret_suri_from_envelope` returns a `0x`-prefixed SURI that rebuilds the same account, for both
    /// schemes — the by-file secret path the node's `key insert-file` relies on.
    #[test]
    fn secret_suri_roundtrips_both_schemes() {
        for scheme in [Scheme::Sr25519, Scheme::Ed25519] {
            let (signer, env) = generate(scheme, "t").unwrap();
            let (got_scheme, suri) = secret_suri_from_envelope(&env).unwrap();
            assert_eq!(got_scheme, scheme);
            assert!(suri.starts_with("0x"), "suri must be 0x-prefixed: {suri}");
            let seed = hex::decode(suri.strip_prefix("0x").unwrap()).unwrap();
            let reloaded = signer_from_seed(scheme, &seed).unwrap();
            assert_eq!(
                reloaded.account_id(),
                signer.account_id(),
                "suri must rebuild the same account"
            );
        }
    }

    /// A malformed secretHex is rejected by the suri extractor (not silently written to the keystore).
    #[test]
    fn secret_suri_rejects_bad_hex() {
        let env = KeyEnvelope {
            kind: "CognoSigningKey_sr25519".into(),
            description: String::new(),
            scheme: "sr25519".into(),
            ss58: String::new(),
            secret_hex: "nothex".into(),
        };
        assert!(secret_suri_from_envelope(&env).is_err());
    }

    /// A 64-byte EXPANDED sr25519 secret loads fine in the CLI signer path (`signer_from_seed` accepts
    /// 32 OR 64 bytes) but CANNOT be inserted as a node keystore SURI (`Pair::from_string` needs exactly
    /// 32 bytes) — `secret_suri_from_envelope` must reject it explicitly, not defer to a cryptic later
    /// failure.
    #[test]
    fn secret_suri_rejects_64_byte_sr25519() {
        // A real 64-byte expanded sr25519 secret (the form from_seed_slice accepts but from_string can't).
        let expanded = sr25519::Pair::generate().0.to_raw_vec();
        assert_eq!(expanded.len(), 64, "sr25519 expanded secret is 64 bytes");
        // signer_from_seed accepts the 64-byte form (the CLI signer would load it fine)...
        assert!(signer_from_seed(Scheme::Sr25519, &expanded).is_ok());
        // ...but the keystore-SURI extractor refuses it (needs exactly a 32-byte seed).
        let env = KeyEnvelope {
            kind: "CognoSigningKey_sr25519".into(),
            description: String::new(),
            scheme: "sr25519".into(),
            ss58: String::new(),
            secret_hex: format!("0x{}", hex::encode(&expanded)),
        };
        assert!(secret_suri_from_envelope(&env).is_err());
    }

    /// A `//Alice`-derived sr25519 key is refused under prod, allowed otherwise; a fresh key is allowed.
    #[test]
    fn prod_refuses_dev_key() {
        use sp_keyring::Sr25519Keyring;
        let alice = Signer::Sr(Sr25519Keyring::Alice.pair());
        assert!(
            assert_not_dev_key(&alice, true).is_err(),
            "prod must refuse //Alice"
        );
        assert!(
            assert_not_dev_key(&alice, false).is_ok(),
            "non-prod allows dev key"
        );
        let (fresh, _) = generate(Scheme::Sr25519, "real").unwrap();
        assert!(
            assert_not_dev_key(&fresh, true).is_ok(),
            "prod allows a fresh key"
        );
    }
}
