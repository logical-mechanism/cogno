// Shared, dependency-free resolution of the cogno-chain DURABLE DATA DIRECTORY + the stateful files
// the long-running services persist there. Uses only Node v22 builtins so it imports cleanly from any
// service regardless of its node_modules (mirrors net.mjs / cli.mjs).
//
// WHY THIS EXISTS (prod-readiness Phase 1): the relayer's anchor cursor (its entire double-spend
// defense), the relayer's FUNDED Cardano wallet, and the committee's vault descriptor all historically
// defaulted to /tmp/cogno-m2 — VOLATILE (a reboot / tmpfs clear destroys the cursor AND the signing
// key, after which the relayer silently re-mints paid txs or rotates to a fresh empty wallet) and
// WORLD-READABLE (a plaintext seed in a shared dir). These now default to a durable, user-private dir,
// written 0600, with a one-time migration off the legacy /tmp path so an existing funded preprod
// wallet is preserved rather than orphaned.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where the stateful files USED to live (pre-Phase-1). Migrated off, never written to.
export const LEGACY_DIR = "/tmp/cogno-m2";

// PURE (given `env` + `home`): the durable data dir, resolved in priority order —
//   1. COGNO_DATA_DIR    — explicit operator override (systemd EnvironmentFile / shell export).
//   2. STATE_DIRECTORY   — exported by systemd `StateDirectory=cogno` (= /var/lib/cogno); may be a
//                          colon-separated list, so take the first entry.
//   3. $XDG_STATE_HOME/cogno or ~/.local/state/cogno — a durable, user-private default for a by-hand
//                          run. NEVER /tmp.
export function resolveDataDir(env = process.env, home = os.homedir()) {
	if (env.COGNO_DATA_DIR) return env.COGNO_DATA_DIR;
	if (env.STATE_DIRECTORY) return env.STATE_DIRECTORY.split(":")[0];
	const base = env.XDG_STATE_HOME || path.join(home, ".local", "state");
	return path.join(base, "cogno");
}

export const dataDir = () => resolveDataDir();

// Create the data dir (0700 — these files include a plaintext wallet seed) and return its path.
export function ensureDataDir() {
	const dir = dataDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export const dataPath = (name) => path.join(dataDir(), name);

// Create the PARENT directory of `file` (0700) and return `file`. Use this before writing a stateful
// file whose path may be an explicit override OUTSIDE the data dir — ensureDataDir() would create the
// default dir, not dirname(file), so an explicit OWNER_FILE/STATE_FILE in a not-yet-existing dir would
// otherwise fail the write with ENOENT.
export function ensureParentDir(file) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	return file;
}

// PURE (given `env` + `home`): resolve a stateful file. An explicit `envVar` override wins (and then
// there is no legacy fallback — the operator named the path); otherwise the durable default applies and
// `legacy` points at the old /tmp location to migrate from. Returns { file, legacy }.
export function statePaths(envVar, name, env = process.env, home = os.homedir()) {
	const explicit = env[envVar];
	const file = explicit || path.join(resolveDataDir(env, home), name);
	const legacy = explicit ? null : path.join(LEGACY_DIR, name);
	return { file, legacy };
}

// One-time migration: if `file` is absent but a `legacy` /tmp copy exists, COPY it to the durable
// location (0600) so an existing funded wallet / anchor cursor moves off volatile /tmp instead of being
// silently re-created. Returns true iff it migrated. The legacy copy is left in place (a plaintext
// seed); the caller logs a reminder to delete it. No-op (false) when file already exists / no legacy.
export function migrateFromLegacy(file, legacy) {
	if (!legacy || fs.existsSync(file) || !fs.existsSync(legacy)) return false;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.copyFileSync(legacy, file);
	try { fs.chmodSync(file, 0o600); } catch { /* best-effort on platforms without chmod */ }
	return true;
}

// migrateFromLegacy + a STANDARD operator warning in one call — the single blessed migrate idiom every
// stateful reader should use, so a new/forgotten call site can't silently orphan a funded wallet /
// anchor cursor / vault on volatile /tmp. `label` names the file in the warning. Returns true iff it
// migrated. Logs via console.warn (best-effort observability is fine here); callers need not re-log.
export function migrateStatePath(file, legacy, label = "state file") {
	if (!migrateFromLegacy(file, legacy)) return false;
	console.warn(`  ⚠ migrated ${label} ${legacy} → ${file} (off volatile /tmp, 0600). Remove the plaintext legacy copy: rm ${legacy}`);
	return true;
}

// Atomically persist `data` to `file` with restrictive perms (0600 default): write to a temp sibling,
// fsync the file, then rename (atomic within one filesystem), then best-effort fsync the directory so
// the rename itself is durable. A crash mid-write can therefore never leave a half-written file that the
// next load silently discards (the relayer's loadState() treats a corrupt state as "no history" and
// would re-mint paid Cardano txs). Throws on failure — the caller must treat a failed persist as fatal.
export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
	const fd = fs.openSync(tmp, "w", mode);
	try {
		fs.writeFileSync(fd, data);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try { fs.chmodSync(tmp, mode); } catch { /* umask may have widened it; best-effort tighten */ }
	fs.renameSync(tmp, file);
	try { const dfd = fs.openSync(dir, "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } }
	catch { /* dir fsync is unsupported on some platforms — the file fsync+rename above still holds */ }
}

// `process.kill(pid, 0)` sends no signal but probes existence: it throws ESRCH if no such process, and
// EPERM if the process exists but we may not signal it (⇒ still alive). Anything else ⇒ treat as dead.
function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (e) { return e?.code === "EPERM"; }
}

// Acquire an exclusive SINGLE-INSTANCE lock for `name` (a pidfile in the data dir). Two relayer
// processes sharing one wallet + state file would corrupt state (last-writer-wins) and double-spend the
// funded wallet, so refuse to start a second live instance. A STALE lock (recorded pid is dead, e.g.
// after a SIGKILL) is reclaimed automatically. Returns { lockFile, release }; release is also wired to
// run on process exit so a clean shutdown frees the lock.
export function acquireSingleInstanceLock(name) {
	const dir = ensureDataDir();
	const lockFile = path.join(dir, `${name}.lock`);
	const tmp = path.join(dir, `.${name}.lock.${process.pid}.tmp`);
	// Write our pid to a temp file, then hard-LINK it onto the lockfile. linkSync is atomic and fails
	// EEXIST if the lockfile already exists, and because the linked file ALREADY contains our pid there
	// is no "empty file" window for a racing process to misread — this is the exclusive-create primitive
	// (more robust than openSync(wx)+writeSync, which is briefly empty between create and write).
	fs.writeFileSync(tmp, String(process.pid), { mode: 0o600 });
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				fs.linkSync(tmp, lockFile);
				let released = false;
				const release = () => { if (released) return; released = true; try { fs.unlinkSync(lockFile); } catch { /* already gone */ } };
				process.once("exit", release);
				return { lockFile, release };
			} catch (e) {
				if (e?.code !== "EEXIST") throw e;
				let holder = NaN;
				try { holder = Number(fs.readFileSync(lockFile, "utf8").trim()); } catch { /* unreadable ⇒ treat as stale */ }
				if (isPidAlive(holder))
					throw new Error(`another '${name}' instance (pid ${holder}) holds ${lockFile} — refusing to start a second one against the same wallet/state (would corrupt state and double-spend the wallet). Stop it first, or point COGNO_DATA_DIR at a separate directory.`);
				// Stale (dead/unreadable holder). Reclaim it ATOMICALLY by renaming the stale lockfile
				// aside: rename is atomic, so when two processes race the reclaim only ONE succeeds; the
				// loser gets ENOENT, loops, and then contends on the winner's fresh (live) lock and throws.
				// We never delete a lock another process freshly acquired (closes the TOCTOU in the old
				// unconditional unlink + re-create path).
				const aside = `${lockFile}.stale.${process.pid}.${attempt}`;
				try {
					fs.renameSync(lockFile, aside);
					try { fs.unlinkSync(aside); } catch { /* best-effort cleanup of the stolen stale file */ }
					console.warn(`  ⚠ reclaimed stale ${name} lock (pid ${Number.isNaN(holder) ? "?" : holder} not alive): ${lockFile}`);
				} catch (re) {
					if (re?.code !== "ENOENT") throw re; // lost the steal race — loop and contend on the fresh lock
				}
			}
		}
		throw new Error(`could not acquire the '${name}' single-instance lock after reclaiming a stale one (${lockFile})`);
	} finally {
		try { fs.unlinkSync(tmp); } catch { /* tmp already linked away / removed */ }
	}
}
