/**
 * dsh-resource-lease -- lock primitives.
 *
 * This is the ONLY module that touches the lock directory. Its on-disk format
 * is deliberately byte-compatible with the zero-dependency CLI
 * (`cli/lease.ps1`), so an agent driving the CLI and an agent using this
 * plugin exclude each other.
 *
 * ATOMICITY (the one thing that is easy to get wrong):
 *   A lease is a FILE created with fs.openSync(path, 'wx'), which maps to
 *   open(O_CREAT | O_EXCL) -- the only portable primitive that decides
 *   success/failure in a single system call.
 *   Do NOT use mkdir / CreateDirectory as the lock: directory creation is
 *   idempotent, so every racer "succeeds" and mutual exclusion fails silently.
 *
 * LAYOUT (identical to the CLI):
 *   <lockRoot>/<sanitizedKey>.lock              exclusive / shared
 *   <lockRoot>/<sanitizedKey>.slot-<N>.lock     pool, one file per slot
 *   <lockRoot>/_leases/<leaseId>.json           index: { id, key, path }
 *   <lockRoot>/<name>.lock.stale.<ms>.<pid>     archived takeover (forensics)
 *
 * LOCK FILE BODY (identical to the CLI):
 *   { id, key, mode, slots, slot, owner, reason, pid, host, createdAt,
 *     expiresAt, lockPath }
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Name of the CLI's lease index directory, inside the lock root. */
export const INDEX_DIR = '_leases'

/** How long an archived `.stale.` file is kept, in ms (the CLI keeps 1h). */
const STALE_RETENTION_MS = 60 * 60 * 1000

/**
 * How old an UNREADABLE lock file must be before it counts as a crashed residue
 * and may be taken over (the CLI's $StaleTakeoverGraceMs, the MCP server's
 * TAKEOVER_GRACE_MS -- all three are 2000 ms on purpose).
 *
 * A file that a live process has just created has no parseable body for a few
 * milliseconds; calling that "expired" archives a brand-new lease and leaves TWO
 * holders of one lock -- reproduced across processes, not theoretical. A crashed
 * writer stops touching its file, so it ages past this and becomes takeable.
 */
const TAKEOVER_GRACE_MS = 2000

/**
 * Replace every character outside [A-Za-z0-9._-] with '_', then lowercase.
 * Same rule as the CLI's Get-KeyBase and the MCP server's sanitizeKey, so all
 * three implementations compute the SAME filename for one key.
 *
 * The lowercasing is part of the rule, not a nicety: without it
 * "Browser:Chromium" names `Browser_Chromium.lock` here while the CLI names
 * `browser_chromium.lock`. Windows hides that mistake (case-insensitive file
 * names); Linux and macOS do not -- two lock files, no exclusion, no error.
 *
 * @param {unknown} key raw resource key, e.g. "browser:chromium".
 * @returns {string} filesystem-safe, lowercase key base.
 */
export function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase()
}

/**
 * Resolve the lock root: DSH_RESOURCE_LOCK_ROOT, else %LOCALAPPDATA%.
 * The CLI resolves the same way, so the default already interoperates.
 *
 * @param {Record<string, string | undefined>} [env] environment to read.
 * @returns {string} absolute lock root.
 */
export function defaultLockRoot(env = process.env) {
  const fromEnv = env.DSH_RESOURCE_LOCK_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'dsh-resource-lease', 'locks')
}

/**
 * Lock file path for one resource key and slot (mirrors the CLI).
 *
 * @param {string} lockRoot lock directory.
 * @param {string} key resource key.
 * @param {string} mode 'exclusive' | 'shared' | 'pool'.
 * @param {number} slot slot index; ignored unless mode is 'pool'.
 * @returns {string} absolute lock file path.
 */
export function lockPathFor(lockRoot, key, mode, slot) {
  const base = sanitizeKey(key)
  if (mode === 'pool') return path.join(lockRoot, `${base}.slot-${slot}.lock`)
  return path.join(lockRoot, `${base}.lock`)
}

/**
 * A lease id in the CLI's shape: `lz_` + 12 lowercase hex characters.
 *
 * @returns {string} fresh lease id.
 */
export function newLeaseId() {
  return 'lz_' + randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * Create the lock root if needed.
 *
 * @param {string} lockRoot lock directory.
 */
export function ensureLockRoot(lockRoot) {
  fs.mkdirSync(lockRoot, { recursive: true })
}

/**
 * Read and parse one lock file. Unreadable or half-written files read as null,
 * and isExpired() still treats null as expired -- same as the CLI's Read-Meta.
 * tryTakeover() does NOT act on that alone: it also requires the path to be
 * older than TAKEOVER_GRACE_MS, because null is also what a live writer looks
 * like for a few milliseconds.
 *
 * @param {string} lockPath lock file path.
 * @returns {Record<string, any> | null} parsed metadata, or null.
 */
export function readMeta(lockPath) {
  try {
    const text = fs.readFileSync(lockPath, 'utf8')
    if (text.trim() === '') return null
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Whether a lease is past its TTL. Missing metadata counts as expired here,
 * but callers that ACT on that (tryTakeover) must additionally check the file's
 * age: null means "unreadable", which is exactly what a live writer looks like
 * for a few milliseconds.
 *
 * `expiresAt < now` (strict) is what the CLI and the MCP server compare too, so
 * a lease is never expired "one millisecond early" on one side only.
 *
 * @param {Record<string, any> | null} meta parsed metadata.
 * @param {number} now current epoch ms.
 * @returns {boolean} true when the lease may be taken over.
 */
export function isExpired(meta, now) {
  if (!meta) return true
  const expiresAt = Number(meta.expiresAt)
  if (!Number.isFinite(expiresAt)) return true
  return expiresAt < now
}

/**
 * Age of a lock path in ms, or -1 when nothing is there.
 *
 * statSync works for FILES AND DIRECTORIES. A directory can occupy a lock path
 * (a leftover from the mkdir-lock experiment, a manual mkdir), and treating that
 * as "gone" made the path permanently un-takeable. The MCP server's renameSync
 * archives such a directory; so does this one now.
 *
 * @param {string} lockPath lock file path.
 * @returns {number} milliseconds since the last write, or -1.
 */
export function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs
  } catch {
    return -1
  }
}

/**
 * The one and only atomic grab: create the lock file, or fail because it exists.
 *
 * fs.openSync(path, 'wx') is O_CREAT|O_EXCL|O_WRONLY, so check-and-create is a
 * single syscall with no TOCTOU window. Metadata is written through the same
 * descriptor immediately, so a concurrent reader never sees a file that was
 * created and then left empty on purpose.
 *
 * @param {string} lockPath lock file path.
 * @param {Record<string, any>} meta lease metadata to persist as JSON.
 * @returns {boolean} true when this caller created the lock.
 */
export function tryAcquire(lockPath, meta) {
  let fd
  try {
    fd = fs.openSync(lockPath, 'wx')
    fs.writeFileSync(fd, JSON.stringify(meta))
    return true
  } catch (err) {
    if (err && err.code === 'EEXIST') return false
    throw err
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* closing a descriptor that is already gone is not a lease problem */
      }
    }
  }
}

/**
 * Move a lock file aside. This rename IS the compare-and-swap: when two
 * processes race to take over the same expired lease, only the one whose
 * rename succeeds continues; the other throws because the source is gone.
 *
 * @param {string} lockPath lock file path.
 * @param {number} now current epoch ms.
 * @param {number} pid current process id.
 * @returns {boolean} true when this caller moved the file.
 */
function archiveStale(lockPath, now, pid) {
  const archived = `${lockPath}.stale.${now}.${pid}`
  try {
    fs.renameSync(lockPath, archived)
    return true
  } catch {
    return false
  }
}

/**
 * Delete archived `.stale.` files older than the retention window.
 * Best effort: a failure here must never fail an acquire.
 *
 * @param {string} lockRoot lock directory.
 * @param {number} now current epoch ms.
 */
export function purgeStale(lockRoot, now) {
  const cutoff = now - STALE_RETENTION_MS
  let names
  try {
    names = fs.readdirSync(lockRoot)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.includes('.stale.')) continue
    const full = path.join(lockRoot, name)
    try {
      // recursive: one of these archives can be a DIRECTORY that squatted on a
      // lock path. Without it the archive stays in the lock root forever.
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true })
    } catch {
      /* another process may be archiving or deleting it right now */
    }
  }
}

/**
 * Take over an EXPIRED lease via the rename CAS.
 *
 * Two rules here exist because breaking either one leaves TWO holders of one
 * lock -- the failure this module exists to make impossible (the CLI and the MCP
 * server carry the same two rules; this module was the one place missing them):
 *
 *   1. An unreadable lock file is NOT takeable on its own. A path with no
 *      parseable body is almost always a live writer between openSync('wx') and
 *      its first write. It only becomes takeable once its age passes
 *      TAKEOVER_GRACE_MS, which is a crashed residue rather than a writer in
 *      flight. A DIRECTORY on the lock path is read the same way (no body, but
 *      an mtime), so it needs the same grace and then gets archived.
 *   2. Do not trust our own read. After the rename, re-read the ARCHIVED copy: if
 *      it turns out to be a valid, unexpired lease we grabbed a live lock whose
 *      owner had just finished writing it. Put it back and report failure.
 *
 * @param {string} lockPath lock file path.
 * @param {number} now current epoch ms.
 * @param {number} pid current process id.
 * @param {(message: string) => void} [warn] sink for takeover notices; a failed
 *   restore is the one case where silently returning false would hide a real
 *   problem, so callers should pass their logger.
 * @returns {boolean} true when the expired lease was moved aside.
 */
export function tryTakeover(lockPath, now, pid, warn = () => {}) {
  const meta = readMeta(lockPath)
  if (meta !== null) {
    if (!isExpired(meta, now)) return false
  } else {
    const ageMs = lockAgeMs(lockPath)
    if (ageMs < 0 || ageMs < TAKEOVER_GRACE_MS) return false
  }
  if (!archiveStale(lockPath, now, pid)) return false

  const archived = `${lockPath}.stale.${now}.${pid}`
  const archivedMeta = readMeta(archived)
  if (archivedMeta !== null && !isExpired(archivedMeta, now)) {
    // We archived a live lease: its owner was still writing it. Undo, or two
    // agents would hold the same resource.
    let restored = false
    try {
      fs.renameSync(archived, lockPath)
      restored = true
    } catch {
      /* a third process may have created a new lock at the path already */
    }
    const name = path.basename(lockPath)
    const owner = typeof archivedMeta.owner === 'string' ? archivedMeta.owner : '?'
    warn(
      restored
        ? `takeover aborted: ${name} is a live lease (owner ${owner}); restored it intact`
        : `takeover aborted: ${name} turned out to be a live lease (owner ${owner}) but could not be restored; see ${path.basename(archived)}`,
    )
    return false
  }

  purgeStale(path.dirname(lockPath), now)
  return true
}

/**
 * Take over a lease regardless of its TTL (the `onTimeout: 'steal'` escape
 * hatch). Still uses the rename CAS, so two stealers cannot both win.
 *
 * @param {string} lockPath lock file path.
 * @param {number} now current epoch ms.
 * @param {number} pid current process id.
 * @returns {boolean} true when the lease was moved aside.
 */
export function forceTakeover(lockPath, now, pid) {
  const moved = archiveStale(lockPath, now, pid)
  if (moved) purgeStale(path.dirname(lockPath), now)
  return moved
}

/**
 * Delete one lock file by path, without checking who owns it. Missing files are
 * not an error: TTL expiry and takeover both remove the file behind a lease's
 * back.
 *
 * RAW PRIMITIVE: never call this from a lease release path. A release must use
 * removeIfOwned() instead, because the path may have been taken over by a new
 * lease in the meantime. This is only for callers that already hold the
 * authoritative metadata (or deliberately force a cleanup).
 *
 * @param {string} lockPath lock file path.
 * @returns {boolean} true when the file is gone afterwards.
 */
export function removeLock(lockPath) {
  try {
    fs.rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Delete one lock file ONLY while it still belongs to the given lease id.
 *
 * Why this exists (the double-holder bug):
 *   A release used to delete by PATH. After a takeover the path is the same
 *   file name but a DIFFERENT lease: tryTakeover()/forceTakeover() rename the
 *   expired file aside and the new holder then creates a fresh file at the
 *   original path. A late release from the old holder -- which still has
 *   `meta.lockPath` in memory -- would therefore delete the new holder's LIVE
 *   lock, and two agents would hold the same resource without either noticing.
 *   The lock file is authoritative, so the id recorded in it must match the id
 *   being released before anything is deleted.
 *
 * The same rule is enforced by the MCP server's releaseById(); the CLI's
 * `release <id>` reaches the same conclusion through the `_leases` index.
 *
 * @param {string} lockPath lock file path.
 * @param {string} id lease id the caller believes it is releasing.
 * @returns {{ removed: boolean, onDiskId: string | null }} whether the file was
 *   deleted, and the id that was actually found on disk (null when unreadable).
 */
export function removeIfOwned(lockPath, id) {
  const meta = readMeta(lockPath)
  if (meta === null) {
    // Already gone (TTL purge, manual cleanup, or a half-written file): there is
    // nothing to delete, and deleting "nothing" must not count as a release.
    return { removed: false, onDiskId: null }
  }
  const onDiskId = typeof meta.id === 'string' ? meta.id : null
  // Fail closed: anything other than an exact id match must keep the file.
  // A lock file that parses but carries no string id (`{}`, `{"id":123}`, a
  // file written by another tool/version) is NOT ours to delete -- deleting it
  // would be a silent hijack of whatever holds that path. The CLI reaches the
  // same conclusion (empty on-disk id -> remove nothing), so all three
  // implementations agree on this edge case.
  if (onDiskId === null || onDiskId !== id) {
    return { removed: false, onDiskId }
  }
  return { removed: removeLock(lockPath), onDiskId }
}

/**
 * Whether an id is safe to use as an index filename.
 * Rejects anything that is not a plain filename, which blocks path traversal
 * through `release(id)` while still accepting every id the CLI can produce.
 * Deliberately independent of the lowercasing in sanitizeKey -- an id is a
 * filename, not a resource key -- and byte-for-byte the same rule as the MCP
 * server's isSafeLeaseId.
 *
 * @param {unknown} id candidate lease id.
 * @returns {boolean} true when the id is a plain filename.
 */
export function isSafeLeaseId(id) {
  if (typeof id !== 'string' || id === '') return false
  return /^[A-Za-z0-9._-]+$/.test(id)
}

/** @param {string} lockRoot lock directory. @returns {string} index dir. */
function indexDir(lockRoot) {
  return path.join(lockRoot, INDEX_DIR)
}

/** @param {string} lockRoot lock directory. @param {string} id lease id. @returns {string} index file. */
function indexFile(lockRoot, id) {
  return path.join(indexDir(lockRoot), `${id}.json`)
}

/**
 * Record a lease in the CLI's index so `lease.ps1 release <id>` and
 * `lease.ps1 release --all -Owner <name>` can see it. The lock file itself
 * stays authoritative; a failed index write must not fail the acquire.
 *
 * @param {string} lockRoot lock directory.
 * @param {Record<string, any>} meta lease metadata.
 */
export function registerIndex(lockRoot, meta) {
  try {
    fs.mkdirSync(indexDir(lockRoot), { recursive: true })
    fs.writeFileSync(indexFile(lockRoot, meta.id), JSON.stringify({ id: meta.id, key: meta.key, path: meta.lockPath }))
  } catch {
    /* index is a convenience for the CLI, not part of the mutual exclusion */
  }
}

/**
 * Read one index record.
 *
 * @param {string} lockRoot lock directory.
 * @param {string} id lease id.
 * @returns {{ id?: string, key?: string, path?: string } | null} record or null.
 */
export function readIndex(lockRoot, id) {
  if (!isSafeLeaseId(id)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(lockRoot, id), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Delete one index record.
 *
 * @param {string} lockRoot lock directory.
 * @param {string} id lease id.
 */
export function removeIndex(lockRoot, id) {
  if (!isSafeLeaseId(id)) return
  try {
    fs.rmSync(indexFile(lockRoot, id), { force: true })
  } catch {
    /* already gone */
  }
}

/**
 * Read every index record. Unparseable records are skipped, not thrown.
 *
 * @param {string} lockRoot lock directory.
 * @returns {Array<{ id?: string, key?: string, path?: string }>} records.
 */
export function listIndex(lockRoot) {
  let names
  try {
    names = fs.readdirSync(indexDir(lockRoot))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(indexDir(lockRoot), name), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed)
    } catch {
      /* a torn index record is ignored; the lock files remain authoritative */
    }
  }
  return out
}

/**
 * Read every live lock file in the lock root, including the ones held by
 * other processes (the CLI, other agents, other harness instances).
 *
 * @param {string} lockRoot lock directory.
 * @returns {Array<Record<string, any>>} metadata of every readable lock.
 */
export function listLocks(lockRoot) {
  let names
  try {
    names = fs.readdirSync(lockRoot)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.lock')) continue
    const full = path.join(lockRoot, name)
    const meta = readMeta(full)
    if (!meta) continue
    out.push({ ...meta, lockPath: typeof meta.lockPath === 'string' && meta.lockPath !== '' ? meta.lockPath : full })
  }
  return out
}

/**
 * Parse a duration into milliseconds.
 *
 * Numbers are milliseconds (every field that uses this is named `*Ms`).
 * Strings accept the CLI's suffixes: "500ms", "30s", "2m", "1h"; a bare
 * numeric string is milliseconds here, because the tool argument already
 * carries the unit.
 *
 * @param {unknown} value number, duration string, or undefined.
 * @param {number} fallback value used when absent or unparseable.
 * @returns {number} non-negative integer milliseconds.
 */
export function toMs(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(value))
  if (!match) {
    // Unparseable is a hard error in all three implementations: a silent
    // fallback would hide a typo in DSH_RESOURCE_TTL or in a tool argument.
    throw new Error(
      `Cannot parse duration '${String(value)}'. Write 30s / 500ms / 2m / 1h.`,
    )
  }
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return fallback
  if (!match[2]) {
    // Bare numeric STRING: SECONDS, matching the CLI. Env vars are always
    // strings, so rejecting this would break existing deployments; and for a
    // lock, reading it as seconds is the safe direction (a too-short TTL gets
    // taken over early and produces two holders). A numeric *number* is
    // milliseconds, because every field that uses it is named `*Ms`.
    return Math.trunc(amount * 1000)
  }
  switch (match[2].toLowerCase()) {
    case 'h': return Math.trunc(amount * 3600000)
    case 'm': return Math.trunc(amount * 60000)
    case 's': return Math.trunc(amount * 1000)
    default: return Math.trunc(amount)
  }
}
