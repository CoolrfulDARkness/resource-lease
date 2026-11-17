/**
 * dsh-resource-lease -- lock kernel.
 *
 * This is the ONLY module that touches the lock directory. Its on-disk format is
 * deliberately byte-compatible with the zero-dependency CLI (`cli/lease.ps1`), so
 * an agent driving the CLI and an agent using this plugin exclude each other.
 *
 * v1 (still here, still authoritative for single-key leases): exclusive / shared
 * / pool arbitration on one key, TTL takeover, and the ownership-checked release.
 * v2 adds, per docs/RESOURCE-MODEL-v2.md:
 *
 *   §4  acquireMany()  -- one leaseId covering a GROUP of facets, acquired in the
 *                         global order (§3.4) so no cycle can form, rolled back in
 *                         reverse order on the first conflict.
 *   §5  liveness       -- a dead owner (same host, pid gone or pid reused) is
 *                         reclaimed at once instead of waiting for the TTL.
 *   §6  backends       -- LeaseBackend { tryCreate, read, remove, rename, list,
 *                         stat }, with a local fs backend that works today and a
 *                         broker backend that REFUSES to pretend it works.
 *
 * ATOMICITY (the one thing that is easy to get wrong):
 *   A lease is a FILE created with fs.openSync(path, 'wx'), which maps to
 *   open(O_CREAT | O_EXCL) -- the only portable primitive that decides
 *   success/failure in a single system call.
 *   Do NOT use mkdir / CreateDirectory as the lock: directory creation is
 *   idempotent, so every racer "succeeds" and mutual exclusion fails silently.
 *
 * LAYOUT (identical to the CLI, plus the v2 aggregate index):
 *   <lockRoot>/<sanitizedFacet>.lock              exclusive / shared
 *   <lockRoot>/<sanitizedFacet>.slot-<N>.lock     pool, one file per slot
 *   <lockRoot>/_leases/<leaseId>.json             index: one record per LEASE
 *                                                 (v2: covers all its facets)
 *   <lockRoot>/<name>.lock.stale.<ms>.<pid>       archived takeover (forensics)
 *
 *   The facet files are the ONLY thing that decides mutual exclusion. The
 *   `_leases/` record is an index: losing it costs you convenience (a fast
 *   release-by-id, the CLI's `release <id>`), never exclusion -- see
 *   readLeaseRecord()/releaseMany(), which rebuild the facet list from the lock
 *   files themselves when the index is gone (§4.2).
 *
 * LOCK FILE BODY (identical to the CLI, plus v2 fields; extra fields are ignored
 * by the CLI's ConvertFrom-Json, so both sides keep parsing each other's files):
 *   { id, key, facet, mode, slots, slot, owner, ownerInfo, reason, pid, host,
 *     session, procStart, createdAt, expiresAt, lockPath, facets, paths }
 *
 *   `owner` stays a STRING (the agent / session name) because v1 readers -- the
 *   CLI's status output, index.js's `meta.owner === owner` filters -- compare it
 *   as a string. The §5 owner record { agent, session, pid, host, procStart }
 *   lives in `ownerInfo`, and is duplicated flat (pid/host/session/procStart) for
 *   the CLI and for readers that predate ownerInfo. ownerInfoOf() reads all three
 *   shapes, so nothing has to know which writer produced a file.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// §2/§3 arrive from resources.js (single source of truth for the class table,
// facet expansion, the conflict predicate and the global order). Namespace
// import on purpose: a missing member is then a clear error at the one place
// that uses it, instead of a module that refuses to load at all.
import * as resourceModel from './resources.js'

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
 * How far a recorded `procStart` may sit from the probed one and still count as
 * the same process, in ms.
 *
 * §5 wants "procStart differs => PID was reused => reclaim now". A false match is
 * harmless (the lease is reclaimed early and its owner is dead anyway); a false
 * MISMATCH is the dangerous side: it would reclaim a LIVE owner's lease and put
 * two holders on one lock. The probe (wmic / /proc / ps) has coarse precision --
 * seconds at best -- so exact equality is not a safe test. 2 s is comfortably
 * above that error and far below any real PID-reuse gap.
 */
const PROC_START_TOLERANCE_MS = 2000

/** How long a probed foreign procStart is cached, in ms. Probing is expensive. */
const PROC_START_CACHE_MS = 10_000

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
 * resources.js owns the canonical rule in v2 and exports the same function; this
 * one is kept as the fallback so the v1 surface never depends on the v2 model
 * being present, and plugin/test/lock-v2.test.mjs asserts both agree on every
 * key class.
 *
 * @param {unknown} key raw resource key, e.g. "browser:chromium".
 * @returns {string} filesystem-safe, lowercase key base.
 */
export function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase()
}

/**
 * The sanitizer actually used for lock file names: resources.js's when it
 * exports one (so there is exactly one rule), else the local copy above.
 *
 * @param {unknown} key raw resource key.
 * @returns {string} filesystem-safe, lowercase key base.
 */
function keyBase(key) {
  const fromModel = activeModel().sanitizeKey
  if (typeof fromModel === 'function') return String(fromModel(key))
  return sanitizeKey(key)
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
  const base = keyBase(key)
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
 * This is the TTL-only path. v2's reclaimLock() is the same two rules plus the
 * liveness judgement of §5 (dead pid / reused pid), and is what acquireMany()
 * uses; it delegates here for the archive-and-verify mechanics.
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
 * `release <id>` reaches the same conclusion through the `_leases` index. It is
 * also the ONLY way v2 releases or rolls back anything (§11 #15): a lease that
 * lost a facet to a takeover must not delete the winner's file.
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
 * Write one `_leases/<id>.json` record. Best effort by design: the index is a
 * convenience (the CLI's `release <id>`, a fast release-by-id here), never part
 * of the mutual exclusion, so a failed write must not fail an acquire.
 *
 * @param {string} lockRoot lock directory.
 * @param {Record<string, any>} record index record.
 * @returns {boolean} true when the record was written.
 */
function writeIndexRecord(lockRoot, record) {
  if (typeof lockRoot !== 'string' || lockRoot === '') return false
  if (!isSafeLeaseId(record.id)) return false
  try {
    fs.mkdirSync(indexDir(lockRoot), { recursive: true })
    fs.writeFileSync(indexFile(lockRoot, record.id), JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

/**
 * Record a lease in the CLI's index so `lease.ps1 release <id>` and
 * `lease.ps1 release --all -Owner <name>` can see it. The lock file itself
 * stays authoritative; a failed index write must not fail the acquire.
 *
 * v1 signature and v1 record shape (id/key/owner/pid/path) are preserved --
 * index.js and the CLI both read `path` -- and v2 fields are added alongside so
 * a multi-facet lease can be released from its record too.
 *
 * @param {string} lockRoot lock directory.
 * @param {Record<string, any>} meta lease metadata.
 */
export function registerIndex(lockRoot, meta) {
  const paths = Array.isArray(meta.paths) && meta.paths.length > 0
    ? meta.paths.filter((entry) => typeof entry === 'string')
    : (typeof meta.lockPath === 'string' ? [meta.lockPath] : [])
  const facets = Array.isArray(meta.facets) && meta.facets.length > 0
    ? meta.facets.filter((entry) => typeof entry === 'string')
    : (typeof meta.facet === 'string' ? [meta.facet] : [])
  const info = ownerInfoOf(meta)
  writeIndexRecord(lockRoot, {
    // --- v1 shape, read by cli/lease.ps1 and by index.js ---
    id: meta.id,
    key: meta.key,
    owner: meta.owner,
    pid: meta.pid ?? info.pid,
    path: paths[0] ?? '',
    // --- v2 additions ---
    version: 2,
    session: info.session,
    host: info.host,
    procStart: info.procStart,
    reason: meta.reason,
    mode: meta.mode,
    slots: meta.slots,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    lockRoot,
    paths,
    facets,
    entries: Array.isArray(meta.entries) ? meta.entries : undefined,
  })
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

// ===========================================================================
// §3.4 / §2 -- resource model access
// ===========================================================================

/**
 * Thrown when the resource model (resources.js) is missing a member this module
 * needs, or when a caller passes something the contract does not allow. A
 * distinct type so a host can surface "the plugin is incompatible with its own
 * lib directory" instead of a bare TypeError.
 */
export class LeaseModelError extends Error {
  /**
   * @param {string} message what is wrong.
   */
  constructor(message) {
    super(message)
    this.name = 'LeaseModelError'
    this.code = 'LEASE_MODEL_UNAVAILABLE'
  }
}

/** An explicitly injected resource model (tests, embedders); null = resources.js. */
let injectedModel = null

/** Where degradation notices go; null = process.emitWarning. */
let modelWarningSink = null

/** Members already reported as degraded, so the warning is emitted once each. */
let degradedWarned = new Set()

/** Keys/facets already reported as INVALID, so one bad key does not spam every call. */
let invalidWarned = new Set()

/**
 * Replace the resource model (§2/§3) the kernel uses. `null` restores the imported
 * resources.js.
 *
 * The contract says the kernel and the CLI must agree on facets, so this exists for
 * tests and for embedders that bundle their own copy -- not as a runtime switch.
 *
 * @param {Record<string, any> | null} model a model object, or null to reset.
 * @returns {Record<string, any>} the model now in force.
 */
export function setResourceModel(model) {
  injectedModel = model && typeof model === 'object' ? model : null
  degradedWarned = new Set() // a new model may be complete again: re-arm the warnings
  invalidWarned = new Set()
  return activeModel()
}

/**
 * Route degradation warnings somewhere other than the standard `process.emitWarning`
 * (which writes to stderr). A host can pass its logger so "exclusion got weaker" is
 * visible where its operators already look.
 *
 * @param {((message: string) => void) | null} sink warning sink, or null to reset.
 */
export function setModelWarningSink(sink) {
  modelWarningSink = typeof sink === 'function' ? sink : null
}

/** @returns {Record<string, any>} the resource model in force. */
function activeModel() {
  return injectedModel ?? /** @type {Record<string, any>} */ (resourceModel)
}

/**
 * Emit one warning through the host's sink when there is one, else through
 * `process.emitWarning` (which writes to stderr). A broken sink must never break
 * a lock, and a plugin host that installed no sink must still see the notice.
 *
 * @param {string} message warning text.
 */
function emitModelWarning(message) {
  if (modelWarningSink !== null) {
    try {
      modelWarningSink(message)
      return
    } catch {
      /* a broken sink must not break a lock */
    }
  }
  try {
    process.emitWarning(message, 'ResourceLeaseWarning')
  } catch {
    console.warn(message)
  }
}

/**
 * Report that part of the resource model is missing and the kernel fell back to a
 * weaker rule -- ONCE per member.
 *
 * This is ONLY for "resources.js does not export X()". A broken key is a
 * different event with a different fix (see warnInvalidKey): reporting it through
 * this channel used to send operators hunting for a packaging problem.
 *
 * Why warn instead of just carrying on: the fallbacks are SAFE but WEAKER (a
 * facet set of one, exact-equality conflicts, a local order), which means
 * exclusion can silently become looser than the contract promises. §8 forbids
 * silent degradation, so this is emitted once per member per process and can be
 * routed by the host via setModelWarningSink().
 *
 * @param {string} member missing export name.
 * @param {string} fallback what the kernel does instead.
 */
function warnDegraded(member, fallback) {
  if (degradedWarned.has(member)) return
  degradedWarned.add(member)
  emitModelWarning(
    `resource-lease: lib/resources.js does not provide ${member}(); ${fallback}. `
    + 'Mutual exclusion is WEAKER than RESOURCE-MODEL-v2.md requires until that export exists '
    + '(see §8: no silent degradation).',
  )
}

/**
 * Report that the CALLER's key (or a facet read from disk) is not a usable
 * resource spelling -- once per distinct key per process.
 *
 * The distinction from warnDegraded() matters: "resources.js does not provide
 * canonicalKey()" sends an operator to packaging and version checks, while
 * `"port:30-20" must be written lo-hi with lo <= hi` sends the caller to its own
 * key. Both were previously reported as the first kind, which is why the message
 * is now built from the model's own error text.
 *
 * @param {string} key the offending spelling.
 * @param {unknown} error the model's error.
 */
function warnInvalidKey(key, error) {
  const text = String(key)
  const tag = `key:${text}`
  if (invalidWarned.has(tag)) return
  invalidWarned.add(tag)
  const why = error instanceof Error ? error.message : String(error)
  emitModelWarning(
    `resource-lease: "${text}" is not a usable resource key -- ${why} `
    + 'Read-only paths accept it as an opaque spelling; a lease request is REFUSED (no lock file is written).',
  )
}

/**
 * Report that a FACET (canonical key already on disk or in a request) could not
 * be ordered by the model. Same argument as warnInvalidKey: this is not a
 * missing export.
 *
 * @param {string} facet the offending facet.
 * @param {unknown} error the model's error.
 */
function warnInvalidFacet(facet, error) {
  const text = String(facet)
  const tag = `facet:${text}`
  if (invalidWarned.has(tag)) return
  invalidWarned.add(tag)
  const why = error instanceof Error ? error.message : String(error)
  emitModelWarning(
    `resource-lease: "${text}" could not be ordered as a facet -- ${why} `
    + 'Its raw lowercase spelling is used as the order key instead, which may differ from another machine\'s order (G2).',
  )
}

/**
 * Fetch one function from the resource model.
 *
 * @param {string} name exported member name.
 * @returns {((...args: any[]) => any) | null} the function, or null when absent.
 */
function tryModelFn(name) {
  const fn = activeModel()[name]
  return typeof fn === 'function' ? fn : null
}

/**
 * Fetch one function from the resource model, or fail with a message that says which
 * file is wrong. Called lazily so the v1 surface (single-key leases) keeps working
 * even if the v2 model is broken.
 *
 * @param {string} name exported member name.
 * @returns {(...args: any[]) => any} the function.
 */
function modelFn(name) {
  const fn = tryModelFn(name)
  if (fn === null) {
    throw new LeaseModelError(
      `lib/resources.js does not export ${name}(); the v2 lock kernel cannot expand or order facets without it`,
    )
  }
  return fn
}

/**
 * Canonical form of a READ-path key (§2): a key that came from a lock file on
 * disk, or from a status query.
 *
 * The read direction is deliberately TOLERANT (§2.1): a key this build cannot
 * canonicalise must still be usable as an opaque spelling, otherwise a lock
 * written by another writer becomes invisible and the caller believes a resource
 * is free. A malformed key is reported through warnInvalidKey() -- NOT through
 * warnDegraded(), which would claim resources.js is missing an export.
 *
 * For a LEASE REQUEST use canonicalKeyForAcquire(): the same tolerance there is
 * what let `port:30-20` and `path:` acquire lock files of their own (B1).
 *
 * ── KNOWN LIMITATION (contract gap, see §8) ─────────────────────────────────
 * Canonicalisation does NOT resolve aliases of the filesystem, by contract (§2: no
 * symbolic-link resolution, §10). On Windows that leaves THREE ways for one
 * directory to carry two different canonical keys:
 *
 *   1. 8.3 short names: C:\Users\JOHNDO~1\Temp vs C:\Users\JohnDoe\AppData\Local\Temp
 *      -- note the short name can also fold an unparented path segment, and this
 *      machine's own %TEMP% is such a path, so this is not hypothetical;
 *   2. symlinks and directory junctions;
 *   3. mapped/subst drives (X: -> C:\some\dir).
 *
 * Two agents using different spellings of ONE directory therefore hold two different
 * facet files and mutual exclusion silently fails -- exactly the class of bug v2's
 * facet model is meant to close. Fixing it needs alias resolution in canonicalPath()
 * (resources.js), identical on the CLI side, plus a contract decision about TOCTOU;
 * that is a §2/§8 change, NOT something the lock kernel may decide on its own.
 * resource_lease does not paper over it here: the kernel must agree with the CLI.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * @param {unknown} key raw key.
 * @returns {string} canonical key.
 */
export function canonicalKey(key) {
  const raw = String(key)
  const fn = tryModelFn('canonicalKey')
  if (fn === null) {
    warnDegraded('canonicalKey', 'keys are compared and named in their raw spelling')
    return raw
  }
  try {
    const value = fn(raw)
    if (typeof value === 'string' && value !== '') return value
    // A model that returns "" / a non-string is a broken export, not a bad key.
    warnDegraded('canonicalKey', 'keys are compared and named in their raw spelling')
    return raw
  } catch (error) {
    // The model REJECTED the key: that is the caller's spelling, not a missing
    // export (§2.1). Keep the read direction tolerant -- a foreign lock file must
    // never take a status query down -- but say what is actually wrong.
    warnInvalidKey(raw, error)
    return raw
  }
}

/**
 * Canonical form of a key for a LEASE REQUEST -- the strict direction of §2.1.
 *
 * §2.1 splits the two directions on purpose: reading a lock file must accept
 * anything (else the locks written by an older/other writer become invisible),
 * but a NEW REQUEST must be rejected when the key cannot be canonicalised. The
 * reason is the failure this module exists to prevent: an unparsed key kept in
 * its raw spelling becomes its own little universe of one facet file, so
 * `port:30-20` or `path:` would acquire happily and exclude nobody -- and a typo
 * would silently lose the protection the caller thinks it has.
 *
 * So: the model's error is RETHROWN here (never caught into `raw`), and the raw
 * fallback survives in exactly one case -- resources.js cannot be used at all
 * (`tryModelFn() === null`), which is announced through warnDegraded().
 *
 * @param {unknown} key raw key from a request.
 * @returns {string} canonical key.
 */
export function canonicalKeyForAcquire(key) {
  const raw = String(key)
  const fn = tryModelFn('canonicalKey')
  if (fn === null) {
    warnDegraded('canonicalKey', 'keys are compared and named in their raw spelling')
    return raw
  }
  const value = fn(raw) // an invalid key throws: that IS the validation
  if (typeof value !== 'string' || value === '') {
    throw new LeaseModelError(
      `lib/resources.js canonicalKey() returned ${JSON.stringify(value)} for "${raw}" instead of a canonical key`,
    )
  }
  return value
}

/**
 * Facets of one key read from disk or from a status query (§3.1) -- the TOLERANT
 * direction. A key with no expansion (an unknown class) is its own single facet:
 * an empty set would mean "needs nothing", and a lease that silently needs
 * nothing is worse than an over-serialised one.
 *
 * @param {unknown} key raw resource key.
 * @returns {string[]} non-empty list of canonical facets.
 */
export function facetsOf(key) {
  const raw = String(key)
  const fn = tryModelFn('expandFacets')
  let facets = []
  if (fn === null) {
    warnDegraded('expandFacets', 'each key becomes a single exact facet, so cross-class implications (browser:cdp -> port, browser:profile -> path) are NOT detected')
  } else {
    try {
      const value = fn(raw)
      if (Array.isArray(value)) facets = value.filter((entry) => typeof entry === 'string' && entry !== '')
    } catch (error) {
      warnInvalidKey(raw, error)
      facets = []
    }
  }
  if (facets.length === 0) facets = [canonicalKey(raw)]
  return [...new Set(facets)]
}

/**
 * Facets of one key for a LEASE REQUEST -- the strict direction of §2.1/§3.1.
 *
 * Same split as canonicalKeyForAcquire(): a request whose key cannot be expanded
 * is REFUSED, because "it expanded to nothing" and "it expanded to itself in the
 * caller's own spelling" are both silent losses of exclusion. Only a completely
 * unusable resources.js degrades to the raw spelling, and that warns.
 *
 * @param {unknown} key raw resource key from a request.
 * @returns {string[]} non-empty list of canonical facets.
 */
export function facetsForAcquire(key) {
  const raw = String(key)
  const fn = tryModelFn('expandFacets')
  if (fn === null) {
    warnDegraded('expandFacets', 'each key becomes a single exact facet, so cross-class implications (browser:cdp -> port, browser:profile -> path) are NOT detected')
    return [canonicalKeyForAcquire(raw)]
  }
  const value = fn(raw) // an invalid key throws: that IS the validation
  const facets = Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry !== '')
    : []
  if (facets.length === 0) return [canonicalKeyForAcquire(raw)]
  return [...new Set(facets)]
}

/**
 * The global order (§3.4) of one facet. Uses the resource model when it can, else an
 * equivalent local fallback (`class:subject`, lowercased) so sorting still works.
 *
 * The fallback is a DIFFERENT total order from the contract's, which is why it warns:
 * if two machines sort differently they can acquire in opposite orders and deadlock
 * across hosts (G2). Locally it is still a fixed total order, so a single-machine
 * deployment stays deadlock-free.
 *
 * @param {string} facet canonical facet.
 * @returns {string} sort key.
 */
export function orderKey(facet) {
  const fn = tryModelFn('orderKey')
  if (fn === null) {
    warnDegraded('orderKey', 'a local lowercase order is used instead, which may differ from another machine\'s order and break G2 across hosts')
    return String(facet).toLowerCase()
  }
  try {
    const value = fn(facet)
    if (typeof value === 'string' && value !== '') return value
  } catch (error) {
    // A facet that cannot be parsed is a KEY problem, not a missing export (§3.4).
    warnInvalidFacet(String(facet), error)
    return String(facet).toLowerCase()
  }
  warnDegraded('orderKey', 'a local lowercase order is used instead, which may differ from another machine\'s order and break G2 across hosts')
  return String(facet).toLowerCase()
}

const MODE_STRENGTH = { shared: 1, pool: 2, exclusive: 3 }

/**
 * Whether two held modes can coexist on the SAME facet (§3.2 capacity clause).
 *
 * resources.js's facetsConflict() already encodes "shared + shared is fine". The
 * pool clause is enforced here as well because capacity is a lock-kernel concept:
 * N pool holders on one facet are separated by their SLOT FILES, so their facet
 * records must not count as a conflict, or a pool of 2 would only ever admit 1.
 *
 * @param {string} modeA one mode.
 * @param {string} modeB the other mode.
 * @returns {boolean} true when the modes conflict.
 */
function modesClash(modeA, modeB) {
  if (modeA === 'shared' && modeB === 'shared') return false
  if (modeA === 'pool' && modeB === 'pool') return false
  return true
}

/**
 * The §3.2 conflict predicate as the lock kernel uses it.
 *
 * @param {string} facetA held/wanted facet.
 * @param {string} modeA its mode.
 * @param {string} facetB the other facet.
 * @param {string} modeB its mode.
 * @returns {boolean} true when holding both is unsafe.
 */
export function facetsClash(facetA, modeA, facetB, modeB) {
  if (!facetA || !facetB) return false
  if (!modesClash(modeA, modeB)) return false
  const fn = tryModelFn('facetsConflict')
  if (fn === null) {
    // Fallback is exact-facet equality: it under-approximates (ancestor paths, port
    // ranges and cross-class implications are missed) but never invents a conflict.
    warnDegraded('facetsConflict', 'conflicts are decided by exact facet equality, so ancestor paths, port ranges and browser/port implications are missed')
    return facetA === facetB
  }
  try {
    return fn(facetA, modeA, facetB, modeB) === true
  } catch {
    warnDegraded('facetsConflict', 'conflicts are decided by exact facet equality, so ancestor paths, port ranges and browser/port implications are missed')
    return facetA === facetB
  }
}

// ===========================================================================
// §5 -- owner identity and liveness
// ===========================================================================

/** @returns {string} this machine's host name, lowercased for comparison. */
export function hostname() {
  return os.hostname()
}

const procStartCache = new Map()

/**
 * Start time of THIS process, in epoch ms, without spawning anything:
 * now minus uptime. `procStart` exists to catch PID reuse (§5) and this is the
 * cheap, always-available half of that comparison.
 *
 * @param {number} [now] reference clock.
 * @returns {number} epoch ms of process start.
 */
export function currentProcStart(now = Date.now()) {
  const uptimeMs = Math.round(process.uptime() * 1000)
  return now - uptimeMs
}

/**
 * Run a helper program and return its stdout, or null. Never throws: liveness
 * probing is advisory, and a probe failure must not fail an acquire.
 *
 * @param {string} file executable.
 * @param {string[]} args arguments.
 * @param {number} timeoutMs kill after this long.
 * @returns {string | null} stdout (trimmed) or null.
 */
function safeExec(file, args, timeoutMs) {
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return typeof out === 'string' ? out.trim() : null
  } catch {
    return null
  }
}

/**
 * Probe the start time of a foreign pid (epoch ms), or null when the platform
 * cannot tell us.
 *
 * Why we bother: §5 needs "pid EXISTS but procStart does not match" -> the pid was
 * reused by an unrelated process, so the lease is a leak and must be reclaimed at
 * once. Without this probe a reused pid looks like a live owner and the lock
 * leaks until the TTL expires.
 *
 * Why it is allowed to return null: a wrong MISMATCH would reclaim a live lease
 * (two holders), so "unknown" must mean "trust the pid, wait for the TTL".
 *
 * Cost: on Windows the probe is wmic (fast, but gone from Windows 11 24H2) with a
 * PowerShell fallback (slow, ~300 ms); results are cached per pid for
 * PROC_START_CACHE_MS and only the rare same-host-foreign-pid takeover path pays
 * it. Callers with a better source (the CLI, tests) can pass `procStartOf`.
 *
 * @param {number} pid target process id.
 * @param {number} [now] reference clock.
 * @returns {number | null} epoch ms, or null when unknown.
 */
export function readProcStart(pid, now = Date.now()) {
  const target = toPid(pid)
  if (target === null) return null
  if (target === process.pid) return currentProcStart(now)

  const cached = procStartCache.get(target)
  if (cached !== undefined && now - cached.at < PROC_START_CACHE_MS) return cached.value

  let value = null
  try {
    value = probeProcStart(target)
  } catch {
    value = null
  }
  procStartCache.set(target, { at: now, value })
  return value
}

/**
 * Platform-specific half of readProcStart().
 *
 * @param {number} pid target process id.
 * @returns {number | null} epoch ms, or null.
 */
function probeProcStart(pid) {
  if (process.platform === 'linux') {
    // /proc/<pid>/stat field 22 is the start time in clock ticks after boot.
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const close = stat.lastIndexOf(')') // the comm field may contain spaces
      const fields = stat.slice(close + 2).split(' ')
      const startTicks = Number(fields[19])
      if (!Number.isFinite(startTicks)) return null
      const bootLine = fs.readFileSync('/proc/stat', 'utf8').split('\n').find((line) => line.startsWith('btime '))
      const bootSeconds = bootLine ? Number(bootLine.split(' ')[1]) : NaN
      if (!Number.isFinite(bootSeconds)) return null
      const ticksPerSecond = 100 // USER_HZ; the only value Linux has used for decades
      return Math.round(bootSeconds * 1000 + (startTicks / ticksPerSecond) * 1000)
    } catch {
      return null
    }
  }

  if (process.platform === 'win32') {
    // wmic first: one cheap process. CreationDate looks like
    // 20261117021615.123456+480 (local time plus the UTC offset in minutes).
    const wmic = safeExec('wmic', ['process', 'where', `processid=${pid}`, 'get', 'creationdate', '/value'], 4000)
    if (wmic) {
      const match = /CreationDate=(\d{14})\.(\d{1,6})([+-]\d{1,4})?/.exec(wmic)
      if (match) {
        const y = Number(match[1].slice(0, 4))
        const mo = Number(match[1].slice(4, 6))
        const d = Number(match[1].slice(6, 8))
        const h = Number(match[1].slice(8, 10))
        const mi = Number(match[1].slice(10, 12))
        const s = Number(match[1].slice(12, 14))
        const ms = Number((match[2] + '000').slice(0, 3))
        const offsetMinutes = match[3] ? Number(match[3]) : 0
        const utcMs = Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMinutes * 60_000
        if (Number.isFinite(utcMs)) return utcMs
      }
    }
    // PowerShell fallback (Windows 11 24H2+ has no wmic).
    const ps = safeExec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction Stop; [int64]([datetimeoffset]$p.StartTime).ToUnixTimeMilliseconds()`,
      ],
      5000,
    )
    if (ps) {
      const value = Number(ps.trim())
      if (Number.isFinite(value) && value > 0) return value
    }
    return null
  }

  // darwin / other unix: ps prints a human date; parse it via Date.
  const ps = safeExec('ps', ['-o', 'lstart=', '-p', String(pid)], 4000)
  if (ps) {
    const parsed = Date.parse(ps)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Coerce a pid-ish value to a positive integer, or null.
 *
 * @param {unknown} value candidate.
 * @returns {number | null} pid or null.
 */
function toPid(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

/**
 * Whether a process id currently exists.
 *
 * `process.kill(pid, 0)` is the portable existence probe: it throws ESRCH when
 * the pid is gone and EPERM when it exists but belongs to someone else -- EPERM
 * therefore means "exists" (a lock held by another user is still held).
 *
 * @param {unknown} pid candidate pid.
 * @returns {boolean} true when the process exists.
 */
export function pidExists(pid) {
  const target = toPid(pid)
  if (target === null) return false
  try {
    process.kill(target, 0)
    return true
  } catch (err) {
    if (err && err.code === 'EPERM') return true
    return false
  }
}

/**
 * Whether a recorded procStart identifies the same process as a probed one.
 *
 * @param {unknown} recorded what the lease recorded.
 * @param {unknown} actual what the probe returned.
 * @param {number} [toleranceMs] allowed skew.
 * @returns {boolean} true when they agree.
 */
export function procStartMatches(recorded, actual, toleranceMs = PROC_START_TOLERANCE_MS) {
  const a = Number(recorded)
  const b = Number(actual)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= toleranceMs
}

/**
 * Normalise whatever a lock file carries into the §5 owner record
 * `{ agent, session, pid, host, procStart, pidGated }`.
 *
 * Three shapes are in the wild and all must work, because v1 writers (index.js,
 * the CLI) know nothing about ownerInfo:
 *   1. v2:    meta.ownerInfo = { agent, session, pid, host, procStart, pidGated }
 *   2. v1+v2: meta.owner = "agent", meta.pid / meta.host / meta.session / ...
 *   3. v1:    meta.owner = "agent", meta.pid / meta.host
 *
 * `pidGated` is carried through because §5 makes it decisive: false means "this
 * lease's pid is NOT evidence of death" (the CLI writes false -- see below), and
 * dropping it here is what let the kernel reclaim a live CLI lease. Undefined
 * means "not stated", which §5 defines as gated (true).
 *
 * @param {Record<string, any> | null | undefined} meta lock metadata.
 * @returns {{ agent: string | undefined, session: string | undefined, pid: number | null, host: string | undefined, procStart: number | null, pidGated: boolean | undefined }} owner record.
 */
export function ownerInfoOf(meta) {
  const source = meta && typeof meta === 'object' ? meta : {}
  const nested = source.ownerInfo && typeof source.ownerInfo === 'object' ? source.ownerInfo : {}
  const agent = typeof nested.agent === 'string'
    ? nested.agent
    : (typeof source.owner === 'string' ? source.owner : (typeof source.owner === 'object' && source.owner && typeof source.owner.agent === 'string' ? source.owner.agent : undefined))
  const session = typeof nested.session === 'string'
    ? nested.session
    : (typeof source.session === 'string' ? source.session : undefined)
  const rawPid = nested.pid ?? source.pid
  const pid = toPid(rawPid)
  const host = typeof nested.host === 'string' ? nested.host : (typeof source.host === 'string' ? source.host : undefined)
  const rawStart = nested.procStart ?? source.procStart
  const startNum = Number(rawStart)
  const procStart = Number.isFinite(startNum) && startNum > 0 ? startNum : null
  const rawGated = nested.pidGated ?? source.pidGated
  const pidGated = rawGated === false ? false : (rawGated === true ? true : undefined)
  return { agent, session, pid, host, procStart, pidGated }
}

/**
 * Build the §5 owner record for THIS process, or normalise one that was passed in.
 *
 * @param {string | Record<string, any> | undefined} [owner] agent name, or a full owner record.
 * @param {Record<string, any>} [overrides] extra fields (session, procStart, pid, host, agent).
 * @returns {{ agent: string, session: string | undefined, pid: number, host: string, procStart: number }} owner record.
 */
export function currentOwner(owner, overrides = {}) {
  const base = typeof owner === 'object' && owner !== null ? owner : {}
  const agentFromString = typeof owner === 'string' && owner !== '' ? owner : undefined
  const agent = base.agent ?? agentFromString ?? overrides.agent
    ?? (typeof process.env.DSH_AGENT_NAME === 'string' && process.env.DSH_AGENT_NAME !== '' ? process.env.DSH_AGENT_NAME : undefined)
    ?? `pid:${process.pid}`
  const session = base.session ?? overrides.session
    ?? (typeof process.env.DSH_SESSION_ID === 'string' && process.env.DSH_SESSION_ID !== '' ? process.env.DSH_SESSION_ID : undefined)
  const pid = toPid(base.pid ?? overrides.pid ?? process.pid) ?? process.pid
  const host = typeof (base.host ?? overrides.host) === 'string' && (base.host ?? overrides.host) !== ''
    ? String(base.host ?? overrides.host)
    : hostname()
  const procStartNum = Number(base.procStart ?? overrides.procStart)
  const procStart = Number.isFinite(procStartNum) && procStartNum > 0
    ? procStartNum
    : (pid === process.pid ? currentProcStart() : null)
  return { agent: String(agent), session, pid, host, procStart }
}

/**
 * Is the owner of this lease still running? (§5) -- the judgement that must beat
 * the TTL.
 *
 * Returns a TRI-STATE on purpose:
 *   true  -- alive: keep the lease
 *   false -- dead, or the pid was reused: reclaim at once
 *   null  -- cannot tell (cross host, unknown pid, probe unavailable): fall back
 *            to the TTL
 *
 * Failing towards "alive" is deliberate. Reclaiming a live lease is the one
 * mistake that produces two holders; leaking a lock until its TTL runs out is
 * only inconvenient, and is what v1 did for every case anyway.
 *
 * @param {Record<string, any> | null} meta lock metadata.
 * @param {Record<string, any>} [options] clock, host, probe overrides.
 * @returns {boolean | null} liveness verdict.
 */
export function isOwnerAlive(meta, options = {}) {
  if (!meta || typeof meta !== 'object') return null
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  if (isExpired(meta, now)) return false

  const info = ownerInfoOf(meta)
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : hostname()
  const exists = typeof options.pidExists === 'function' ? options.pidExists : pidExists
  const startOf = typeof options.procStartOf === 'function' ? options.procStartOf : readProcStart
  const tolerance = Number.isFinite(options.procStartToleranceMs) ? options.procStartToleranceMs : PROC_START_TOLERANCE_MS

  if (info.pid === null) return null // no pid recorded (a v0 file): TTL decides
  if (typeof info.host === 'string' && info.host !== '' && info.host.toLowerCase() !== host.toLowerCase()) {
    return null // another machine: only its own TTL can say (§5, cross host)
  }
  // §5: `pidGated: false` means "this lease's pid is NOT evidence of death".
  //
  // The CLI writes false on purpose: `lease.ps1 acquire` is a ONE-SHOT process, so
  // its pid is dead a millisecond after the command returns while the lease is
  // perfectly valid. Judging it by pid made every CLI lease instantly reclaimable,
  // so a plugin acquire took over a *live* CLI lock -- mutual exclusion collapsing
  // exactly where two tools meet (G1). The contract names this case:
  // "CLI 必须写 false ... 若参与 PID 回收,每条 CLI 租约都会被下一个进程立刻判定'持有者已死'并回收".
  // Undefined counts as gated (true), which is §5's default for long-lived owners.
  if (info.pidGated === false) return null

  let alive
  try {
    alive = exists(info.pid) === true
  } catch {
    return null
  }
  if (!alive) return false // §5: same host, pid gone -> reclaim now

  if (info.procStart === null) return true // nothing recorded to compare against
  let actual = null
  try {
    actual = startOf(info.pid, now)
  } catch {
    actual = null
  }
  const actualNum = Number(actual)
  if (!Number.isFinite(actualNum) || actualNum <= 0) return true // probe unavailable: trust the pid
  // §5: pid exists but belongs to a different process -> the original died and the
  // pid was reused. Reclaim immediately instead of leaking until the TTL.
  return procStartMatches(info.procStart, actualNum, tolerance)
}

/**
 * Record the facets a lock file represents, for diagnostics and for reporting a
 * conflict against a file written by a v1 writer (which has no `facet` field).
 *
 * @param {Record<string, any>} meta lock metadata.
 * @returns {string[]} facets, possibly empty.
 */
export function facetsOfMeta(meta) {
  if (!meta || typeof meta !== 'object') return []
  if (Array.isArray(meta.facets) && meta.facets.length > 0) {
    return meta.facets.filter((entry) => typeof entry === 'string' && entry !== '')
  }
  if (typeof meta.facet === 'string' && meta.facet !== '') return [meta.facet]
  if (typeof meta.key === 'string' && meta.key !== '') return facetsOf(meta.key)
  return []
}

// ===========================================================================
// §6 -- LeaseBackend
// ===========================================================================

/**
 * Thrown by a backend that is declared but not implemented (the broker). It is a
 * FEATURE that this throws instead of silently working locally: §8.3 says a
 * cross-machine deployment whose broker is unreachable must fail loudly and
 * degrade to read-only, never quietly fall back to local locks, because a local
 * lock cannot exclude a process on another machine.
 */
export class LeaseNotImplementedError extends Error {
  /**
   * @param {string} message what is not implemented.
   */
  constructor(message) {
    super(message)
    this.name = 'LeaseNotImplementedError'
    this.code = 'LEASE_NOT_IMPLEMENTED'
  }
}

/**
 * The local, zero-dependency backend (§6): one lock file per facet, O_EXCL for
 * the claim, rename for the CAS, id-checked delete for the release.
 *
 * The interface is exactly §6 plus one extension:
 *   pathFor(facet, mode, slot) -- where that facet's lock file would live. The
 *   facet layout is a property of the backend (a shared directory locally, a
 *   namespace under a broker), so the kernel must not build paths itself.
 *
 * @param {string} lockRoot lock directory.
 * @param {{ warn?: (message: string) => void }} [options] diagnostics sink.
 * @returns {Record<string, any>} backend.
 */
export function localBackend(lockRoot, options = {}) {
  if (typeof lockRoot !== 'string' || lockRoot.trim() === '') {
    throw new TypeError('localBackend(lockRoot) needs a non-empty lock directory')
  }
  const root = lockRoot.trim()
  const warn = typeof options.warn === 'function' ? options.warn : () => {}

  const backend = {
    kind: 'local',
    lockRoot: root,

    /** @param {string} facet facet. @param {string} mode mode. @param {number} slot slot. @returns {string} lock path. */
    pathFor(facet, mode, slot) {
      return lockPathFor(root, facet, mode, slot)
    },

    /**
     * O_CREAT|O_EXCL claim (§6 tryCreate).
     *
     * @param {string} lockPath target.
     * @param {Record<string, any>} meta lease metadata.
     * @returns {boolean} true when created by this call.
     */
    tryCreate(lockPath, meta) {
      try {
        fs.mkdirSync(root, { recursive: true })
        fs.mkdirSync(path.dirname(lockPath), { recursive: true })
      } catch {
        /* the create below reports the real problem */
      }
      return tryAcquire(lockPath, meta)
    },

    /** @param {string} lockPath target. @returns {Record<string, any> | null} metadata or null. */
    read(lockPath) {
      return readMeta(lockPath)
    },

    /**
     * Delete only while the file still belongs to `leaseId` (§6 remove).
     *
     * @param {string} lockPath target.
     * @param {string} leaseId the id the caller believes it owns.
     * @returns {boolean} true when the file was deleted.
     */
    remove(lockPath, leaseId) {
      return removeIfOwned(lockPath, leaseId).removed
    },

    /**
     * Rename as a compare-and-swap (§6 rename). Fails when the source is gone,
     * which is exactly how two racers on one expired lease pick a single winner.
     *
     * @param {string} from source.
     * @param {string} to destination.
     * @returns {boolean} true when moved.
     */
    rename(from, to) {
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.renameSync(from, to)
        return true
      } catch {
        return false
      }
    },

    /** @returns {Array<{ path: string, meta: Record<string, any> | null, slot: number | null }>} every lock file. */
    list() {
      let names
      try {
        names = fs.readdirSync(root)
      } catch {
        return []
      }
      const out = []
      for (const name of names) {
        if (!name.endsWith('.lock')) continue
        const full = path.join(root, name)
        const slotMatch = /\.slot-(\d+)\.lock$/.exec(name)
        out.push({
          path: full,
          meta: readMeta(full),
          slot: slotMatch ? Number(slotMatch[1]) : null,
        })
      }
      return out
    },

    /** @param {string} lockPath target. @returns {{ mtimeMs: number, size: number } | null} stat or null. */
    stat(lockPath) {
      try {
        const st = fs.statSync(lockPath)
        return { mtimeMs: st.mtimeMs, size: st.size }
      } catch {
        return null
      }
    },

    /** @param {number} now reference clock. */
    purgeStale(now = Date.now()) {
      purgeStale(root, now)
    },
  }

  backend.warn = warn
  return backend
}

/**
 * The broker backend (§6, cross-machine). Declared, NOT implemented: every method
 * throws LeaseNotImplementedError.
 *
 * Why refuse instead of degrading: a lease that "works" locally on machine A says
 * nothing about machine B, so silently returning success would be a lie about the
 * one guarantee this module exists for. The failure is explicit and immediate so
 * a caller can surface it (§8.3: fail loudly, degrade to read-only).
 *
 * @param {{ url?: string, lockRoot?: string }} [config] broker location.
 * @returns {Record<string, any>} backend whose every operation refuses.
 */
export function brokerBackend(config = {}) {
  const url = typeof config.url === 'string' && config.url !== '' ? config.url : '(no url configured)'
  /**
   * @param {string} operation method name.
   * @returns {never} always throws.
   */
  const refuse = (operation) => {
    throw new LeaseNotImplementedError(
      `broker backend ${operation}() is not implemented (broker ${url}). `
      + 'Cross-machine leases need the HTTP CAS broker from RESOURCE-MODEL-v2.md §6; until then use the local backend, '
      + 'or refuse the operation. Do not fall back to local locks for cross-machine work -- they cannot exclude another machine.',
    )
  }
  return {
    kind: 'broker',
    lockRoot: typeof config.lockRoot === 'string' ? config.lockRoot : undefined,
    url: config.url,
    pathFor(facet, mode, slot) {
      return refuse(`pathFor(${facet},${mode},${slot})`)
    },
    tryCreate() { return refuse('tryCreate') },
    read() { return refuse('read') },
    remove() { return refuse('remove') },
    rename() { return refuse('rename') },
    list() { return refuse('list') },
    stat() { return refuse('stat') },
  }
}

/**
 * Check that a value satisfies the §6 interface far enough for the kernel to run.
 * A missing method is a programming error and throws here, at the boundary, not
 * halfway through an acquisition where a partial lease would be left behind.
 *
 * @param {unknown} backend candidate backend.
 * @returns {Record<string, any>} the same backend, typed.
 */
export function assertBackend(backend) {
  if (!backend || typeof backend !== 'object') {
    throw new TypeError('acquireMany() needs a LeaseBackend, e.g. localBackend(lockRoot)')
  }
  for (const name of ['tryCreate', 'read', 'remove', 'rename', 'list', 'stat']) {
    if (typeof (/** @type {any} */ (backend)[name]) !== 'function') {
      throw new TypeError(`LeaseBackend.${name}() is missing; see RESOURCE-MODEL-v2.md §6`)
    }
  }
  if (typeof (/** @type {any} */ (backend).pathFor) !== 'function') {
    throw new TypeError('LeaseBackend.pathFor(facet, mode, slot) is missing; the kernel cannot lay out facet files')
  }
  return /** @type {Record<string, any>} */ (backend)
}

/** @param {unknown} backend candidate. @returns {boolean} true when it looks like a backend. */
export function isLeaseBackend(backend) {
  try {
    assertBackend(backend)
    return true
  } catch {
    return false
  }
}

// ===========================================================================
// §4.2 -- the aggregate lease index (`_leases/<leaseId>.json`)
// ===========================================================================

/**
 * Write (or refresh) the aggregate record for one lease.
 *
 * The record is an INDEX. The facet lock files are the authority; this exists so
 * `release <id>` (CLI) and a reloaded plugin can find every facet of a lease
 * without scanning. §4.2: losing it must not affect exclusion, and it does not --
 * releaseMany() rebuilds the list from the lock files when the record is missing.
 *
 * @param {Record<string, any>} backend backend with a local lockRoot.
 * @param {Record<string, any>} record lease record.
 * @returns {boolean} true when written.
 */
export function registerLeaseRecord(backend, record) {
  const lockRoot = backend && typeof backend.lockRoot === 'string' ? backend.lockRoot : ''
  if (lockRoot === '') return false
  return writeIndexRecord(lockRoot, { ...record, lockRoot })
}

/**
 * Read the aggregate record for one lease.
 *
 * @param {Record<string, any>} backend backend with a local lockRoot.
 * @param {string} id lease id.
 * @returns {Record<string, any> | null} record or null when absent/unreadable.
 */
export function readLeaseRecord(backend, id) {
  const lockRoot = backend && typeof backend.lockRoot === 'string' ? backend.lockRoot : ''
  if (lockRoot === '') return null
  return readIndex(lockRoot, id)
}

/**
 * Delete the aggregate record for one lease.
 *
 * @param {Record<string, any>} backend backend with a local lockRoot.
 * @param {string} id lease id.
 * @returns {boolean} true when the backend can host an index.
 */
export function removeLeaseRecord(backend, id) {
  const lockRoot = backend && typeof backend.lockRoot === 'string' ? backend.lockRoot : ''
  if (lockRoot === '') return false
  removeIndex(lockRoot, id)
  return true
}

/**
 * Every facet path mentioned by an index record or by a lock file's own body.
 * Used to rebuild a release list when the index is gone (§4.2).
 *
 * @param {Record<string, any> | null} record index record or lock metadata.
 * @returns {string[]} lock file paths.
 */
function pathsOfRecord(record) {
  if (!record || typeof record !== 'object') return []
  const out = []
  if (Array.isArray(record.paths)) {
    for (const entry of record.paths) if (typeof entry === 'string' && entry !== '') out.push(entry)
  }
  if (typeof record.path === 'string' && record.path !== '') out.push(record.path)
  if (typeof record.lockPath === 'string' && record.lockPath !== '') out.push(record.lockPath)
  if (Array.isArray(record.entries)) {
    for (const entry of record.entries) {
      if (entry && typeof entry.lockPath === 'string' && entry.lockPath !== '') out.push(entry.lockPath)
    }
  }
  return [...new Set(out)]
}

// ===========================================================================
// §4.1 -- planning a multi-facet acquisition
// ===========================================================================

/**
 * Turn a request spec into a sorted, de-duplicated acquisition plan (§4.1 step 1-2).
 *
 * `requests` accepts the §7.1 shapes:
 *   "path:D:/out"
 *   { key: "path:D:/out", mode: "shared", slots: 2 }
 *   [ "path:D:/out", { key: "port:9222" } ]
 *
 * Merge rule for one facet reached by several requests: the STRONGER mode wins
 * (exclusive > pool > shared) and slots takes the max. A plan entry therefore can
 * never ask for something weaker than one of its sources.
 *
 * Two REJECTIONS live here, both before any disk write:
 *
 *   - an unusable key (B1): expansion runs through facetsForAcquire(), the strict
 *     direction of §2.1, so `port:30-20`, `port:99999`, `path:` or a relative
 *     `path:out` throws instead of becoming a lock file of its own.
 *   - a request that contradicts ITSELF (B6): after the merge, every pair of
 *     facets from DIFFERENT keys is checked with the §3.2 predicate. `path:D:/x1`
 *     plus `path:D:/x1/sub` can never be satisfied -- exactly as the CLI's exit 3
 *     says -- so the whole group is refused rather than half-acquired.
 *
 * Sort rule: ascending orderKey (§3.4). This is the whole of G2: every process,
 * on every machine, computes the same order without consulting anyone, so the wait
 * graph can only point one way and cannot close into a cycle.
 *
 * @param {unknown} requests one request, or an array of them.
 * @returns {Array<{ facet: string, mode: string, slots: number, keys: string[] }>} plan, sorted.
 */
export function planAcquisition(requests) {
  const list = Array.isArray(requests) ? requests : [requests]
  if (list.length === 0) {
    throw new TypeError('acquireMany() needs at least one resource request')
  }

  /** @type {Map<string, { facet: string, mode: string, slots: number, keys: string[] }>} */
  const merged = new Map()
  /** The key each facet was first reached by: a facet's own expansion may not conflict with itself. */
  const source = new Map()
  for (const raw of list) {
    if (raw === undefined || raw === null) continue
    const spec = typeof raw === 'string' ? { key: raw } : raw
    if (typeof spec !== 'object' || typeof /** @type {any} */ (spec).key !== 'string' || /** @type {any} */ (spec).key === '') {
      throw new TypeError(`Each resource request needs a non-empty key; got ${JSON.stringify(raw)}`)
    }
    const key = /** @type {any} */ (spec).key
    const mode = /** @type {any} */ (spec).mode ?? 'exclusive'
    if (!(mode in MODE_STRENGTH)) {
      throw new TypeError(`Unknown mode '${String(mode)}' for ${key}; use exclusive, shared or pool`)
    }
    const rawSlots = /** @type {any} */ (spec).slots
    let slots = 1
    if (mode === 'pool') {
      const n = Number(rawSlots)
      slots = Number.isInteger(n) && n >= 1 ? n : 1
    }

    let facets
    try {
      facets = facetsForAcquire(key)
    } catch (error) {
      // Say WHICH key and WHY. `path:` and `port:30-20` are caller mistakes; a
      // missing resources.js export is a different problem and never lands here.
      warnInvalidKey(key, error)
      const why = error instanceof Error ? error.message : String(error)
      const code = error instanceof Error && error.code === 'LEASE_MODEL_UNAVAILABLE'
        ? 'LEASE_MODEL_UNAVAILABLE'
        : 'LEASE_INVALID_KEY'
      throw Object.assign(new TypeError(`Invalid resource key ${JSON.stringify(key)}: ${why}`), { code, key })
    }

    for (const facet of facets) {
      const existing = merged.get(facet)
      if (!existing) {
        merged.set(facet, { facet, mode, slots, keys: [key] })
        source.set(facet, key)
        continue
      }
      if (MODE_STRENGTH[mode] > MODE_STRENGTH[existing.mode]) existing.mode = mode
      if (slots > existing.slots) existing.slots = slots
      if (!existing.keys.includes(key)) existing.keys.push(key)
    }
  }

  if (merged.size === 0) {
    throw new TypeError('acquireMany() needs at least one resource request')
  }

  const plan = [...merged.values()]

  // ---- §4.1 step 1.5: does this request contradict itself? ------------------
  // Facets of ONE key never conflict "with themselves": browser:cdp:9222 is
  // supposed to hold its own port facet, so only cross-key pairs are judged
  // (the CLI's rule too). An explicit `shared`/`pool` pair is exempt, because the
  // §3.2 predicate exempts it; a pool is judged as exclusive here, as the CLI does.
  const asCheckedMode = (mode) => (mode === 'pool' ? 'exclusive' : mode)
  for (let i = 0; i < plan.length; i += 1) {
    for (let j = i + 1; j < plan.length; j += 1) {
      const a = plan[i]
      const b = plan[j]
      if (source.get(a.facet) === source.get(b.facet)) continue
      if (!facetsClash(a.facet, asCheckedMode(a.mode), b.facet, asCheckedMode(b.mode))) continue
      const error = new TypeError(
        `The request contradicts itself: ${a.facet} (from ${JSON.stringify(source.get(a.facet))}) `
        + `conflicts with ${b.facet} (from ${JSON.stringify(source.get(b.facet))}); `
        + 'no holder could ever satisfy both, so nothing was acquired. Ask for one of them.',
      )
      throw Object.assign(error, { code: 'LEASE_SELF_CONFLICTING' })
    }
  }

  return plan
    .map((entry) => ({ ...entry, order: orderKey(entry.facet) }))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : (a.facet < b.facet ? -1 : a.facet > b.facet ? 1 : 0)))
    .map(({ order, ...entry }) => entry)
}

// ===========================================================================
// §5 -- reclaiming a dead or expired lease
// ===========================================================================

/**
 * Reclaim one lock file if, and only if, its holder is gone.
 *
 * The three ways a lease becomes takeable, in the order they are checked:
 *   a. unreadable body, older than TAKEOVER_GRACE_MS  -> crashed residue (v1 rule 1)
 *   b. expiresAt in the past                          -> TTL
 *   c. same host, pid gone or pid reused              -> §5, immediate (G3)
 *
 * And the two safety rules that keep this from creating a double holder:
 *   - an unreadable file that is still FRESH is a live writer, not a residue;
 *   - after the rename CAS, the ARCHIVED copy is re-read, and restored if it turns
 *     out to be a live, unexpired lease (v1 rule 2). For the §5 path the archived
 *     copy is judged by liveness instead of the TTL: an unexpired lease whose owner
 *     is dead is exactly what we came to collect.
 *
 * Everything goes through the backend's rename, so two reclaimers racing the same
 * file still produce a single winner.
 *
 * @param {Record<string, any>} backend LeaseBackend.
 * @param {string} lockPath the file to reconsider.
 * @param {Record<string, any>} [options] clock/probe overrides and the meta we already read.
 * @returns {{ reclaimed: boolean, why: string }} what happened, and why.
 */
export function reclaimLock(backend, lockPath, options = {}) {
  const b = assertBackend(backend)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const meta = options.meta !== undefined ? options.meta : b.read(lockPath)

  let why = ''
  let expectedId = null

  if (meta === null) {
    const st = b.stat(lockPath)
    if (!st) return { reclaimed: false, why: 'absent' }
    if (now - st.mtimeMs < TAKEOVER_GRACE_MS) {
      return { reclaimed: false, why: 'unreadable but fresh (a live writer, not a residue)' }
    }
    why = 'unreadable residue older than the takeover grace'
  } else if (isExpired(meta, now)) {
    why = 'ttl expired'
    expectedId = typeof meta.id === 'string' ? meta.id : null
  } else {
    const alive = isOwnerAlive(meta, {
      now,
      host: options.host,
      pidExists: options.pidExists,
      procStartOf: options.procStartOf,
      procStartToleranceMs: options.procStartToleranceMs,
    })
    if (alive !== false) {
      return {
        reclaimed: false,
        why: alive === true ? 'owner alive' : 'owner liveness unknown (cross host or no probe): ttl decides',
      }
    }
    why = 'owner process is gone (dead pid or reused pid)'
    expectedId = typeof meta.id === 'string' ? meta.id : null
  }

  const archived = `${lockPath}.stale.${now}.${process.pid}`
  if (!b.rename(lockPath, archived)) {
    return { reclaimed: false, why: 'lost the takeover race (renamed away by another reclaimer)' }
  }

  // Rule 2 (v1): do not trust our own read. Re-read what we actually moved.
  const archivedMeta = b.read(archived)
  if (archivedMeta !== null && !isExpired(archivedMeta, now)) {
    const stillAlive = isOwnerAlive(archivedMeta, {
      now,
      host: options.host,
      pidExists: options.pidExists,
      procStartOf: options.procStartOf,
      procStartToleranceMs: options.procStartToleranceMs,
    })
    if (stillAlive === true) {
      const name = path.basename(lockPath)
      const owner = ownerInfoOf(archivedMeta).agent ?? '?'
      let restored = false
      if (b.rename(archived, lockPath)) restored = true
      warn(
        restored
          ? `takeover aborted: ${name} is a live lease (owner ${owner}); restored it intact`
          : `takeover aborted: ${name} turned out to be a live lease (owner ${owner}) but could not be restored; see ${path.basename(archived)}`,
      )
      return { reclaimed: false, why: 'archived copy was a live lease; restored' }
    }
  }

  // The index record of the lease we just collected is now noise; drop it so a
  // later `release <old id>` cannot be misread as owning something.
  if (expectedId && typeof b.lockRoot === 'string' && b.lockRoot !== '') removeIndex(b.lockRoot, expectedId)
  if (typeof b.purgeStale === 'function') {
    try {
      b.purgeStale(now)
    } catch {
      /* retention is housekeeping, never a reason to fail a reclaim */
    }
  }
  return { reclaimed: true, why }
}

/**
 * Sweep every lock in the root, reclaiming the leases whose owners are gone (§5
 * "the next observation collects it"). This is what makes `resource_status` and a
 * fresh acquire agree that a crashed owner no longer holds anything.
 *
 * @param {Record<string, any>} backend LeaseBackend.
 * @param {Record<string, any>} [options] clock/probe overrides.
 * @returns {{ scanned: number, reclaimed: string[], kept: number }} summary.
 */
export function sweep(backend, options = {}) {
  const b = assertBackend(backend)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const summary = { scanned: 0, reclaimed: [], kept: 0 }
  for (const entry of b.list()) {
    summary.scanned += 1
    const result = reclaimLock(b, entry.path, { ...options, now, meta: entry.meta })
    if (result.reclaimed) summary.reclaimed.push(entry.path)
    else summary.kept += 1
  }
  return summary
}

// ===========================================================================
// §4.1 -- acquireMany: the multi-facet atomic acquisition
// ===========================================================================

/**
 * The facet THIS FILE represents -- not merely the first facet of its lease.
 *
 * Every facet file repeats the whole lease (`facets` lists all of them), so
 * `facets[0]` is the same string in every file of a multi-facet lease. Using it
 * here made `releasedFacets` report the first facet twice and drop the second one
 * (found by the Lead's probe). `meta.facet` is the file's own facet and always
 * wins; `facets[0]` is only the last resort for a file written by something that
 * knew neither `facet` nor a key.
 *
 * @param {Record<string, any>} meta lock metadata.
 * @returns {string} the facet that file represents.
 */
function facetOfMeta(meta) {
  if (!meta || typeof meta !== 'object') return ''
  if (typeof meta.facet === 'string' && meta.facet !== '') return meta.facet
  if (typeof meta.key === 'string' && meta.key !== '') {
    // A v1 file (index.js / the CLI) has no `facet`: derive its single facet.
    const derived = facetsOf(meta.key)
    if (derived.length > 0) return derived[0]
  }
  const facets = facetsOfMeta(meta)
  return facets.length > 0 ? facets[0] : ''
}

/**
 * Describe a blocker for the §4.3 conflict report.
 *
 * @param {string} facet the facet we wanted.
 * @param {Record<string, any> | null} meta the holder's metadata.
 * @param {number} now reference clock.
 * @returns {{ facet: string, heldBy: Record<string, any>, reason: string, expiresInMs: number | null, mode: string }} conflict row.
 */
function conflictRow(facet, meta, now) {
  const info = ownerInfoOf(meta)
  const expiresAt = Number(meta && meta.expiresAt)
  return {
    facet,
    heldBy: {
      agent: info.agent ?? null,
      session: info.session ?? null,
      pid: info.pid,
      host: info.host ?? null,
    },
    reason: meta && typeof meta.reason === 'string' ? meta.reason : '',
    expiresInMs: Number.isFinite(expiresAt) ? Math.max(0, Math.trunc(expiresAt - now)) : null,
    mode: meta && typeof meta.mode === 'string' ? meta.mode : 'exclusive',
  }
}

/**
 * Build the metadata for ONE facet file of a lease.
 *
 * Every facet file repeats the whole lease (id, facets, paths) so a release or a
 * rollback can find its siblings from any single surviving file even when the
 * `_leases/` index is gone (§4.2). Duplication is a few dozen bytes; a lease that
 * cannot be released after an index loss is a leaked lock.
 *
 * @param {Record<string, any>} input lease-wide fields.
 * @returns {Record<string, any>} lock file body.
 */
function facetMeta(input) {
  const {
    id, key, facet, mode, slots, slot, owner, reason, createdAt, expiresAt, lockPath, facets, paths,
  } = input
  const info = { agent: owner.agent, session: owner.session ?? null, pid: owner.pid, host: owner.host, procStart: owner.procStart ?? null }
  return {
    // --- v1 shape (the CLI and index.js read these) ---
    id,
    key,
    mode,
    slots,
    slot,
    owner: owner.agent,
    reason,
    pid: owner.pid,
    host: owner.host,
    createdAt,
    expiresAt,
    lockPath,
    // --- v2 additions ---
    facet,
    session: owner.session ?? null,
    procStart: owner.procStart ?? null,
    ownerInfo: info,
    facets,
    paths,
    version: 2,
  }
}

/**
 * Try to claim ONE facet, oldest conflict first.
 *
 * Two separate gates, both needed:
 *
 *  1. THE CONFLICT SCAN (§3). Facets are not keys: `browser:instance` must lose to
 *     `browser:profile:work`, `path:D:/out` must lose to `path:D:/out/sub`, and
 *     those live in DIFFERENT files, so O_EXCL alone would happily create both.
 *     Every live lock is therefore compared against the wanted facet with the §3.2
 *     predicate, and a dead/expired one is collected on the spot (§5).
 *  2. THE ATOMIC CLAIM. O_CREAT|O_EXCL on this facet's own file decides who wins
 *     the same exact facet, with a takeover retry when the incumbent is dead.
 *
 * @param {Record<string, any>} backend LeaseBackend.
 * @param {{ facet: string, mode: string, slots: number, keys: string[] }} want plan entry.
 * @param {Record<string, any>} ctx lease-wide context.
 * @returns {{ ok: true, entry: Record<string, any> } | { ok: false, conflict: Record<string, any> }} outcome.
 */
function claimFacet(backend, want, ctx) {
  const { id, owner, reason, ttlMs, now, options } = ctx
  const expiresAt = now + ttlMs

  // ---- gate 1: does a LIVE holder of a conflicting facet exist? ----
  const conflict = findFacetConflict(backend, want, ctx)
  if (conflict) return { ok: false, conflict }

  // ---- gate 2: atomic claim of this facet's file ----
  // A pool tries each slot in turn: "the lowest FREE slot" (§4.1), so a busy slot 0
  // must fall through to slot 1, never end the search. Breaking out of this loop on
  // the first busy slot made a pool of 2 admit exactly one holder -- the pool row of
  // §11 (#12) caught it.
  const capacity = want.mode === 'pool' ? Math.max(1, want.slots) : 1
  let lastBlocker = null
  for (let slot = 0; slot < capacity; slot += 1) {
    const lockPath = backend.pathFor(want.facet, want.mode, slot)
    let slotBlocker = null
    for (let pass = 0; pass < 3; pass += 1) {
      const meta = facetMeta({
        id,
        key: want.keys[0] ?? want.facet,
        facet: want.facet,
        mode: want.mode,
        slots: want.slots,
        slot: want.mode === 'pool' ? slot : undefined,
        owner,
        reason,
        createdAt: now,
        expiresAt,
        lockPath,
        facets: ctx.facets,
        // ONLY the paths this lease has claimed up to and including this one. Listing
        // every candidate slot here named a sibling pool slot that belongs to ANOTHER
        // holder, so releasing this lease found a foreign id on that path and reported
        // the release as incomplete (§11 #12 caught it). The sibling facets claimed
        // before this one are listed; later ones are added when they are claimed.
        paths: [...ctx.claimedPaths, lockPath],
      })
      if (backend.tryCreate(lockPath, meta)) {
        return { ok: true, entry: { facet: want.facet, mode: want.mode, slots: want.slots, slot: want.mode === 'pool' ? slot : null, lockPath } }
      }
      const incumbent = backend.read(lockPath)
      if (incumbent !== null && incumbent.id === id) {
        continue // already ours (a retry after a partial pass)
      }
      const reclaimed = reclaimLock(backend, lockPath, {
        ...options,
        now,
        meta: incumbent,
      })
      if (!reclaimed.reclaimed) {
        slotBlocker = { facet: want.facet, meta: incumbent, why: reclaimed.why, slot }
        break
      }
      // Collected the dead/expired incumbent: one more pass claims the path.
    }
    if (!slotBlocker) {
      // tryCreate kept losing without a reclaim (three takeover passes): the slot is
      // contended by live writers. Report it instead of silently moving on.
      slotBlocker = { facet: want.facet, meta: null, why: 'could not claim the slot after 3 takeover passes', slot }
    }
    if (lastBlocker === null) lastBlocker = slotBlocker
  }

  if (lastBlocker) {
    const meta = lastBlocker.meta
    const row = meta
      ? conflictRow(want.facet, meta, now)
      : { facet: want.facet, heldBy: { agent: null, session: null, pid: null, host: null }, reason: '', expiresInMs: null, mode: want.mode }
    // A pool that found every slot taken must say so ("capacity"), not report the
    // last slot's individual holder as if the whole facet were exclusive.
    const detail = want.mode === 'pool'
      ? `no free slot among ${capacity} (pool capacity exhausted; last slot ${lastBlocker.slot}: ${lastBlocker.why})`
      : lastBlocker.why
    return { ok: false, conflict: { ...row, detail } }
  }
  return {
    ok: false,
    conflict: {
      facet: want.facet,
      heldBy: { agent: null, session: null, pid: null, host: null },
      reason: '',
      expiresInMs: null,
      mode: want.mode,
      detail: `no free slot among ${capacity} (pool capacity exhausted)`,
    },
  }
}

/**
 * Scan every lock in the backend for a LIVE holder whose facets conflict with the
 * one we want (§3.2 + §5).
 *
 * Dead and expired holders met on the way are collected here: a stale conflicting
 * lock must not block a legitimate acquire when its owner is provably gone (G3),
 * and the reclaim is a no-op when another process got there first.
 *
 * @param {Record<string, any>} backend LeaseBackend.
 * @param {{ facet: string, mode: string }} want plan entry.
 * @param {Record<string, any>} ctx lease context.
 * @returns {Record<string, any> | null} a conflict row, or null when free.
 */
function findFacetConflict(backend, want, ctx) {
  const now = ctx.now
  for (const entry of backend.list()) {
    const meta = entry.meta
    if (meta === null) continue
    if (meta.id === ctx.id) continue
    const heldFacets = facetsOfMeta(meta)
    if (heldFacets.length === 0) continue
    const heldMode = typeof meta.mode === 'string' ? meta.mode : 'exclusive'

    let clash = false
    for (const heldFacet of heldFacets) {
      if (facetsClash(want.facet, want.mode, heldFacet, heldMode)) {
        clash = true
        break
      }
    }
    if (!clash) continue

    const alive = isOwnerAlive(meta, {
      now,
      host: ctx.options.host,
      pidExists: ctx.options.pidExists,
      procStartOf: ctx.options.procStartOf,
      procStartToleranceMs: ctx.options.procStartToleranceMs,
    })
    if (alive === false) {
      // Provably gone: collect it and move on. If the CAS loses, another reclaimer
      // won and the live-holder check on the next pass decides.
      reclaimLock(backend, entry.path, { ...ctx.options, now, meta })
      continue
    }
    return conflictRow(want.facet, meta, now)
  }
  return null
}

/**
 * Release everything a partial acquisition took, in REVERSE order (§4.1 step 4),
 * through backend.remove -- which is the ownership-checked delete, never a bare
 * unlink (§11 #15).
 *
 * @param {Record<string, any>} backend LeaseBackend.
 * @param {Array<{ facet: string, lockPath: string }>} acquired entries in acquisition order.
 * @param {string} id our lease id.
 * @returns {{ released: string[], kept: Array<{ facet: string, lockPath: string, onDiskId: string | null }> }} outcome.
 */
function rollback(backend, acquired, id) {
  const released = []
  const kept = []
  for (let i = acquired.length - 1; i >= 0; i -= 1) {
    const entry = acquired[i]
    const onDisk = backend.read(entry.lockPath)
    if (onDisk === null) {
      released.push(entry.facet) // nothing there to release: already gone
      continue
    }
    const onDiskId = typeof onDisk.id === 'string' ? onDisk.id : null
    if (onDiskId !== id) {
      // Someone took this facet over while we were still acquiring. Their lock is
      // NOT ours to delete -- deleting it would be the v1 double-holder accident in
      // reverse: we would silently hand them a lock they do not hold.
      kept.push({ facet: entry.facet, lockPath: entry.lockPath, onDiskId })
      continue
    }
    if (backend.remove(entry.lockPath, id)) released.push(entry.facet)
    else kept.push({ facet: entry.facet, lockPath: entry.lockPath, onDiskId })
  }
  return { released, kept }
}

/**
 * Sleep without yielding the event loop, so a `queue` strategy keeps the whole
 * acquire/release cycle synchronous (the host calls these from synchronous tool
 * handlers, and a lease must never be held across an await it does not control).
 *
 * @param {number} ms how long.
 */
function sleepSync(ms) {
  if (ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* spin */ }
  }
}

/**
 * Acquire a GROUP of facets atomically (§4.1). This is the v2 entry point: one
 * lease id covers every facet, so a release or a crash takes the whole set.
 *
 * ```
 * acquireMany(backend, ["path:D:/out", "port:9222"], { ttlMs, reason, strategy })
 *   -> { ok: true,  id, facets, expiresAt }
 *   -> { ok: false, conflicts: [{ facet, heldBy, reason, expiresInMs, mode }], released }
 * ```
 *
 * The algorithm is the contract's, verbatim:
 *   1. expand every request to facets, merge duplicates (stronger mode wins,
 *      slots max)                                              -- planAcquisition()
 *   2. sort by the global orderKey (§3.4) -- this is the whole no-deadlock proof
 *   3. claim one facet at a time in that order
 *   4. on the first failure, roll the claims back in reverse, ownership-checked
 *   5. only when every facet is held, record the lease and return
 *
 * Invariants this function is responsible for:
 *   G1 two holders never share a conflicting facet (O_EXCL + the §3 scan)
 *   G2 no deadlock (single global order, and a failure always releases)
 *   G3 a dead owner's facet is collected immediately (§5), not after the TTL
 *
 * @param {Record<string, any>} backend LeaseBackend (see localBackend()).
 * @param {unknown} requests one request or an array, §7.1 shapes.
 * @param {Record<string, any>} [options] ttlMs, reason, owner, strategy, waitMs, probes.
 * @returns {Record<string, any>} result object (see above).
 */
export function acquireMany(backend, requests, options = {}) {
  const b = assertBackend(backend)
  const plan = planAcquisition(requests)

  const ttlMs = Number(options.ttlMs)
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`ttlMs must be a positive number of milliseconds; got ${String(options.ttlMs)}`)
  }
  const strategy = options.strategy ?? 'fail'
  if (strategy !== 'fail' && strategy !== 'queue') {
    throw new TypeError(`Unknown strategy '${String(strategy)}'; use "fail" or "queue"`)
  }
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Math.trunc(Number(options.waitMs))) : 0
  const reason = typeof options.reason === 'string' ? options.reason : ''
  const owner = currentOwner(options.owner, {
    agent: options.agent,
    session: options.session,
    pid: options.pid,
    host: options.host,
    procStart: options.procStart,
  })

  const deadline = Date.now() + waitMs
  const facets = plan.map((entry) => entry.facet)

  let lastFailure = null
  for (;;) {
    const now = Date.now()
    const id = newLeaseId()
    /** @type {Array<{ facet: string, mode: string, slots: number, slot: number | null, lockPath: string }>} */
    const acquired = []
    const ctx = {
      id,
      owner,
      reason,
      ttlMs,
      now,
      facets,
      // Grows as facets are claimed: each facet file names the paths claimed so far.
      claimedPaths: [],
      options: {
        host: options.host,
        pidExists: options.pidExists,
        procStartOf: options.procStartOf,
        procStartToleranceMs: options.procStartToleranceMs,
        warn: options.warn,
      },
    }

    let failure = null
    for (const want of plan) {
      const claimed = claimFacet(b, want, { ...ctx, now: Date.now() })
      if (!claimed.ok) {
        failure = claimed
        break
      }
      acquired.push(claimed.entry)
      ctx.claimedPaths = acquired.map((entry) => entry.lockPath)
    }

    if (!failure) {
      // Post-acquisition double-check (§3.1 ancestor/descendant case): two processes
      // that spell one resource differently can both pass the pre-scan on a file
      // layout that only distinguishes EXACT facets, then create two files. Comparing
      // the finished set against every other live lease closes that window: whoever
      // sees the other one retreats, so a double hold cannot survive even though the
      // loser may have to retry (fail) instead of winning.
      const rivals = findRivals(b, id, acquired, { ...ctx, now: Date.now() })
      if (rivals.length > 0) {
        const undone = rollback(b, acquired, id)
        lastFailure = { conflicts: rivals, released: undone.released, kept: undone.kept }
      } else {
        const expiresAt = now + ttlMs
        const primary = acquired[0]
        const record = {
          id,
          key: primary ? (plan[0]?.keys?.[0] ?? primary.facet) : facets[0],
          owner: owner.agent,
          pid: owner.pid,
          path: primary ? primary.lockPath : '',
          version: 2,
          session: owner.session ?? null,
          host: owner.host,
          procStart: owner.procStart ?? null,
          reason,
          mode: primary ? primary.mode : 'exclusive',
          slots: primary ? primary.slots : 1,
          createdAt: now,
          expiresAt,
          paths: acquired.map((entry) => entry.lockPath),
          facets,
          entries: acquired,
        }
        registerLeaseRecord(b, record)
        return {
          ok: true,
          id,
          facets,
          entries: acquired.map((entry) => ({ ...entry })),
          key: record.key,
          mode: primary ? primary.mode : 'exclusive',
          owner,
          reason,
          createdAt: now,
          expiresAt,
          released: [],
        }
      }
    } else {
      const undone = rollback(b, acquired, id)
      lastFailure = {
        conflicts: [failure.conflict],
        released: undone.released,
        kept: undone.kept,
      }
    }

    const remaining = deadline - Date.now()
    if (strategy === 'fail' || remaining <= 0) {
      return {
        ok: false,
        conflicts: lastFailure.conflicts,
        released: lastFailure.released,
        kept: lastFailure.kept,
        facets,
        strategy,
        waitedMs: waitMs - Math.max(0, remaining),
      }
    }
    // Queue: back off, but never sleep past the deadline.
    sleepSync(Math.min(remaining, 50))
  }
}

/**
 * The post-acquisition double-check: does any OTHER live lease hold a facet that
 * conflicts with one we just took?
 *
 * Our own lease id is skipped, which also keeps a pool's sibling slot files from
 * looking like rivals.
 *
 * @param {Record<string, any>} backend LeaseBackend.
 * @param {string} id our lease id.
 * @param {Array<{ facet: string, mode: string }>} acquired what we just took.
 * @param {Record<string, any>} ctx lease context.
 * @returns {Array<Record<string, any>>} conflict rows.
 */
function findRivals(backend, id, acquired, ctx) {
  const rivals = []
  const seen = new Set()
  for (const entry of backend.list()) {
    const meta = entry.meta
    if (meta === null || meta.id === id) continue
    const heldFacets = facetsOfMeta(meta)
    if (heldFacets.length === 0) continue
    const heldMode = typeof meta.mode === 'string' ? meta.mode : 'exclusive'
    for (const mine of acquired) {
      for (const heldFacet of heldFacets) {
        if (!facetsClash(mine.facet, mine.mode, heldFacet, heldMode)) continue
        if (isOwnerAlive(meta, {
          now: ctx.now,
          host: ctx.options.host,
          pidExists: ctx.options.pidExists,
          procStartOf: ctx.options.procStartOf,
          procStartToleranceMs: ctx.options.procStartToleranceMs,
        }) !== true) continue
        const row = conflictRow(mine.facet, meta, ctx.now)
        const fingerprint = `${row.facet}|${row.heldBy.pid}|${row.mode}`
        if (seen.has(fingerprint)) continue
        seen.add(fingerprint)
        rivals.push(row)
      }
    }
  }
  return rivals
}

// ===========================================================================
// §4.2 -- release by lease id
// ===========================================================================

/**
 * Release a lease by id: every facet it holds, ownership-checked.
 *
 * Facet list resolution order, so a lost or torn index can never leak a lock (§4.2):
 *   1. the `_leases/<id>.json` aggregate record
 *   2. the lock files themselves (`meta.id === id`) -- the authoritative source
 *   3. any `paths`/`facets` recorded inside a surviving facet file
 *
 * Each file is deleted through backend.remove(path, id), so a facet that was taken
 * over by another live lease is KEPT and reported (§11 #15). Returning `ok: false`
 * with a `kept` list is the honest answer: this caller no longer holds that facet.
 *
 * @param {Record<string, any>} backend LeaseBackend.
 * @param {string} id lease id.
 * @param {Record<string, any>} [options] reserved (warn sink).
 * @returns {Record<string, any>} { ok, id, released, releasedFacets, kept, missing }.
 */
export function releaseMany(backend, id, options = {}) {
  const b = assertBackend(backend)
  if (!isSafeLeaseId(id)) {
    return { ok: false, id: typeof id === 'string' ? id : null, error: 'invalid lease id', released: [], releasedFacets: [], kept: [], missing: [] }
  }
  const warn = typeof options.warn === 'function' ? options.warn : () => {}

  /** @type {Map<string, string>} lockPath -> facet (best effort) */
  const targets = new Map()
  /**
   * Remember one path to release, with its facet when known.
   *
   * The facet may arrive LATE: the index record's `paths`/`path` carry no facet, and
   * only its `entries` (or the lock file itself) name the facet of each path. So a
   * later call may UPGRADE an empty facet, but must never overwrite a known one --
   * that is how `releasedFacets` ended up repeating the lease's first facet instead
   * of naming `port:9222` (regression found by the Lead's probe).
   *
   * @param {string} lockPath lock file path.
   * @param {string} [facet] this path's own facet, when known.
   */
  const note = (lockPath, facet) => {
    if (typeof lockPath !== 'string' || lockPath === '') return
    const incoming = typeof facet === 'string' ? facet : ''
    const existing = targets.get(lockPath)
    if (existing === undefined) {
      targets.set(lockPath, incoming)
      return
    }
    if (existing === '' && incoming !== '') targets.set(lockPath, incoming)
  }

  const record = readLeaseRecord(b, id)
  if (record) {
    for (const lockPath of pathsOfRecord(record)) note(lockPath, '')
    if (Array.isArray(record.entries)) {
      for (const entry of record.entries) {
        if (entry && typeof entry.lockPath === 'string') note(entry.lockPath, entry.facet)
      }
    }
  }

  // The lock files are the authority (a missing index must change nothing here).
  for (const entry of b.list()) {
    if (entry.meta && entry.meta.id === id) {
      note(entry.path, facetOfMeta(entry.meta))
      for (const sibling of pathsOfRecord(entry.meta)) note(sibling, '')
    }
  }

  const released = []
  const releasedFacets = []
  const kept = []
  const missing = []
  for (const [lockPath, facet] of targets) {
    const onDisk = b.read(lockPath)
    if (onDisk === null) {
      missing.push(lockPath)
      continue
    }
    const onDiskId = typeof onDisk.id === 'string' ? onDisk.id : null
    if (onDiskId !== id) {
      kept.push({ lockPath, facet: facet || facetOfMeta(onDisk), onDiskId, why: 'lease id on disk differs (taken over)' })
      warn(`release ${id}: kept ${path.basename(lockPath)} because it now belongs to ${onDiskId ?? 'an unreadable lease'}`)
      continue
    }
    if (b.remove(lockPath, id)) {
      const ownFacet = facet || facetOfMeta(onDisk)
      released.push(lockPath)
      // One entry per released path, in the same order: `releasedFacets[i]` is the
      // facet of `released[i]`. The basename fallback keeps that true even for a file
      // written by something that recorded no facet and no usable key.
      releasedFacets.push(ownFacet || path.basename(lockPath))
    } else {
      kept.push({ lockPath, facet: facet || facetOfMeta(onDisk), onDiskId, why: 'remove refused' })
    }
  }

  removeLeaseRecord(b, id)
  return {
    ok: kept.length === 0,
    id,
    released,
    releasedFacets,
    kept,
    missing,
    facets: Array.isArray(record?.facets) ? record.facets : [],
  }
}

/**
 * Read-only status of one facet: who holds it, until when, and whether that owner
 * is still alive (§5). Expired or dead holders are reported as `stale`, which is
 * what the next acquire will collect.
 *
 * @param {Record<string, any>} backend LeaseBackend.
 * @param {string} key or facet to inspect.
 * @param {Record<string, any>} [options] clock/probe overrides.
 * @returns {Array<Record<string, any>>} one row per live-or-stale conflicting lock.
 */
export function statusOf(backend, key, options = {}) {
  const b = assertBackend(backend)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const wanted = facetsOf(key)
  const rows = []
  for (const entry of b.list()) {
    const meta = entry.meta
    if (meta === null) {
      rows.push({ facet: '', lockPath: entry.path, holder: null, mode: null, reason: '', expiresInMs: null, stale: true, staleWhy: 'unreadable body' })
      continue
    }
    const heldFacets = facetsOfMeta(meta)
    const match = wanted.length === 0
      || heldFacets.some((heldFacet) => wanted.some((want) => facetsClash(want, 'exclusive', heldFacet, meta.mode ?? 'exclusive')))
    if (!match) continue
    const alive = isOwnerAlive(meta, {
      now,
      host: options.host,
      pidExists: options.pidExists,
      procStartOf: options.procStartOf,
      procStartToleranceMs: options.procStartToleranceMs,
    })
    const expired = isExpired(meta, now)
    rows.push({
      // This FILE's own facet, not the first facet of its lease: a multi-facet lease
      // repeats the whole facet list in every file, so heldFacets[0] would label every
      // row with the same facet (the same trap as releasedFacets, see facetOfMeta).
      facet: facetOfMeta(meta),
      facets: heldFacets,
      lockPath: entry.path,
      id: meta.id ?? null,
      holder: ownerInfoOf(meta),
      mode: meta.mode ?? null,
      slots: meta.slots ?? null,
      slot: meta.slot ?? null,
      reason: meta.reason ?? '',
      expiresInMs: Number.isFinite(Number(meta.expiresAt)) ? Math.max(0, Math.trunc(Number(meta.expiresAt) - now)) : null,
      stale: expired || alive === false,
      staleWhy: expired ? 'ttl expired' : (alive === false ? 'owner process is gone' : ''),
    })
  }
  return rows
}
