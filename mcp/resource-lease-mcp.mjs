#!/usr/bin/env node
/**
 * resource-lease MCP server -- zero dependencies, single file, `npx`-able.
 *
 * Arbitrates exclusive machine resources (browsers, fixed ports, screen
 * focus, shared write targets) between agents that may run in different
 * sessions, different processes, or different harnesses -- and, because the
 * lock files are byte-compatible with the `lease.ps1` CLI, between agents
 * using this server and agents driving the CLI.
 *
 * TRANSPORT
 *   MCP over stdio: newline-delimited JSON-RPC 2.0, one JSON object per line.
 *   stdout carries JSON-RPC and nothing else; every diagnostic goes to stderr.
 *   A log line on stdout would corrupt the stream and hang the client, which
 *   is the single most common way a hand-rolled MCP server breaks.
 *
 * ATOMICITY (the one thing that is easy to get wrong)
 *   A lease is a FILE created with fs.openSync(path, 'wx'), which maps to
 *   open(O_CREAT | O_EXCL): check-and-create is one syscall, so there is no
 *   TOCTOU window.
 *   Do NOT use mkdir / CreateDirectory as the lock. Directory creation is
 *   idempotent, so every racer "succeeds" and mutual exclusion fails
 *   silently. This is a bug that was actually hit during implementation, and
 *   test/02-mutex.test.mjs exists to keep it from coming back.
 *
 * LAYOUT (identical to cli/lease.ps1 and plugin/lib/lock.js)
 *   <lockRoot>/<sanitizedKey>.lock              exclusive / shared
 *   <lockRoot>/<sanitizedKey>.slot-<N>.lock     pool, one file per slot
 *   <lockRoot>/_leases/<leaseId>.json           index: { id, key, path }
 *   <lockRoot>/<name>.lock.stale.<ms>.<pid>     archived takeover (forensics)
 *
 * LOCK FILE BODY (fixed field set, identical to the CLI)
 *   { id, key, mode, slots, slot, owner, reason, pid, host, createdAt,
 *     expiresAt, lockPath }
 *
 * TAKING OVER AN EXPIRED LEASE
 *   Read the lock file -> if expiresAt < now, rename it to
 *   `<lock>.stale.<now>.<pid>`. That rename IS the compare-and-swap: when two
 *   processes race to take over, only the one whose rename succeeds continues;
 *   the other gets ENOENT because the source is already gone.
 *
 * CONFIGURATION
 *   --lock-root <dir>   highest priority
 *   DSH_RESOURCE_LOCK_ROOT
 *   Windows:             %LOCALAPPDATA%\dsh-resource-lease\locks
 *   other platforms:     $XDG_RUNTIME_DIR/dsh-resource-lease/locks
 *   last resort:         <os.tmpdir()>/dsh-resource-lease/locks
 *
 *   DSH_RESOURCE_TTL       default lease TTL, e.g. "30s" (default 30000ms)
 *   DSH_RESOURCE_MAX_WAIT  cap for waitMs (default 120000ms)
 *   DSH_AGENT_NAME         owner name (default "pid:<pid>")
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { randomUUID } from 'node:crypto'

// --------------------------------------------------------------- constants

const SERVER_NAME = 'resource-lease'
const SERVER_VERSION = '1.0.0'

/** Name of the CLI's lease index directory, inside the lock root. */
const INDEX_DIR = '_leases'

/** How long an archived `.stale.` file is kept, in ms (the CLI keeps 1h). */
const STALE_RETENTION_MS = 60 * 60 * 1000

/**
 * How old an UNREADABLE lock file must be before it counts as a crashed
 * residue and may be taken over.
 *
 * A lock file that exists but has no parseable body is what a *live* writer
 * looks like between `openSync(...,'wx')` and its first write. Treating that as
 * "expired" archives a fresh lease and leaves two holders of one lock - the CLI
 * reproduced it under load. A crashed writer stops touching its file, so it
 * ages past this window and stays recoverable.
 */
const TAKEOVER_GRACE_MS = 2000

const MODES = ['exclusive', 'shared', 'pool']

const DEFAULT_TTL_MS = 30000
/** The plugin clamps very small TTLs too; keep the same floor here. */
const MIN_TTL_MS = 1000
const DEFAULT_MAX_WAIT_MS = 120000
/** Poll interval while waiting for a busy resource (the CLI uses 150ms). */
const WAIT_POLL_MS = 150

/** Protocol versions this server can speak, newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

/** JSON-RPC 2.0 error codes we actually emit. */
const RPC_PARSE_ERROR = -32700
const RPC_INVALID_REQUEST = -32600
const RPC_METHOD_NOT_FOUND = -32601
const RPC_INVALID_PARAMS = -32602
const RPC_INTERNAL_ERROR = -32603

// ---------------------------------------------------------------- logging

/**
 * Write one diagnostic line to stderr.
 *
 * stdout belongs to JSON-RPC. Everything an operator might want to read --
 * takeover notices, shutdown notices, client info -- has to go here, or the
 * client's parser will choke on it.
 *
 * @param {string} message text to log.
 */
function log(message) {
  try {
    process.stderr.write(`[${SERVER_NAME}] ${message}\n`)
  } catch {
    /* a closed stderr must never take the server down */
  }
}

// ---------------------------------------------------------- lock primitives

/**
 * Replace every character outside [A-Za-z0-9._-] with '_'.
 *
 * Same rule as the CLI's Get-KeyBase, so both sides compute the same
 * filename for the same resource key. Without this byte-identical mapping,
 * "browser:chromium" would name two different files and the two tools would
 * silently fail to exclude each other.
 *
 * Lowercasing is part of the rule, not a nicety: the protocol says resource
 * keys are lowercase, and without it "Browser:Chromium" and "browser:chromium"
 * become two lock files on a case-sensitive filesystem - no error, no
 * mutual exclusion. (Windows hides this because its filenames are
 * case-insensitive; Linux does not.)
 *
 * @param {unknown} key raw resource key, e.g. "browser:chromium".
 * @returns {string} filesystem-safe key base.
 */
function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase()
}

/**
 * Expand a leading `~` against the home directory.
 *
 * @param {string} value possibly-tilde-prefixed path.
 * @returns {string} path with `~` expanded.
 */
function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/**
 * Resolve the lock root, in the documented priority order.
 *
 * The order matters for interoperability: a user who exports
 * DSH_RESOURCE_LOCK_ROOT expects the CLI *and* every MCP client to land in
 * the same directory, so the environment beats the platform default. An
 * explicit --lock-root beats both, which is what makes side-by-side test
 * sandboxes possible without touching the real environment.
 *
 * @param {string | undefined} explicit value of --lock-root.
 * @param {NodeJS.ProcessEnv} [env] environment to read.
 * @returns {string} absolute lock root.
 */
function resolveLockRoot(explicit, env = process.env) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return path.resolve(expandHome(explicit.trim()))
  }

  const fromEnv = env.DSH_RESOURCE_LOCK_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return path.resolve(expandHome(fromEnv.trim()))
  }

  if (process.platform === 'win32') {
    const localAppData = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim() !== ''
      ? env.LOCALAPPDATA.trim()
      : path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'dsh-resource-lease', 'locks')
  }

  const runtimeDir = env.XDG_RUNTIME_DIR
  if (typeof runtimeDir === 'string' && runtimeDir.trim() !== '') {
    return path.join(runtimeDir.trim(), 'dsh-resource-lease', 'locks')
  }

  return path.join(os.tmpdir(), 'dsh-resource-lease', 'locks')
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
function lockPathFor(lockRoot, key, mode, slot) {
  const base = sanitizeKey(key)
  if (mode === 'pool') return path.join(lockRoot, `${base}.slot-${slot}.lock`)
  return path.join(lockRoot, `${base}.lock`)
}

/**
 * A lease id in the CLI's shape: `lz_` + 12 lowercase hex characters.
 *
 * @returns {string} fresh lease id.
 */
function newLeaseId() {
  return 'lz_' + randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * Create the lock root if needed.
 *
 * @param {string} lockRoot lock directory.
 */
function ensureLockRoot(lockRoot) {
  fs.mkdirSync(lockRoot, { recursive: true })
}

/**
 * Read and parse one lock file.
 *
 * Unreadable or half-written files read as null. isExpired() still treats null
 * as expired, but tryTakeoverLock() does NOT take over on that basis alone: it
 * also requires the file to be older than TAKEOVER_GRACE_MS. A file that a
 * crashed writer left empty must not become a permanent lock, and a file that a
 * live writer is still filling must not be stolen. The mtime tells them apart.
 *
 * @param {string} lockPath lock file path.
 * @returns {Record<string, any> | null} parsed metadata, or null.
 */
function readMeta(lockPath) {
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
 * Age of a lock file in ms, or -1 when it is gone.
 *
 * @param {string} lockPath lock file path.
 * @returns {number} milliseconds since the last write, or -1.
 */
function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs
  } catch {
    return -1
  }
}

/**
 * Whether a lease is past its TTL. Missing metadata counts as expired here,
 * but callers that ACT on that (tryTakeoverLock) must additionally check the
 * file's age: null means "unreadable", which is also what a live writer looks
 * like for a few milliseconds.
 *
 * `expiresAt < now` (strict) is what both the CLI and the plugin compare, so
 * a lease is never expired "one millisecond early" on one side only.
 *
 * @param {Record<string, any> | null} meta parsed metadata.
 * @param {number} now current epoch ms.
 * @returns {boolean} true when the lease may be taken over.
 */
function isExpired(meta, now) {
  if (!meta) return true
  const expiresAt = Number(meta.expiresAt)
  if (!Number.isFinite(expiresAt)) return true
  return expiresAt < now
}

/**
 * The one and only atomic grab: create the lock file, or fail because it exists.
 *
 * fs.openSync(lockPath, 'wx') is O_CREAT|O_EXCL|O_WRONLY, so check-and-create
 * is a single syscall with no TOCTOU window -- the only portable primitive
 * that decides success/failure in one call.
 *
 * The metadata is written through the same descriptor immediately, so a
 * concurrent reader never sees a file that was created and then left empty.
 * If writing fails, the half-made lock is removed so it cannot linger.
 *
 * @param {string} lockPath lock file path.
 * @param {Record<string, any>} meta lease metadata to persist as JSON.
 * @returns {boolean} true when this caller created the lock.
 */
function tryAcquireLock(lockPath, meta) {
  let fd
  try {
    fd = fs.openSync(lockPath, 'wx')
  } catch (err) {
    if (err && err.code === 'EEXIST') return false
    // ENOENT (lock root vanished) and permission problems are real failures;
    // surface them instead of pretending the resource is merely busy.
    throw err
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(meta))
    return true
  } catch (err) {
    try {
      fs.rmSync(lockPath, { force: true })
    } catch {
      /* nothing else to do: the file is unreadable and therefore takeable */
    }
    throw err
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* closing a descriptor that is already gone is not a lease problem */
    }
  }
}

/**
 * Move a lock file aside. This rename IS the compare-and-swap.
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
    // ENOENT: another process won the race and already moved it.
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
function purgeStale(lockRoot, now) {
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
      // lock path (see tryTakeoverLock), which plain rmSync refuses to remove.
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
 * lock, which is the failure this server exists to make impossible (and the CLI
 * hit it under load):
 *
 *   1. An unreadable lock file is NOT takeable on its own. A file with no
 *      parseable body is almost always a live writer between open and its first
 *      write. It only becomes takeable once its mtime is older than
 *      TAKEOVER_GRACE_MS, which is a crashed residue rather than a writer in
 *      flight.
 *   2. Do not trust our own read. After the rename, re-read the ARCHIVED copy:
 *      if it turns out to be a valid, unexpired lease we grabbed a live lock
 *      that its owner had just finished writing, so put it back.
 *
 * @param {string} lockPath lock file path.
 * @param {number} now current epoch ms.
 * @param {number} pid current process id.
 * @returns {boolean} true when the expired lease was moved aside.
 */
function tryTakeoverLock(lockPath, now, pid) {
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
    // We archived a live lease whose owner was still writing it. Undo it.
    let restored = false
    try {
      fs.renameSync(archived, lockPath)
      restored = true
    } catch {
      /* a third process may have created a new lock already */
    }
    const name = path.basename(lockPath)
    const owner = typeof archivedMeta.owner === 'string' ? archivedMeta.owner : '?'
    log(
      restored
        ? `takeover aborted: ${name} is a live lease (owner ${owner}); restored it intact`
        : `takeover aborted: ${name} turned out to be a live lease (owner ${owner}) but could not be restored; see ${path.basename(archived)}`,
    )
    return false
  }

  const previousOwner = meta && meta.owner ? meta.owner : '?'
  log(`took over an expired lease: ${path.basename(lockPath)} (previous owner ${previousOwner})`)
  purgeStale(path.dirname(lockPath), now)
  return true
}

/**
 * Delete one lock file. Missing files are not an error: TTL expiry and
 * takeover both remove the file behind a lease's back.
 *
 * @param {string} lockPath lock file path.
 * @returns {boolean} true when the file is gone afterwards.
 */
function removeLock(lockPath) {
  try {
    fs.rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Whether an id is safe to use as an index filename.
 *
 * Rejects anything the lock filename rule would rewrite, which blocks path
 * traversal through `resource_release(id)` while still accepting every id the
 * CLI can produce. Deliberately independent of the lowercasing in sanitizeKey:
 * an id is a plain filename, not a resource key.
 *
 * @param {unknown} id candidate lease id.
 * @returns {boolean} true when the id is a plain filename.
 */
function isSafeLeaseId(id) {
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
 * Record a lease in the CLI's index.
 *
 * This is what lets `lease.ps1 release <id>` and `lease.ps1 release --all
 * -Owner <name>` find a lease created here. The lock file stays
 * authoritative; a failed index write must not fail the acquire.
 *
 * @param {string} lockRoot lock directory.
 * @param {Record<string, any>} meta lease metadata.
 */
function registerIndex(lockRoot, meta) {
  try {
    fs.mkdirSync(indexDir(lockRoot), { recursive: true })
    fs.writeFileSync(
      indexFile(lockRoot, meta.id),
      JSON.stringify({ id: meta.id, key: meta.key, path: meta.lockPath }),
    )
  } catch {
    /* the index is a convenience for the CLI, not part of mutual exclusion */
  }
}

/**
 * Read one index record.
 *
 * @param {string} lockRoot lock directory.
 * @param {string} id lease id.
 * @returns {{ id?: string, key?: string, path?: string } | null} record or null.
 */
function readIndex(lockRoot, id) {
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
function removeIndex(lockRoot, id) {
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
function listIndex(lockRoot) {
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
 * Read every live lock file in the lock root, including the ones held by the
 * CLI, by other MCP clients, and by other harness instances.
 *
 * @param {string} lockRoot lock directory.
 * @returns {Array<Record<string, any>>} metadata of every readable lock.
 */
function listLocks(lockRoot) {
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
 * Numbers are milliseconds, because every tool argument that uses this is
 * named `*Ms`. Strings accept the CLI's suffixes -- "500ms", "30s", "2m",
 * "1h" -- and a bare numeric string is milliseconds here, since the argument
 * name already carries the unit. (The CLI's own `-Ttl 30` means seconds;
 * that divergence is older than this file and only affects the CLI's flag,
 * never the lock format.)
 *
 * @param {unknown} value number, duration string, or undefined.
 * @param {number} fallback value used when absent or unparseable.
 * @returns {number} non-negative integer milliseconds.
 */
function toMs(value, fallback) {
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

/**
 * Render one lease as a compact phrase, e.g. `pool slot 2/4, 12s left`.
 *
 * @param {Record<string, any>} meta lease metadata.
 * @param {number} now current epoch ms.
 * @returns {string} one-line description.
 */
function describeLease(meta, now) {
  const modeText = meta.mode === 'pool'
    ? `pool slot ${Number(meta.slot) + 1}/${Number(meta.slots)}`
    : String(meta.mode ?? 'exclusive')
  const remaining = Number(meta.expiresAt) - now
  const remainText = remaining > 0 ? `${Math.ceil(remaining / 1000)}s left` : 'expired, takeable'
  return `${modeText}, ${remainText}`
}

// ------------------------------------------------------------------ errors

/**
 * A tool-level failure the model can act on.
 *
 * Carried back to the client as an MCP result with `isError: true`, NOT as a
 * thrown process-level error: an uncaught exception here would kill the
 * server and every lease it holds, turning a busy resource into a dead tool.
 */
class LeaseError extends Error {
  /**
   * @param {string} message actionable message (who holds it, how long left).
   * @param {string} [code] short machine-readable code.
   */
  constructor(message, code = 'LEASE_ERROR') {
    super(message)
    this.name = 'LeaseError'
    this.code = code
  }
}

// ----------------------------------------------------------- lease manager

/**
 * Build the lease manager: the only component that decides who holds what.
 *
 * @param {{ lockRoot: string, owner: string, defaultTtlMs: number, maxWaitMs: number }} config resolved configuration.
 */
function createLeaseManager(config) {
  const { lockRoot, owner, defaultTtlMs, maxWaitMs } = config

  /** Leases this process holds: lease id -> metadata. */
  const held = new Map()

  /**
   * Sleeping waiters, so shutdown can cut a long `waitMs` short.
   *
   * A plain setTimeout would keep the event loop alive: if the client
   * disconnects while an acquire is queueing, the process would linger for up
   * to `maxWaitMs` (120s by default) with nobody to answer. Tracking the
   * timers lets close() cancel and settle them, so the process exits as soon
   * as stdin ends.
   */
  const waiters = new Set()
  let stopped = false

  /**
   * Wait `ms`, or return immediately if the manager has been stopped.
   *
   * @param {number} ms delay.
   * @returns {Promise<void>} resolves after the delay or on shutdown.
   */
  function sleep(ms) {
    return new Promise((resolve) => {
      const entry = { timer: null, resolve }
      entry.timer = setTimeout(() => {
        waiters.delete(entry)
        resolve()
      }, ms)
      waiters.add(entry)
    })
  }

  /**
   * Cancel every pending wait and stop accepting new ones.
   * Called on shutdown, before the leases are handed back.
   */
  function close() {
    stopped = true
    for (const entry of [...waiters]) {
      clearTimeout(entry.timer)
      waiters.delete(entry)
      entry.resolve()
    }
  }

  /**
   * Try to take one lease without waiting.
   *
   * @param {{ key: string, mode: string, slots: number, ttlMs: number, owner: string, reason: string }} spec what to take.
   * @returns {Record<string, any> | null} the lease, or null when busy.
   */
  function attempt(spec) {
    for (let slot = 0; slot < spec.slots; slot += 1) {
      // Two passes per slot: the first fails because the file exists, the
      // second runs after an expired holder was moved aside.
      for (let pass = 0; pass < 2; pass += 1) {
        const lockPath = lockPathFor(lockRoot, spec.key, spec.mode, slot)
        const createdAt = Date.now()
        const meta = {
          id: newLeaseId(),
          key: spec.key,
          mode: spec.mode,
          slots: spec.slots,
          slot,
          owner: spec.owner,
          reason: spec.reason,
          pid: process.pid,
          host: os.hostname(),
          createdAt,
          expiresAt: createdAt + spec.ttlMs,
          lockPath,
        }
        if (tryAcquireLock(lockPath, meta)) {
          registerIndex(lockRoot, meta)
          held.set(meta.id, meta)
          return meta
        }
        if (!tryTakeoverLock(lockPath, createdAt, process.pid)) break
      }
    }
    return null
  }

  /**
   * Describe who is blocking a key, for the busy error.
   *
   * A bare "busy" is useless to a model: it either retries blindly or gives
   * up. Naming the holder, the reason and the remaining time is what lets it
   * decide between waiting and picking a different resource.
   *
   * @param {string} key resource key.
   * @param {string} mode arbitration mode.
   * @param {number} slots slot count.
   * @returns {string} human-readable holder list.
   */
  function describeHolders(key, mode, slots) {
    const now = Date.now()
    const holders = []
    for (let slot = 0; slot < slots; slot += 1) {
      const meta = readMeta(lockPathFor(lockRoot, key, mode, slot))
      if (meta === null) continue
      const who = meta.owner ?? 'unknown'
      const reason = meta.reason ? `, reason: ${meta.reason}` : ''
      const pid = meta.pid !== undefined ? `, pid ${meta.pid}` : ''
      holders.push(`${who} (${describeLease(meta, now)}${pid}${reason})`)
    }
    return holders.length > 0 ? holders.join('; ') : 'an unidentified holder'
  }

  /**
   * Acquire a lease, waiting up to `waitMs` for a busy resource.
   *
   * @param {{ key?: unknown, mode?: unknown, slots?: unknown, ttlMs?: unknown, waitMs?: unknown, reason?: unknown }} req lease request.
   * @returns {Promise<{ meta: Record<string, any>, waitedMs: number }>} the acquired lease.
   */
  async function acquire(req = {}) {
    const key = typeof req.key === 'string' ? req.key.trim() : ''
    if (key === '') {
      throw new LeaseError(
        'resource_acquire needs "key": the resource to lease, category:specific. Examples: "browser:chromium", "browser:profile:main", "port:9222", "screen:focus", "dir:src/parser", "repo:root".',
        'BAD_KEY',
      )
    }

    const reason = typeof req.reason === 'string' ? req.reason.trim() : ''
    if (reason === '') {
      throw new LeaseError(
        `resource_acquire needs "reason": a short phrase telling other agents what you are about to do with "${key}" (e.g. "capture checkout screenshots"). It is shown to them while you hold the lease.`,
        'BAD_REASON',
      )
    }

    if (req.mode !== undefined && req.mode !== null && !MODES.includes(req.mode)) {
      throw new LeaseError(
        `"mode" must be one of ${MODES.map((m) => `"${m}"`).join(', ')} (got ${JSON.stringify(req.mode)}). Omit it for "exclusive".`,
        'BAD_MODE',
      )
    }
    if (req.slots !== undefined && req.slots !== null && (!Number.isFinite(Number(req.slots)) || Number(req.slots) < 1)) {
      throw new LeaseError(
        `"slots" must be a positive whole number (got ${JSON.stringify(req.slots)}). It only matters for mode "pool".`,
        'BAD_SLOTS',
      )
    }

    const mode = MODES.includes(req.mode) ? req.mode : 'exclusive'
    const slots = mode === 'pool' ? Math.max(1, Math.trunc(Number(req.slots) || 1)) : 1
    const ttlMs = Math.max(MIN_TTL_MS, toMs(req.ttlMs, defaultTtlMs))
    const waitMs = Math.min(maxWaitMs, toMs(req.waitMs, 0))
    const spec = { key, mode, slots, ttlMs, owner, reason }

    ensureLockRoot(lockRoot)
    const started = Date.now()
    const deadline = started + waitMs

    for (;;) {
      const acquired = attempt(spec)
      if (acquired !== null) return { meta: acquired, waitedMs: Date.now() - started }

      if (Date.now() >= deadline) {
        throw new LeaseError(
          `Resource busy: ${key} - held by ${describeHolders(key, mode, slots)}. `
          + 'Wait for the holder to release it (or let its TTL expire), then acquire again. '
          + 'Pass waitMs to queue instead of failing immediately; do not retry in a loop.',
          'RESOURCE_BUSY',
        )
      }
      await sleep(WAIT_POLL_MS)
      if (stopped) {
        // The client went away mid-wait: say so plainly instead of letting the
        // caller believe a lease might still be taken.
        throw new LeaseError(
          `The MCP server is shutting down, so the lease on "${key}" was NOT acquired and nothing is held. `
          + 'Call resource_acquire again from a live session.',
          'SHUTDOWN',
        )
      }
    }
  }

  /**
   * Release one lease by id.
   *
   * Ownership is enforced three times, because a release that deletes someone
   * else's lock is a correctness bug, not an inconvenience:
   *   1. in memory, against this process's `held` map;
   *   2. against the `pid` field, which covers a lease taken before a restart;
   *   3. against the lock file's own `id`, which covers a lease that EXPIRED
   *      and was taken over by another process while this one still had it in
   *      memory. Without check 3 this method would delete the new holder's
   *      file: the in-memory record and the on-disk file would disagree, and
   *      the delete would win. The lock file is authoritative, so a record
   *      whose id no longer matches it is dropped, not acted on.
   *
   * @param {string} id lease id.
   * @param {{ force?: boolean }} [options] force skips the pid/id checks (CLI-compatible cleanup).
   * @returns {boolean} true when this caller's lock file was actually removed.
   */
  function releaseById(id, options = {}) {
    if (typeof id !== 'string' || id === '') return false
    const force = options.force === true

    /** Remove a lock file only when it still belongs to `id`. */
    const removeIfOurs = (lockPath) => {
      const onDisk = readMeta(lockPath)
      if (!force) {
        if (onDisk === null) return false
        // Fail closed: only an exact string id match may delete. A lock file
        // that parses but carries no string id (`{}`, `{"id":123}`, written by
        // another tool) is not provably ours, so it is not ours to remove.
        if (typeof onDisk.id !== 'string' || onDisk.id !== id) return false
      }
      return removeLock(lockPath)
    }

    const meta = held.get(id)
    if (meta !== undefined) {
      if (!force && Number(meta.pid) !== process.pid) return false
      const removed = removeIfOurs(meta.lockPath)
      removeIndex(lockRoot, id)
      held.delete(id)
      if (!removed) log(`lease ${id} was taken over by another holder; dropped the stale local record`)
      return removed
    }

    // Not in memory: this process may have taken the lease before a restart,
    // so fall back to the shared index -- but only for our own leases.
    const record = readIndex(lockRoot, id)
    if (record === null) return false
    const lockPath = typeof record.path === 'string' ? record.path : ''
    if (lockPath === '') return false
    const onDisk = readMeta(lockPath)
    if (!force && (onDisk === null || Number(onDisk.pid) !== process.pid)) return false
    if (force && onDisk === null) {
      removeIndex(lockRoot, id)
      return false
    }
    const removed = removeIfOurs(lockPath)
    removeIndex(lockRoot, id)
    return removed
  }

  /**
   * Release every lease this manager holds, optionally only for one key.
   *
   * @param {string} [key] restrict to one resource key.
   * @returns {string[]} ids that were released.
   */
  function releaseHeld(key) {
    const released = []
    for (const [id, meta] of [...held]) {
      if (key !== undefined && meta.key !== key) continue
      if (releaseById(id)) released.push(id)
    }
    // Also catch leases this process acquired before a restart.
    for (const record of listIndex(lockRoot)) {
      if (typeof record.id !== 'string' || held.has(record.id) || released.includes(record.id)) continue
      const lockPath = typeof record.path === 'string' ? record.path : ''
      if (lockPath === '') continue
      const meta = readMeta(lockPath)
      if (meta === null || Number(meta.pid) !== process.pid) continue
      if (key !== undefined && meta.key !== key) continue
      if (releaseById(record.id)) released.push(record.id)
    }
    return released
  }

  /**
   * List every live lease in the lock root, oldest key first.
   *
   * @param {{ includeExpired?: boolean, key?: string }} [options] listing options.
   * @returns {Array<Record<string, any>>} leases with derived fields.
   */
  function list(options = {}) {
    const now = Date.now()
    const rows = []
    for (const meta of listLocks(lockRoot)) {
      if (options.key !== undefined && meta.key !== options.key) continue
      const expired = isExpired(meta, now)
      if (expired && options.includeExpired !== true) continue
      rows.push({
        id: meta.id,
        key: meta.key,
        mode: meta.mode,
        slot: meta.slot,
        slots: meta.slots,
        owner: meta.owner,
        reason: meta.reason,
        pid: meta.pid,
        host: meta.host,
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        lockPath: meta.lockPath,
        expired,
        remainingMs: Math.max(0, Number(meta.expiresAt) - now),
        mine: held.has(meta.id),
      })
    }
    rows.sort((a, b) => String(a.key).localeCompare(String(b.key)) || Number(a.slot) - Number(b.slot))
    return rows
  }

  return { lockRoot, owner, acquire, releaseById, releaseHeld, list, close }
}

// ------------------------------------------------------------------- tools

/**
 * The three model-facing tools.
 *
 * Descriptions are the model's only instructions, so they name the concrete
 * resources that need a lease and the release obligation. `inputSchema` and
 * `outputSchema` mirror the reference CLI's tool definitions
 * (cli/lease.ps1) so an agent moving between the CLI and this server sees the
 * same contract.
 *
 * @param {ReturnType<typeof createLeaseManager>} manager lease manager.
 * @returns {Array<Record<string, any>>} tool definitions.
 */
function buildTools(manager) {
  return [
    {
      name: 'resource_acquire',
      description:
        'Take a lease on a machine resource BEFORE using it. Use this whenever the work touches something only one agent may touch at a time: '
        + 'a browser, Playwright/Chromium instance or its user-data-dir; a fixed port (dev server, debug port, WebSocket); '
        + 'screen or input focus (driving the real desktop, taking desktop screenshots, sending keystrokes); '
        + 'or a shared write target (a directory, repository, or output folder other agents also write to). '
        + 'Leases are files under a lock root shared with the resource-lease CLI, so agents using the CLI and agents using this server exclude each other. '
        + 'Acquire, do the work, then call resource_release; the lease also expires by TTL, so a crashed holder cannot block a resource forever. '
        + 'If the resource is busy the error names the current holder, its reason, and the remaining time.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'Resource key, category:specific. Examples: "browser:chromium", "browser:profile:main", "port:9222", "screen:focus", "dir:src/parser", "repo:root". '
              + 'Keys are sanitized to [A-Za-z0-9._-] and lowercased for the lock filename, so "Browser:Chromium" and "browser:chromium" are the same resource (and "browser:chromium" and "browser_chromium" collide too).',
          },
          reason: {
            type: 'string',
            description:
              'Short phrase telling other agents what you are about to do with the resource, e.g. "capture checkout screenshots". '
              + 'It is shown to them while you hold the lease, so keep it accurate and specific.',
          },
          mode: {
            type: 'string',
            enum: MODES,
            description:
              'Arbitration mode: "exclusive" (one holder, the default), "shared" (declares read-only intent; still one holder on disk, exactly like the CLI), '
              + 'or "pool" (one holder per slot). Omit to use "exclusive".',
          },
          slots: {
            type: 'number',
            description:
              'Concurrent holders for mode "pool" (default 1). Ignored by the other modes. '
              + 'All agents must agree on this number for a key: it decides how many slot files exist.',
          },
          ttlMs: {
            // number OR a duration string ("5m"): the docs teach the string
            // form, and a schema that says only "number" makes strict clients
            // reject the call before it is ever sent.
            oneOf: [{ type: 'number' }, { type: 'string' }],
            description:
              'Lease lifetime in milliseconds (default 30000). Also accepts a duration string: "30s" / "2m" / "1h" / "500ms". '
              + 'A lease that is not released expires and becomes takeable, so this is your crash protection: keep it comfortably longer than the work.',
          },
          waitMs: {
            oneOf: [{ type: 'number' }, { type: 'string' }],
            description:
              'How long to wait for a busy resource before giving up, in milliseconds (default 0 = fail immediately). Also accepts "30s" / "2m".',
          },
        },
        required: ['key', 'reason'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Lease id to pass to resource_release.' },
          key: { type: 'string', description: 'The resource key that was leased.' },
          mode: { type: 'string', description: 'Mode that was used.' },
          slot: { type: 'number', description: 'Zero-based slot index; meaningful for mode "pool".' },
          slots: { type: 'number', description: 'Total slots in the pool.' },
          owner: { type: 'string', description: 'Owner recorded on the lease.' },
          reason: { type: 'string', description: 'Reason recorded on the lease.' },
          expiresAt: { type: 'number', description: 'Epoch milliseconds at which the lease expires on its own.' },
          ttlMs: { type: 'number', description: 'Effective lease lifetime in milliseconds.' },
          waitedMs: { type: 'number', description: 'How long the acquire waited before succeeding.' },
          lockPath: { type: 'string', description: 'The lock file that holds this lease.' },
        },
        required: ['id', 'key', 'mode', 'slot', 'slots', 'owner', 'reason', 'expiresAt', 'ttlMs', 'waitedMs', 'lockPath'],
        additionalProperties: false,
      },
      /**
       * @param {Record<string, any>} args tool arguments.
       * @returns {Promise<Record<string, any>>} structured tool result.
       */
      async execute(args) {
        const { meta, waitedMs } = await manager.acquire({
          key: args.key,
          mode: args.mode,
          slots: args.slots,
          ttlMs: args.ttlMs,
          waitMs: args.waitMs,
          reason: args.reason,
        })
        const value = {
          id: String(meta.id),
          key: String(meta.key),
          mode: String(meta.mode),
          slot: Number(meta.slot),
          slots: Number(meta.slots),
          owner: String(meta.owner ?? ''),
          reason: String(meta.reason ?? ''),
          expiresAt: Number(meta.expiresAt),
          ttlMs: Number(meta.expiresAt) - Number(meta.createdAt),
          waitedMs,
          lockPath: String(meta.lockPath ?? ''),
        }
        const pool = value.mode === 'pool' ? ` slot ${value.slot + 1}/${value.slots}` : ''
        value.text = `Lease ${value.id} acquired on "${value.key}" (${value.mode}${pool}), owner ${value.owner}, `
          + `expires in ${Math.round(value.ttlMs / 1000)}s. Call resource_release with id="${value.id}" when the work is done.`
        return value
      },
    },
    {
      name: 'resource_release',
      description:
        'Release a resource lease you hold, so another agent can use the resource now instead of waiting for your TTL to expire. '
        + 'Call it as soon as the work that needed the resource is done, including on the failure path: a lease you leave behind blocks other agents until it expires. '
        + 'Pass "id" for one lease, "key" to release every lease you hold on that resource, or "all" to release everything you hold. '
        + 'Only leases this server process holds can be released here; use the lease.ps1 CLI for leases held by other processes.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Lease id returned by resource_acquire. Releases exactly that lease.' },
          key: { type: 'string', description: 'Resource key. Releases every lease you hold on that resource.' },
          all: { type: 'boolean', description: 'Release every lease you hold, on every resource.' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          released: { type: 'number', description: 'Number of leases released.' },
          ids: { type: 'string', description: 'Comma-separated ids that were released (empty when none).' },
          text: { type: 'string', description: 'Human-readable summary.' },
        },
        required: ['released', 'ids', 'text'],
        additionalProperties: false,
      },
      /**
       * @param {Record<string, any>} args tool arguments.
       * @returns {Promise<Record<string, any>>} structured tool result.
       */
      async execute(args) {
        const released = []
        if (args.all === true) {
          released.push(...manager.releaseHeld())
        } else if (typeof args.id === 'string' && args.id !== '') {
          if (manager.releaseById(args.id)) released.push(args.id)
          else {
            throw new LeaseError(
              `No lease "${args.id}" is currently held by this server process. It was either already released, `
              + 'or its TTL expired and another holder took the resource over (the new holder\'s lease was deliberately left alone). '
              + 'Call resource_status to see the leases that exist; a lease held by another process or by the lease.ps1 CLI cannot be released here.',
              'NOT_HELD',
            )
          }
        } else if (typeof args.key === 'string' && args.key !== '') {
          released.push(...manager.releaseHeld(args.key))
        } else {
          throw new LeaseError('Nothing to release: pass "id", "key", or all=true.', 'BAD_ARGS')
        }

        const text = released.length === 0
          ? 'No leases released: this server process holds no matching lease.'
          : `Released ${released.length} lease${released.length === 1 ? '' : 's'}: ${released.join(', ')}.`
        return { released: released.length, ids: released.join(','), text }
      },
    },
    {
      name: 'resource_status',
      description:
        'List the resource leases that are live right now, including the ones other agents and the resource-lease CLI hold. '
        + 'Use it before planning work that needs a scarce resource (to see whether a browser, port, or write target is free), '
        + 'and when an acquire reports the resource is busy (to see who holds it, why, and how long it will keep it). '
        + 'Leases held by this server process are marked; expired leases are hidden unless includeExpired is set.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Only show leases for this resource key.' },
          includeExpired: {
            type: 'boolean',
            description: 'Also show expired leases that are already takeable but whose lock file still exists.',
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of leases listed.' },
          lockRoot: { type: 'string', description: 'Directory holding the lock files; the CLI must use the same one.' },
          text: { type: 'string', description: 'The formatted lease table.' },
        },
        required: ['count', 'lockRoot', 'text'],
        additionalProperties: false,
      },
      /**
       * @param {Record<string, any>} args tool arguments.
       * @returns {Promise<Record<string, any>>} structured tool result.
       */
      async execute(args) {
        const filter = typeof args.key === 'string' && args.key !== '' ? args.key : undefined
        const rows = manager.list({ includeExpired: args.includeExpired === true, key: filter })
        const now = Date.now()
        const lines = rows.map((row) => {
          const who = row.owner === manager.owner ? 'you' : `owner ${row.owner ?? 'unknown'}`
          const reason = row.reason ? `, reason: ${row.reason}` : ''
          const id = row.mine ? `, id ${row.id}` : ''
          return `- ${row.key}: ${describeLease(row, now)}, ${who}${reason}${id}`
        })
        const text = rows.length === 0
          ? `No live leases${filter === undefined ? '' : ` for "${filter}"`}. Lock root: ${manager.lockRoot}`
          : `Live resource leases (lock root ${manager.lockRoot}):\n${lines.join('\n')}`
        return { count: rows.length, lockRoot: manager.lockRoot, text }
      },
    },
  ]
}

// ------------------------------------------------------------- JSON-RPC I/O

/**
 * Project a tool's return value onto its declared `outputSchema`.
 *
 * `structuredContent` must match `outputSchema` exactly -- a client that
 * validates it would reject an undeclared field, and resource_acquire's
 * output schema deliberately has no `text` field (its readable summary lives
 * only in `content`). Filtering by the declared properties keeps the two in
 * lockstep without a second hand-maintained list.
 *
 * @param {Record<string, any>} tool tool definition with an outputSchema.
 * @param {Record<string, any>} value tool return value.
 * @returns {Record<string, any>} schema-conforming structured content.
 */
function projectStructured(tool, value) {
  const properties = tool.outputSchema && typeof tool.outputSchema.properties === 'object'
    ? tool.outputSchema.properties
    : {}
  const out = {}
  for (const key of Object.keys(properties)) {
    if (value[key] !== undefined) out[key] = value[key]
  }
  return out
}

/**
 * Write one JSON-RPC message as a single line on stdout.
 *
 * JSON.stringify escapes embedded newlines, so a multi-line tool result still
 * occupies exactly one physical line -- which is what the newline-delimited
 * framing requires.
 *
 * @param {Record<string, any>} message message to send.
 * @returns {boolean} true when it was written.
 */
function writeMessage(message) {
  try {
    process.stdout.write(JSON.stringify(message) + '\n')
    return true
  } catch {
    // The client is gone (EPIPE). Nothing left to talk to.
    return false
  }
}

/**
 * @param {string | number | null} id request id to echo.
 * @param {number} code JSON-RPC error code.
 * @param {string} message error message.
 * @param {Record<string, any>} [data] optional structured detail.
 * @returns {Record<string, any>} a JSON-RPC error response.
 */
function errorResponse(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id ?? null, error }
}

/**
 * @param {string | number | null} id request id to echo.
 * @param {Record<string, any>} result result payload.
 * @returns {Record<string, any>} a JSON-RPC success response.
 */
function resultResponse(id, result) {
  return { jsonrpc: '2.0', id, result }
}

// --------------------------------------------------------------- the server

/**
 * Start the MCP server on stdio. Never returns: the process lives as long as
 * stdin does.
 *
 * @param {{ lockRoot: string, owner: string, defaultTtlMs: number, maxWaitMs: number, version: boolean }} config resolved configuration.
 */
function startServer(config) {
  const manager = createLeaseManager(config)
  const tools = buildTools(manager)
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))

  /** Protocol version negotiated during initialize (echoed per request otherwise). */
  let protocolVersion = LATEST_PROTOCOL_VERSION
  let initialized = false

  /**
   * Handle one `initialize` request.
   *
   * The server answers with a version it actually speaks: the client's own
   * version when it is supported, otherwise the newest one this server knows.
   * Echoing an unknown version blindly is how servers end up claiming a spec
   * they do not implement.
   *
   * @param {Record<string, any>} params initialize params.
   * @returns {Record<string, any>} initialize result.
   */
  function handleInitialize(params) {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
    protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION
    const client = params && typeof params.clientInfo === 'object' && params.clientInfo !== null ? params.clientInfo : undefined
    if (client && typeof client.name === 'string') {
      log(`client: ${client.name}${typeof client.version === 'string' ? ` ${client.version}` : ''} (protocol ${requested || 'unspecified'} -> ${protocolVersion})`)
    }
    initialized = true
    log(`ready: lock root ${manager.lockRoot}, owner ${manager.owner}`)

    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'These tools arbitrate exclusive machine resources between agents and processes. '
        + 'Call resource_acquire BEFORE using a browser, a Playwright/Chromium user-data-dir, a fixed port, screen or input focus, '
        + 'or a directory/repository that other agents also write to; call resource_release as soon as the work is done, including on failure. '
        + 'A lease expires by TTL, so a crashed holder cannot block a resource forever. '
        + 'Leases are files shared with the resource-lease CLI (lease.ps1), so CLI users and these tools exclude each other. '
        + 'resource_status shows who holds what, why, and for how long.',
    }
  }

  /**
   * Handle one `tools/call`.
   *
   * Tool failures are returned as `isError: true` results carrying an
   * actionable message (holder, reason, remaining time) instead of thrown
   * exceptions -- a throwing handler would kill the server and drop every
   * lease it holds. Protocol-level mistakes (unknown tool, wrong result
   * shape) stay JSON-RPC errors, which is what the spec reserves them for.
   *
   * @param {Record<string, any>} params call params.
   * @returns {Promise<Record<string, any>>} a tool result.
   */
  async function handleToolCall(params) {
    const name = params?.name
    if (typeof name !== 'string' || name === '') {
      throw Object.assign(new Error('tools/call requires a "name" string'), { rpcCode: RPC_INVALID_PARAMS })
    }
    const tool = toolsByName.get(name)
    if (tool === undefined) {
      throw Object.assign(
        new Error(`Unknown tool: ${name}. Available tools: ${tools.map((t) => t.name).join(', ')}.`),
        { rpcCode: RPC_INVALID_PARAMS },
      )
    }

    const raw = params?.arguments
    if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
      throw Object.assign(new Error(`tools/call "${name}": "arguments" must be an object`), { rpcCode: RPC_INVALID_PARAMS })
    }
    const args = raw ?? {}

    try {
      const value = await tool.execute(args)
      return {
        content: [{ type: 'text', text: String(value.text) }],
        // structuredContent is the machine-readable twin of `content`, and
        // matches the tool's declared outputSchema property for property.
        structuredContent: projectStructured(tool, value),
      }
    } catch (err) {
      if (!(err instanceof LeaseError)) {
        log(`tool ${name} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      }
      const message = err instanceof Error ? err.message : String(err)
      const code = err instanceof LeaseError ? err.code : 'INTERNAL_ERROR'
      // No structuredContent on the error path: the declared outputSchema
      // describes a successful result, and a strict client would flag it.
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      }
    }
  }

  /**
   * Dispatch one parsed JSON-RPC message.
   *
   * Returns null for notifications (no id), which must never be answered --
   * replying to `notifications/initialized` confuses strict clients.
   *
   * @param {Record<string, any>} message parsed message.
   * @returns {Promise<Record<string, any> | null>} response, or null.
   */
  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return errorResponse(null, RPC_INVALID_REQUEST, 'Invalid request: expected a single JSON-RPC object per line.')
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null
    const id = hasId ? message.id : null
    const method = message.method

    if (message.jsonrpc !== '2.0') {
      return hasId ? errorResponse(id, RPC_INVALID_REQUEST, 'Invalid request: "jsonrpc" must be exactly "2.0".') : null
    }

    // A response from the client (we never send requests, so this is noise).
    if (method === undefined) {
      if (message.result !== undefined || message.error !== undefined) return null
      return hasId ? errorResponse(id, RPC_INVALID_REQUEST, 'Invalid request: missing "method".') : null
    }
    if (typeof method !== 'string') {
      return hasId ? errorResponse(id, RPC_INVALID_REQUEST, 'Invalid request: "method" must be a string.') : null
    }

    // ------------------------------------------------------- notifications
    if (!hasId) {
      if (method === 'notifications/initialized') return null
      if (method === 'notifications/cancelled') return null
      if (method === 'notifications/progress') return null
      log(`ignored notification: ${method}`)
      return null
    }

    // ------------------------------------------------------------ requests
    try {
      if (method === 'initialize') {
        return resultResponse(id, handleInitialize(message.params))
      }
      if (method === 'ping') {
        // Liveness check: must work even before initialize.
        return resultResponse(id, {})
      }
      if (method === 'tools/list') {
        return resultResponse(id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
          })),
        })
      }
      if (method === 'tools/call') {
        if (!initialized) log('warning: tools/call before initialize')
        return resultResponse(id, await handleToolCall(message.params))
      }
      return errorResponse(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}. This server implements initialize, ping, tools/list and tools/call.`)
    } catch (err) {
      const rpcCode = typeof err?.rpcCode === 'number' ? err.rpcCode : RPC_INTERNAL_ERROR
      const text = err instanceof Error ? err.message : String(err)
      if (rpcCode === RPC_INTERNAL_ERROR) log(`request ${String(method)} failed: ${text}`)
      return errorResponse(id, rpcCode, text)
    }
  }

  /**
   * Handle one complete input line.
   *
   * Handled without awaiting, so a long `waitMs` acquire does not block a
   * `ping` or `resource_status` that arrives behind it -- responses are
   * matched to requests by id, not by order.
   *
   * @param {string} line one line of stdin, possibly empty.
   */
  function handleLine(line) {
    const text = line.trim()
    if (text === '') return

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      // Malformed input is a request-level error, never a crash: a client that
      // writes half a line must still be able to recover.
      log('parse error: input line is not valid JSON')
      writeMessage(errorResponse(null, RPC_PARSE_ERROR, 'Parse error: each line must be one complete JSON-RPC object.'))
      return
    }

    // JSON-RPC batch: an array of messages.
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        writeMessage(errorResponse(null, RPC_INVALID_REQUEST, 'Invalid request: empty batch.'))
        return
      }
      void Promise.all(parsed.map((one) => handleMessage(one)))
        .then((responses) => {
          const out = responses.filter((response) => response !== null)
          if (out.length === 0) return
          if (out.length === 1) writeMessage(out[0])
          else {
            try {
              process.stdout.write(JSON.stringify(out) + '\n')
            } catch {
              /* client gone */
            }
          }
        })
        .catch((err) => log(`batch handler failed: ${err instanceof Error ? err.message : String(err)}`))
      return
    }

    void handleMessage(parsed)
      .then((response) => {
        if (response !== null) writeMessage(response)
      })
      .catch((err) => {
        log(`handler failed: ${err instanceof Error ? err.message : String(err)}`)
        try {
          writeMessage(errorResponse(parsed?.id ?? null, RPC_INTERNAL_ERROR, 'Internal error while handling the request.'))
        } catch {
          /* client gone */
        }
      })
  }

  /**
   * Release everything this process holds and stop.
   *
   * A clean disconnect should hand the resources back instead of making the
   * next agent wait out the TTL. Exceptions are swallowed: a shutdown path
   * that throws leaves the leases behind anyway.
   *
   * @param {string} why reason, for the log line.
   * @param {number} code process exit code.
   */
  function shutdown(why, code) {
    // Cancel pending waits FIRST, so a queueing acquire cannot hold the event
    // loop open after the client is gone.
    try {
      manager.close()
    } catch {
      /* nothing to cancel */
    }
    try {
      const released = manager.releaseHeld()
      if (released.length > 0) log(`released ${released.length} lease(s) on ${why}: ${released.join(', ')}`)
    } catch (err) {
      log(`release on ${why} failed (TTL will clean up): ${err instanceof Error ? err.message : String(err)}`)
    }
    log(`stopping (${why})`)
    process.exitCode = code
  }

  // ------------------------------------------------------------- plumbing

  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') {
      // Client closed the pipe; there is nobody left to serve.
      shutdown('EPIPE on stdout', 0)
      process.exit(0)
    }
  })

  let buffered = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      handleLine(line)
    }
  })
  process.stdin.on('end', () => {
    if (buffered.trim() !== '') handleLine(buffered)
    buffered = ''
    shutdown('stdin closed', 0)
  })
  process.stdin.on('error', (err) => log(`stdin error: ${err instanceof Error ? err.message : String(err)}`))

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(signal, () => {
        shutdown(signal, 0)
        process.exit(0)
      })
    } catch {
      /* not every platform has every signal */
    }
  }

  process.on('uncaughtException', (err) => {
    // Last line of defence: log and keep serving. Exiting here would drop the
    // process's leases and make every waiting agent fail at once.
    log(`uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  })
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
  })

  log(`starting ${SERVER_NAME} ${SERVER_VERSION} (node ${process.version}, ${process.platform})`)
  log(`lock root: ${manager.lockRoot}`)
  log(`owner: ${manager.owner}`)
}

// -------------------------------------------------------------------- main

/** Help text for `--help`. */
function usage() {
  return [
    `${SERVER_NAME} ${SERVER_VERSION} -- MCP server for cross-process resource leases`,
    '',
    'Usage:',
    '  resource-lease-mcp [--lock-root <dir>] [--owner <name>] [--default-ttl <dur>] [--max-wait <dur>]',
    '',
    'Speaks JSON-RPC 2.0 over stdio (one JSON object per line). Clients start it;',
    'it prints nothing on stdout except JSON-RPC.',
    '',
    'Options:',
    '  --lock-root <dir>     Lock directory. Default: $DSH_RESOURCE_LOCK_ROOT, else',
    '                        %LOCALAPPDATA%\\dsh-resource-lease\\locks (Windows) or',
    '                        $XDG_RUNTIME_DIR/dsh-resource-lease/locks, else <tmp>/dsh-resource-lease/locks.',
    '  --owner <name>        Owner recorded on leases. Default: $DSH_AGENT_NAME, else "pid:<pid>".',
    '  --default-ttl <dur>   Default lease TTL (e.g. 30s, 2m). Default: $DSH_RESOURCE_TTL, else 30s.',
    '  --max-wait <dur>      Cap for waitMs. Default: $DSH_RESOURCE_MAX_WAIT, else 120s.',
    '  --print-lock-root     Print the resolved lock root and exit (handy for debugging).',
    '  -v, --version         Print the version and exit.',
    '  -h, --help            Print this help and exit.',
    '',
    'Tools: resource_acquire, resource_release, resource_status.',
    'The lock files are shared with the resource-lease CLI (lease.ps1), so both sides',
    'see the same leases. Point both at the same --lock-root / DSH_RESOURCE_LOCK_ROOT.',
  ].join('\n')
}

/**
 * Parse the server's own command line.
 *
 * Deliberately hand-rolled: adding a dependency to parse five flags would
 * defeat the "zero dependency, npx-able" requirement.
 *
 * @param {string[]} argv process.argv.slice(2).
 * @returns {{ lockRoot?: string, owner?: string, defaultTtl?: string, maxWait?: string, help: boolean, version: boolean, error?: string, printLockRoot: boolean }} parsed options.
 */
function parseArgs(argv) {
  const out = { help: false, version: false, printLockRoot: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined
    /** @param {string} flag @returns {string | undefined} value for the flag. */
    const value = (flag) => {
      if (inline !== undefined) return inline
      i += 1
      if (i >= argv.length) {
        out.error = `${flag} needs a value`
        return undefined
      }
      return argv[i]
    }

    switch (name) {
      case '--lock-root': out.lockRoot = value('--lock-root'); break
      case '--owner': out.owner = value('--owner'); break
      case '--default-ttl': out.defaultTtl = value('--default-ttl'); break
      case '--max-wait': out.maxWait = value('--max-wait'); break
      case '--print-lock-root': out.printLockRoot = true; break
      case '-h':
      case '--help': out.help = true; break
      case '-v':
      case '--version': out.version = true; break
      default:
        // Unknown flags are ignored rather than fatal: a client config that
        // carries an extra flag must not stop the server from starting.
        log(`ignoring unknown argument: ${arg}`)
    }
    if (out.error !== undefined) return out
  }
  return out
}

/**
 * Entry point.
 */
function main() {
  const parsed = parseArgs(process.argv.slice(2))

  if (parsed.error !== undefined) {
    process.stderr.write(`${SERVER_NAME}: ${parsed.error}\n\n${usage()}\n`)
    process.exit(2)
  }
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  if (parsed.version) {
    process.stdout.write(`${SERVER_VERSION}\n`)
    process.exit(0)
  }

  const env = process.env
  const lockRoot = resolveLockRoot(parsed.lockRoot, env)

  if (parsed.printLockRoot) {
    process.stdout.write(`${lockRoot}\n`)
    process.exit(0)
  }

  const owner = typeof parsed.owner === 'string' && parsed.owner.trim() !== ''
    ? parsed.owner.trim()
    : typeof env.DSH_AGENT_NAME === 'string' && env.DSH_AGENT_NAME.trim() !== ''
      ? env.DSH_AGENT_NAME.trim()
      : `pid:${process.pid}`

  const defaultTtlMs = Math.max(MIN_TTL_MS, toMs(parsed.defaultTtl ?? env.DSH_RESOURCE_TTL, DEFAULT_TTL_MS))
  const configuredMaxWait = parsed.maxWait ?? env.DSH_RESOURCE_MAX_WAIT
  const maxWaitMs = Math.max(0, toMs(configuredMaxWait, DEFAULT_MAX_WAIT_MS))

  startServer({ lockRoot, owner, defaultTtlMs, maxWaitMs })
}

main()
