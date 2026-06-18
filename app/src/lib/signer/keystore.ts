// The hardened at-rest keystore for the sr25519 posting mnemonic (L5-M2, the "Model-B" key) —
// the durable successor to the M1 memory-only session key. PBKDF2(password) → AES-GCM-256; only
// the ciphertext + salt + iv ever touch localStorage. The mnemonic and the derived key never do,
// and unlocking requires the password each session.
//
// THREAT MODEL (stated honestly, matching the project's "usable ≠ trustless" posture):
//   • Protects the key AT REST — a stolen localStorage dump is useless without the password.
//   • Does NOT defend against XSS on this origin: any script that runs here can read the key once
//     you have unlocked it this session. A browser keystore cannot beat that. Treat this as a
//     convenience posting key, not cold storage.
//
// All crypto is the platform WebCrypto SubtleCrypto — no dependencies, no key material in JS land
// longer than a decrypt call.

const STORAGE_KEY = "cogno.signer.keystore";
const PBKDF2_ITERATIONS = 310_000; // OWASP 2023 floor for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface KeystoreBlob {
  v: 1;
  kdf: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64 — AES-GCM of the UTF-8 mnemonic
  label?: string;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a mnemonic under a password into a self-describing blob (no plaintext retained). */
export async function encryptMnemonic(mnemonic: string, password: string, label?: string): Promise<KeystoreBlob> {
  if (!password) throw new Error("a password is required to encrypt the key");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(mnemonic)),
  );
  return {
    v: 1,
    kdf: "PBKDF2",
    hash: "SHA-256",
    iterations: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(ct),
    label,
  };
}

/** Decrypt a blob back to the mnemonic, or throw a clear error on a wrong password / corruption. */
export async function decryptMnemonic(blob: KeystoreBlob, password: string): Promise<string> {
  const key = await deriveKey(password, fromB64(blob.salt), blob.iterations);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(blob.iv) }, key, fromB64(blob.ciphertext));
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("wrong password (or the keystore is corrupt)");
  }
}

// ── localStorage persistence (SSG-safe: guarded, never throws on read) ──────────────────────

export function loadKeystore(): KeystoreBlob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw) as KeystoreBlob;
    if (blob?.v === 1 && blob.ciphertext && blob.salt && blob.iv) return blob;
    return null;
  } catch {
    return null;
  }
}

export function hasKeystore(): boolean {
  return loadKeystore() !== null;
}

export function saveKeystore(blob: KeystoreBlob): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
}

export function clearKeystore(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* non-critical */
  }
}
