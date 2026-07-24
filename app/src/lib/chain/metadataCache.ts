// Persist the chain's SCALE metadata across page loads, keyed by its runtime code hash.
//
// WHAT IT SAVES. PAPI cannot decode anything until it has the runtime metadata, so every cold load
// fetched all ~134 KB of it over the WebSocket, as hex (so ~268 KB on the wire — and nginx's gzip does
// not apply to WS frames), strictly serially, in front of the first typed read. It is by a wide margin
// the largest thing on the reload critical path: roughly 65× an entire enriched feed page, paid before
// a single post can be requested. `createClient(provider, { getMetadata, setMetadata })` lets a cached
// copy skip that fetch outright.
//
// WHY THIS IS SAFE TO PERSIST — and why it is a different question from caching posts. It is the
// chain's own schema: byte-identical for every visitor, containing nothing about anyone, revealing
// nothing if read. And it is CONTENT-ADDRESSED — the key is the runtime's code hash, which PAPI
// derives from the live chain, so a runtime upgrade simply misses and re-fetches. Serving the wrong
// metadata for a runtime is not a risk that exists here.
//
// WHY IndexedDB AND NOT localStorage. localStorage stores UTF-16 strings, so this would have to be
// base64 (~178 KB → ~358 KB of characters) out of a bucket that also holds the user's bookmarks, block
// list, mutes and hidden posts — and every one of those stores swallows QuotaExceeded SILENTLY
// (lib/persistentStore.ts). Overflowing the bucket would therefore not degrade this cache, it would
// quietly stop the user's block list from saving, which is a moderation-correctness failure. IndexedDB
// has its own quota pool and stores the raw Uint8Array at 134 KB. (/privacy's "No database" line is
// explicitly about a server — "There is no server of ours for your data to sit on" — and this is the
// chain's public schema, not the user's data.)
//
// Exactly ONE entry is kept: a write purges every other key, so an upgraded runtime replaces the old
// metadata instead of accumulating copies of it.

const DB_NAME = "cogno-chain";
const DB_VERSION = 1;
const STORE = "metadata";

/** Give up rather than delay the socket: a blocked/absent IndexedDB must not slow the boot path. */
const OPEN_TIMEOUT_MS = 2_000;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (db: IDBDatabase | null) => {
      if (settled) {
        // The open timed out and then succeeded anyway. Nobody holds this handle, so close it: an
        // abandoned open connection keeps the database pinned and makes the NEXT version's
        // `onupgradeneeded` fire `onblocked` instead — a leak that turns one slow open into a
        // permanently unusable cache.
        try {
          db?.close();
        } catch {
          /* already closing */
        }
        return;
      }
      settled = true;
      resolve(db);
    };
    // Private-mode Firefox, a blocked upgrade behind another tab, a corrupt profile — every one of them
    // can leave the open request hanging. Time-box it; a miss just means we fetch from the chain.
    const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        done(req.result);
      };
      req.onerror = req.onblocked = () => {
        clearTimeout(timer);
        done(null);
      };
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

/**
 * The cached metadata for `codeHash`, or null.
 *
 * Never throws and never rejects: every failure path — no IndexedDB, a blocked open, a corrupt
 * record — resolves null, and PAPI falls back to fetching from the chain exactly as it does today.
 */
export async function getCachedMetadata(codeHash: string): Promise<Uint8Array | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(codeHash);
      req.onsuccess = () => {
        const v: unknown = req.result;
        resolve(v instanceof Uint8Array ? v : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      // Safe to close here: IndexedDB defers the actual close until the in-flight transaction settles.
      try {
        db.close();
      } catch {
        /* already closing */
      }
    }
  });
}

/** Store `raw` under `codeHash` and drop every other entry (we keep exactly one runtime's metadata). */
export async function setCachedMetadata(codeHash: string, raw: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      // Purge first, then write: a runtime upgrade must REPLACE the old blob, not sit beside it.
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const k of keys.result) {
          if (k !== codeHash) store.delete(k);
        }
        store.put(raw, codeHash);
      };
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch {
      resolve();
    } finally {
      try {
        db.close();
      } catch {
        /* already closing */
      }
    }
  });
}
