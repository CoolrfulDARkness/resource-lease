#!/usr/bin/env node
/**
 * v2 lock-kernel test for RESOURCE-MODEL-v2.md §4, §5, §6.
 *
 * Covers the §11 matrix rows this file owns: 1, 6, 7, 8, 9, 12, 13, 15.
 *
 * WHY REAL PROCESSES
 *   Same-process Promise concurrency cannot test this layer at all. Mutex here means
 *   "one file, one winner" decided by the kernel's O_EXCL; two async tasks in one
 *   process share the event loop, the pid and the in-memory state, so they can be
 *   perfectly exclusive by accident, and they can never reproduce the failures that
 *   matter (a takeover between two processes, a killed holder, a pid reused by an
 *   unrelated process). Every cross-process row below therefore spawns a real
 *   `node` child (child_process.spawn) that loads lib/lock.js itself, waits on a
 *   wall-clock barrier so the attempts really overlap, writes its result to a file
 *   and exits. A child that does not finish inside its own timeout is reported as a
 *   deadlock, which is exactly what row 6 asserts about.
 *
 * Usage: node --test resource-lease/plugin/test/lock-v2.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  INDEX_DIR,
  LeaseNotImplementedError,
  acquireMany,
  assertBackend,
  brokerBackend,
  canonicalKey,
  currentProcStart,
  facetsOf,
  hostname,
  isLeaseBackend,
  isOwnerAlive,
  localBackend,
  orderKey,
  pidExists,
  planAcquisition,
  readMeta,
  reclaimLock,
  releaseMany,
  sanitizeKey,
  setModelWarningSink,
  setResourceModel,
  statusOf,
  sweep,
} from '../lib/lock.js'
import * as resourceModel from '../lib/resources.js'

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-v2-test-'))
const lockUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'lock.js')).href
const workerPath = path.join(testDir, 'worker.mjs')
const children = []

/**
 * The whole child program, materialised once into the temp dir.
 *
 * It takes a JSON plan (argv[2]) and writes a JSON result (argv[3]); `startAt` is a
 * wall-clock barrier so every racer reaches its first acquire call at the same
 * instant instead of being staggered by node's startup time.
 */
const WORKER_SOURCE = String.raw`
import fs from 'node:fs'
import process from 'node:process'

const { localBackend, acquireMany, releaseMany } = await import('__LOCK_URL__')

const planFile = process.argv[2]
const outFile = process.argv[3]
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))

function sleepSync(ms) {
  if (!(ms > 0)) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* spin */ }
  }
}

const backend = localBackend(plan.lockRoot)
const owner = plan.ownerName ? { agent: plan.ownerName, session: 'sess-' + plan.ownerName } : undefined

let result
const tAcquireStart = Date.now()
try {
  if (plan.startAt) {
    while (Date.now() < plan.startAt) { /* barrier: all racers fire together */ }
  }
  result = acquireMany(backend, plan.requests, {
    ttlMs: plan.ttlMs,
    reason: plan.reason || 'worker',
    owner,
    strategy: plan.strategy || 'fail',
    waitMs: plan.waitMs || 0,
  })
} catch (err) {
  result = { ok: false, error: String((err && err.stack) || err) }
}
const tAcquireEnd = Date.now()

result.pid = process.pid
result.procStart = Math.round(Date.now() - process.uptime() * 1000)
// When this process's acquire() RETURNED. For a loser this is the instant the conflict was
// computed (the kernel stamps expiresInMs from the same Date.now() in the same tick), which
// is what lets a test DERIVE the remaining TTL instead of assuming "the loser acted within
// N seconds of the winner".
result.tAcquireStart = tAcquireStart
result.tAcquireEnd = tAcquireEnd
if (plan.ownerName) result.ownerName = plan.ownerName
fs.writeFileSync(outFile, JSON.stringify(result))

if (plan.holdMs) {
  sleepSync(plan.holdMs)
  if (plan.releaseOnExit && result.ok) {
    try { releaseMany(backend, result.id) } catch { /* exiting anyway */ }
  }
}
process.exit(0)
`.replace('__LOCK_URL__', lockUrl)

fs.writeFileSync(workerPath, WORKER_SOURCE)

let planSeq = 0
let rootSeq = 0

/** @returns {string} a fresh lock root. */
function freshRoot() {
  const root = path.join(testDir, `root-${(rootSeq += 1)}`)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Wait until a synchronous predicate holds.
 *
 * @param {() => boolean} predicate condition.
 * @param {{ timeoutMs?: number, label?: string }} [options] budget and description.
 * @returns {Promise<void>} resolves when true.
 */
async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.label ?? 'condition'}`)
    await sleep(15)
  }
}

/**
 * Spawn one real worker process.
 *
 * @param {Record<string, any>} plan the plan the child executes.
 * @param {{ timeoutMs?: number }} [options] deadlock budget.
 * @returns {Record<string, any>} handle: child, finished, readResult.
 */
function launch(plan, options = {}) {
  const seq = (planSeq += 1)
  const planFile = path.join(testDir, `plan-${seq}.json`)
  const outFile = path.join(testDir, `out-${seq}.json`)
  fs.writeFileSync(planFile, JSON.stringify(plan))

  const child = spawn(process.execPath, [workerPath, planFile, outFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)

  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.stdout.on('data', () => {})

  let timedOut = false
  let timer = null
  const finished = new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => {
      // A child still running past its budget is a deadlock (or a hang in the
      // kernel). Kill it, and let the assertion say so instead of hanging the suite.
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      done({ code: null, signal: 'SIGKILL', timedOut: true, stderr })
    }, options.timeoutMs ?? 20_000)
    child.on('exit', (code, signal) => done({ code, signal, timedOut, stderr }))
    child.on('error', (err) => done({ code: null, signal: null, timedOut, stderr: String(err) + stderr }))
  })

  return {
    child,
    plan,
    outFile,
    stderr: () => stderr,
    finished,
    /**
     * Read the child's result file (it writes it before any hold).
     *
     * @param {{ timeoutMs?: number }} [readOptions] budget.
     * @returns {Promise<Record<string, any>>} parsed result.
     */
    async readResult(readOptions = {}) {
      await waitFor(() => {
        try {
          const raw = fs.readFileSync(outFile, 'utf8')
          JSON.parse(raw)
          return true
        } catch {
          return false
        }
      }, { timeoutMs: readOptions.timeoutMs ?? 15_000, label: `worker result (${stderr || 'no stderr'})` })
      return JSON.parse(fs.readFileSync(outFile, 'utf8'))
    },
  }
}

/**
 * Every lock file in a root.
 *
 * @param {string} root lock root.
 * @returns {Array<{ name: string, path: string, meta: Record<string, any> | null }>} files.
 */
function lockFiles(root) {
  let names
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  return names.filter((name) => name.endsWith('.lock')).map((name) => ({
    name,
    path: path.join(root, name),
    meta: readMeta(path.join(root, name)),
  }))
}

/**
 * Every archived takeover file in a root.
 *
 * @param {string} root lock root.
 * @returns {string[]} names.
 */
function staleFiles(root) {
  try {
    return fs.readdirSync(root).filter((name) => name.includes('.stale.'))
  } catch {
    return []
  }
}

/** @param {string} key resource key. @returns {string} its canonical single facet. */
function facetOf(key) {
  return facetsOf(key)[0]
}

/** @param {Record<string, any>} backend backend. @param {string} key key. @returns {string} its facet lock path. */
function facetLockPath(backend, key, mode = 'exclusive', slot = 0) {
  return backend.pathFor(facetOf(key), mode, slot)
}

/**
 * Write a lock file by hand, the way another process (or the CLI) would.
 *
 * @param {string} lockPath target.
 * @param {Record<string, any>} meta body.
 */
function writeLockFile(lockPath, meta) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, JSON.stringify(meta))
}

after(async () => {
  for (const child of children) {
    try { child.kill('SIGKILL') } catch { /* already dead */ }
  }
  await sleep(50)
  fs.rmSync(testDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// §11 #1 -- two processes race for one facet
// ---------------------------------------------------------------------------

test('§11 #1 two real processes racing for path:D:/out: exactly one wins', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const key = 'path:D:/out'
  const startAt = Date.now() + 700 // barrier: both children fire at the same instant
  // holdMs is NOT optional here: without it the winner acquires and exits immediately, so
  // the race being measured is "whoever exits first", not mutual exclusion. §5/G3 says a
  // dead holder's lease IS reclaimable at once, so a loser that reclaims after the winner
  // exited is CORRECT behaviour -- asserting "exactly one winner" over that window tests a
  // promise the kernel never made. With a hold, both attempts really overlap and the
  // assertion measures what it means to measure.
  const a = launch({ lockRoot: root, requests: [key], ttlMs: 30_000, reason: 'race a', startAt, ownerName: 'racer-a', holdMs: 3000 })
  const b = launch({ lockRoot: root, requests: [key], ttlMs: 30_000, reason: 'race b', startAt, ownerName: 'racer-b', holdMs: 3000 })

  const [resultA, resultB] = await Promise.all([a.readResult(), b.readResult()])
  await Promise.all([a.finished, b.finished])
  assert.equal(resultA.error, undefined, `child A failed to run: ${resultA.error ?? ''} ${a.stderr()}`)
  assert.equal(resultB.error, undefined, `child B failed to run: ${resultB.error ?? ''} ${b.stderr()}`)
  assert.notEqual(resultA.pid, resultB.pid, 'the two racers are genuinely different processes')

  const all = [resultA, resultB]
  const winners = all.filter((result) => result.ok === true)
  const losers = all.filter((result) => result.ok === false)
  assert.equal(winners.length, 1, `exactly one process must win; got ${JSON.stringify(all)}`)
  assert.equal(losers.length, 1)

  const winner = winners[0]
  const loser = losers[0]

  // G1: one facet, one holder -- and the holder is the process that reported ok.
  const files = lockFiles(root)
  assert.equal(files.length, winner.entries.length, 'one lock file per facet of the winner')
  for (const file of files) {
    assert.equal(file.meta?.id, winner.id, `${file.name} must belong to the winning lease`)
    assert.equal(file.meta?.pid, winner.pid, `${file.name} must carry the winner pid`)
  }

  // §4.3: the failure says WHO blocked it, not just "busy".
  const conflict = loser.conflicts[0]
  assert.equal(conflict.facet, facetOf(key))
  assert.equal(conflict.heldBy.pid, winner.pid)
  assert.equal(conflict.heldBy.agent, winner.owner.agent)
  assert.equal(conflict.heldBy.session, winner.owner.session)
  assert.equal(conflict.heldBy.host, hostname())
  assert.equal(conflict.mode, 'exclusive')
  assert.equal(conflict.reason, winner.reason)

  // The remaining TTL must be the REAL number, derived -- not just "a big number".
  //
  // This replaces `assert.ok(conflict.expiresInMs > 20_000)`, which conflated two
  // unrelated things: whether the TTL is reported correctly, and how fast the loser
  // happened to try. It silently required the loser to attempt within 10 s of the
  // winner's acquire -- a timing premise the kernel never promised, and one that 32-way
  // CPU load breaks on a correct implementation.
  //
  // WHERE THE KERNEL'S NUMBER COMES FROM (lock.js:2373 stamps `now` per facet claim, and
  // the conflict row's expiresInMs is `expiresAt - now`, built after the conflict scan and
  // its liveness probe): the stamp is taken somewhere INSIDE the loser's own acquire, so
  // the reported TTL must lie in [expiresAt - tAcquireEnd, expiresAt - tAcquireStart].
  // Deriving it from that window -- rather than from one endpoint -- is what makes this an
  // exact check instead of a magnitude proxy, and it stays correct when a loaded machine
  // spends seconds in the pid probe.
  //
  // What is checked, and why it is strictly stronger than the old line:
  //   * > 0                      : still live when reported (old had this implicitly)
  //   * >= expiresAt-tAcquireEnd : cannot UNDER-report the remaining life
  //   * <= expiresAt-tAcquireStart: cannot OVER-report it
  //   * <= ttlMs + window + slack: never claims more life than the lease ever had
  // The old `> 20_000` never checked the value against the lease at all; it only checked
  // that a biggish number appeared, which a wrong-but-large number would also satisfy.
  const ttlMs = 30_000
  const clockSlackMs = 2000
  const loserWindowMs = loser.tAcquireEnd - loser.tAcquireStart
  assert.equal(typeof winner.expiresAt, 'number', `the winner result must carry expiresAt; got ${JSON.stringify(winner.expiresAt)}`)
  assert.equal(typeof loser.tAcquireStart, 'number', `the loser must report when its acquire began; got ${JSON.stringify(loser.tAcquireStart)}`)
  assert.equal(typeof loser.tAcquireEnd, 'number', `the loser must report when its acquire returned; got ${JSON.stringify(loser.tAcquireEnd)}`)

  const remainingAtLoserEnd = winner.expiresAt - loser.tAcquireEnd
  const remainingAtLoserStart = winner.expiresAt - loser.tAcquireStart
  assert.ok(conflict.expiresInMs > 0, `the reported TTL must still be live: ${conflict.expiresInMs}`)
  assert.ok(
    conflict.expiresInMs >= remainingAtLoserEnd - clockSlackMs,
    `expiresInMs (${conflict.expiresInMs}) under-reports the remaining TTL: it must be >= `
    + `winner.expiresAt - loser.tAcquireEnd (${winner.expiresAt} - ${loser.tAcquireEnd} = ${remainingAtLoserEnd}) `
    + `minus ${clockSlackMs}ms`,
  )
  assert.ok(
    conflict.expiresInMs <= remainingAtLoserStart + clockSlackMs,
    `expiresInMs (${conflict.expiresInMs}) over-reports the remaining TTL: it must be <= `
    + `winner.expiresAt - loser.tAcquireStart (${winner.expiresAt} - ${loser.tAcquireStart} = ${remainingAtLoserStart}) `
    + `plus ${clockSlackMs}ms`,
  )
  assert.ok(
    conflict.expiresInMs <= ttlMs + loserWindowMs + clockSlackMs,
    `expiresInMs (${conflict.expiresInMs}) cannot exceed the lease TTL (${ttlMs}) by more than `
    + `the loser's own sampling window (${loserWindowMs}ms) and ${clockSlackMs}ms of clock slack`,
  )

  // No residue from the loser: nothing was acquired before it lost, and nothing leaked.
  assert.deepEqual(loser.released, [])
})

test('§11 #1 four real processes racing for one facet: still exactly one holder', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const key = 'path:D:/out4'
  const startAt = Date.now() + 700
  const racers = [1, 2, 3, 4].map((n) => launch({
    lockRoot: root,
    requests: [key],
    ttlMs: 30_000,
    reason: `racer ${n}`,
    startAt,
    ownerName: `racer-${n}`,
    // Same reason as the two-racer case above: the winner must still be alive while the
    // others try, otherwise this measures exit timing instead of exclusion (G3).
    holdMs: 3000,
  }))
  const results = await Promise.all(racers.map((racer) => racer.readResult()))
  await Promise.all(racers.map((racer) => racer.finished))

  const winners = results.filter((result) => result.ok === true)
  assert.equal(winners.length, 1, `exactly one of four must win; got ${JSON.stringify(results.map((r) => r.ok))}`)
  const files = lockFiles(root)
  assert.equal(new Set(files.map((file) => file.meta?.id)).size, 1, 'one lease id holds every facet file')
  assert.equal(files.length, winners[0].entries.length)
})

// ---------------------------------------------------------------------------
// §11 #6 -- opposite request order, no deadlock (G2)
// ---------------------------------------------------------------------------

test('§11 #6 two processes request A,B in opposite order: no deadlock, one all-or-nothing lease', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const startAt = Date.now() + 700
  const forward = launch({
    lockRoot: root,
    requests: ['path:D:/aaa', 'path:D:/zzz'],
    ttlMs: 30_000,
    reason: 'A then B',
    startAt,
    ownerName: 'order-forward',
    // Same reason as §11 #1: without a hold the winner acquires and exits immediately, so
    // the other racer's takeover is LEGAL under §5/G3 and the race measures exit timing
    // instead of exclusion. Both attempts must really overlap.
    holdMs: 3000,
  })
  const reverse = launch({
    lockRoot: root,
    requests: ['path:D:/zzz', 'path:D:/aaa'],
    ttlMs: 30_000,
    reason: 'B then A',
    startAt,
    ownerName: 'order-reverse',
    holdMs: 3000,
  })

  const [resultForward, resultReverse] = await Promise.all([forward.readResult(), reverse.readResult()])
  const [exitForward, exitReverse] = await Promise.all([forward.finished, reverse.finished])

  // THE assertion of row 6: both processes terminated on their own. A wait cycle would
  // show up here as timedOut (and the harness would have had to SIGKILL the child).
  assert.equal(exitForward.timedOut, false, `forward child deadlocked; stderr: ${exitForward.stderr}`)
  assert.equal(exitReverse.timedOut, false, `reverse child deadlocked; stderr: ${exitReverse.stderr}`)

  const results = [resultForward, resultReverse]
  const winners = results.filter((result) => result.ok === true)
  assert.equal(winners.length, 1, `the global order makes one of them take both facets; got ${JSON.stringify(results.map((r) => r.ok))}`)

  const winner = winners[0]
  assert.equal(winner.entries.length, 2, 'the winner holds both facets of its request')
  const loser = results.find((result) => result.ok === false)
  assert.deepEqual(loser.released, [], 'the loser failed on the first facet, so it had nothing to roll back')

  // All-or-nothing: every lock file in the root belongs to the single winner.
  const files = lockFiles(root)
  assert.equal(files.length, 2)
  for (const file of files) assert.equal(file.meta?.id, winner.id)
})

test('§11 #6 opposite order with strategy=queue: both eventually succeed, in sequence', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const startAt = Date.now() + 700
  // Short ttl + a holder that lets go after 250 ms: the waiter polls, then wins.
  const forward = launch({
    lockRoot: root,
    requests: ['path:D:/q1', 'path:D:/q2'],
    ttlMs: 4000,
    strategy: 'queue',
    waitMs: 6000,
    holdMs: 250,
    releaseOnExit: true,
    reason: 'queue forward',
    startAt,
    ownerName: 'queue-forward',
  })
  const reverse = launch({
    lockRoot: root,
    requests: ['path:D:/q2', 'path:D:/q1'],
    ttlMs: 4000,
    strategy: 'queue',
    waitMs: 6000,
    holdMs: 250,
    releaseOnExit: true,
    reason: 'queue reverse',
    startAt,
    ownerName: 'queue-reverse',
  })

  const [resultForward, resultReverse] = await Promise.all([forward.readResult(), reverse.readResult()])
  const [exitForward, exitReverse] = await Promise.all([forward.finished, reverse.finished])
  assert.equal(exitForward.timedOut, false, `queue forward deadlocked: ${exitForward.stderr}`)
  assert.equal(exitReverse.timedOut, false, `queue reverse deadlocked: ${exitReverse.stderr}`)

  // Sorting means both request the SAME facet first, so they serialise instead of
  // each grabbing one facet and waiting forever for the other.
  assert.equal(resultForward.ok, true, `forward should have queued its way in: ${JSON.stringify(resultForward.conflicts ?? resultForward)}`)
  assert.equal(resultReverse.ok, true, `reverse should have queued its way in: ${JSON.stringify(resultReverse.conflicts ?? resultReverse)}`)
  assert.notEqual(resultForward.id, resultReverse.id)

  // Both released on exit, so the root is clean again.
  await waitFor(() => lockFiles(root).length === 0, { label: 'both queued leases released', timeoutMs: 10_000 })
})

// ---------------------------------------------------------------------------
// §11 #7 -- a conflict halfway through rolls everything back
// ---------------------------------------------------------------------------

test('§11 #7 a conflict on the second facet rolls back the first, in reverse, with no residue', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  // Order key sorts path:d:/aaa before path:d:/zzz, so the child takes aaa first and
  // then finds zzz taken: exactly the mid-way failure of §4.1 step 4.
  const held = acquireMany(backend, ['path:D:/zzz'], { ttlMs: 60_000, reason: 'pre-held blocker', owner: { agent: 'blocker' } })
  assert.equal(held.ok, true)

  const child = launch({
    lockRoot: root,
    requests: ['path:D:/aaa', 'path:D:/zzz'],
    ttlMs: 60_000,
    reason: 'rollback me',
    ownerName: 'roller',
  })
  const result = await child.readResult()
  const exit = await child.finished
  assert.equal(exit.timedOut, false, exit.stderr)

  assert.equal(result.ok, false)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].facet, facetOf('path:D:/zzz'))
  assert.equal(result.conflicts[0].heldBy.pid, result.conflicts[0].heldBy.pid)
  assert.equal(result.conflicts[0].heldBy.agent, 'blocker')
  // The first facet was acquired and then released, in reverse order.
  assert.deepEqual(result.released, [facetOf('path:D:/aaa')], `released: ${JSON.stringify(result.released)}`)

  // No residue: only the pre-held lease has files left.
  const files = lockFiles(root)
  assert.equal(files.length, held.entries.length, `files left: ${JSON.stringify(files.map((f) => f.name))}`)
  for (const file of files) assert.equal(file.meta?.id, held.id)
  assert.equal(readMeta(facetLockPath(backend, 'path:D:/aaa')), null, 'the rolled-back facet is free again')

  // ... and the facet really is free: someone else can take it now.
  const next = acquireMany(backend, ['path:D:/aaa'], { ttlMs: 5000, reason: 'after rollback' })
  assert.equal(next.ok, true, `path:D:/aaa must be free after the rollback: ${JSON.stringify(next.conflicts ?? next)}`)
  assert.equal(releaseMany(backend, next.id).ok, true)
  assert.equal(releaseMany(backend, held.id).ok, true)
})

test('§11 #7 three facets, conflict on the last: both earlier facets are rolled back', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const held = acquireMany(backend, ['path:D:/mmm'], { ttlMs: 60_000, reason: 'middle blocker', owner: { agent: 'blocker' } })
  assert.equal(held.ok, true)

  const result = acquireMany(backend, ['path:D:/aaa', 'path:D:/bbb', 'path:D:/mmm'], {
    ttlMs: 60_000,
    reason: 'fail at the last facet',
    owner: { agent: 'roller-two' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.conflicts[0].facet, facetOf('path:D:/mmm'))
  assert.deepEqual(result.released.slice().sort(), [facetOf('path:D:/aaa'), facetOf('path:D:/bbb')].sort())
  assert.equal(lockFiles(root).length, held.entries.length)
  assert.equal(releaseMany(backend, held.id).ok, true)
})

// ---------------------------------------------------------------------------
// §11 #8 -- a killed holder is collected on the next observation (G3)
// ---------------------------------------------------------------------------

test('§11 #8 a killed holder is reclaimed immediately, long before its ttl (G3)', { timeout: 60_000 }, async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/kill-me'

  const victim = launch({
    lockRoot: root,
    requests: [key],
    ttlMs: 600_000, // ten minutes: the ttl cannot possibly be what lets us in
    holdMs: 600_000,
    reason: 'will be killed',
    ownerName: 'victim',
  })
  const acquired = await victim.readResult()
  assert.equal(acquired.ok, true, JSON.stringify(acquired))
  const victimPid = acquired.pid
  assert.equal(pidExists(victimPid), true)

  // While the holder is alive its lease must NOT be reclaimable, even though the
  // kernel can see its pid: this is the check that a liveness rule cannot steal from
  // a healthy process.
  const liveMeta = readMeta(backend.pathFor(facetOf(key), 'exclusive', 0))
  assert.equal(isOwnerAlive(liveMeta), true, 'a live holder reads as alive')
  const blocked = acquireMany(backend, [key], { ttlMs: 5000, reason: 'blocked by a live holder', owner: { agent: 'intruder' } })
  assert.equal(blocked.ok, false, 'a live lease must not be taken over')
  assert.equal(blocked.conflicts[0].heldBy.pid, victimPid)

  // Kill it the way a crash would: no release, no cleanup, just a dead pid.
  victim.child.kill('SIGKILL')
  await victim.finished
  await waitFor(() => !pidExists(victimPid), { label: `victim pid ${victimPid} to disappear`, timeoutMs: 15_000 })
  assert.equal(isOwnerAlive(liveMeta), false, 'the dead owner reads as dead')

  // No ttl has passed, so this can only succeed through the §5 liveness rule.
  const startedAt = Date.now()
  const after = acquireMany(backend, [key], { ttlMs: 5000, reason: 'after the crash', owner: { agent: 'survivor' } })
  const elapsed = Date.now() - startedAt
  assert.equal(after.ok, true, `expected an immediate reclaim, got ${JSON.stringify(after.conflicts ?? after)}`)
  assert.ok(elapsed < 5000, `reclaim must not wait for the ttl; took ${elapsed}ms`)
  assert.ok(staleFiles(root).length >= 1, 'the collected lease was archived for forensics')
  assert.equal(readMeta(after.entries[0].lockPath)?.id, after.id, 'the new holder owns the path now')
  assert.equal(releaseMany(backend, after.id).ok, true)
})

test('§11 #8 sweep() collects a dead holder without waiting for the ttl', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/sweep-me'
  const lockPath = facetLockPath(backend, key)
  // A lease written by a process that no longer exists (a crashed CLI): a pid that is
  // not running on this host, with a ttl ten minutes out.
  const deadPid = await findDeadPid()
  writeLockFile(lockPath, {
    id: 'lz_deadbeef0001',
    key,
    facet: facetOf(key),
    mode: 'exclusive',
    owner: 'crashed-cli',
    pid: deadPid,
    host: hostname(),
    reason: 'crashed before release',
    createdAt: Date.now() - 5000,
    expiresAt: Date.now() + 600_000,
    lockPath,
  })
  const rows = statusOf(backend, key)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].stale, true, 'status already reports the lease as stale')
  assert.equal(rows[0].staleWhy, 'owner process is gone')

  const before = sweep(backend)
  assert.equal(before.reclaimed.length, 1, `sweep reclaimed: ${JSON.stringify(before)}`)
  assert.equal(readMeta(lockPath), null, 'the dead lease is gone from the lock path')
  assert.ok(staleFiles(root).length >= 1, 'archived rather than deleted')

  // Nothing left to block a real acquire.
  const after = acquireMany(backend, [key], { ttlMs: 5000, reason: 'after the sweep' })
  assert.equal(after.ok, true)
  assert.equal(releaseMany(backend, after.id).ok, true)
})

// ---------------------------------------------------------------------------
// §11 #9 -- pid reuse (procStart mismatch) is reclaimed immediately
// ---------------------------------------------------------------------------

test('§11 #9 a reused pid (procStart mismatch) is reclaimed at once; a matching one is not', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/reused'
  const lockPath = facetLockPath(backend, key)
  const now = Date.now()
  const realStart = now - 60_000 // pretend this pid started a minute ago
  const staleStart = now - 3_600_000 // the lease recorded an hour-old process

  // A live pid (ours) carrying the OLD start time: the original owner died and the pid
  // was handed to an unrelated process. The ttl is ten minutes away, so only procStart
  // can reveal the leak.
  writeLockFile(lockPath, {
    id: 'lz_reused000001',
    key,
    facet: facetOf(key),
    mode: 'exclusive',
    owner: 'ghost',
    reason: 'crashed owner, pid reused',
    pid: process.pid,
    host: hostname(),
    session: 'ghost-session',
    procStart: staleStart,
    createdAt: now - 120_000,
    expiresAt: now + 600_000,
    lockPath,
  })

  // Without a probe there is nothing to compare, and a live pid must win: never steal
  // from a process that exists. (Failing towards "alive" is the safe direction.)
  const noProbe = acquireMany(backend, [key], {
    ttlMs: 5000,
    reason: 'no probe available',
    owner: { agent: 'cautious' },
    procStartOf: () => null,
  })
  assert.equal(noProbe.ok, false, 'a live pid must not be stolen when procStart cannot be probed')
  assert.equal(noProbe.conflicts[0].heldBy.pid, process.pid)

  // With the probe the mismatch is proof of PID reuse -> reclaim now (G3).
  const startedAt = Date.now()
  const reclaimed = acquireMany(backend, [key], {
    ttlMs: 5000,
    reason: 'procStart mismatch',
    owner: { agent: 'reclaimer' },
    procStartOf: () => realStart,
  })
  const elapsed = Date.now() - startedAt
  assert.equal(reclaimed.ok, true, `expected an immediate reclaim on pid reuse, got ${JSON.stringify(reclaimed.conflicts ?? reclaimed)}`)
  assert.ok(elapsed < 2000, `pid reuse must not wait for the ttl; took ${elapsed}ms`)
  assert.ok(staleFiles(root).length >= 1, 'the reused-pid lease was archived')
  assert.equal(releaseMany(backend, reclaimed.id).ok, true)

  // The mirror image: a MATCHING procStart is not a licence to steal. Same ttl, same
  // live pid, only the recorded start time is right this time.
  const keptKey = 'path:D:/not-reused'
  const keptPath = facetLockPath(backend, keptKey)
  writeLockFile(keptPath, {
    id: 'lz_alive0000001',
    key: keptKey,
    facet: facetOf(keptKey),
    mode: 'exclusive',
    owner: 'ash',
    reason: 'healthy holder',
    pid: process.pid,
    host: hostname(),
    procStart: realStart,
    createdAt: now,
    expiresAt: now + 600_000,
    lockPath: keptPath,
  })
  // Within the tolerance an imprecise probe is fine: 1.5 s of skew still means "same
  // process", and stealing on probe jitter would create two holders.
  const stillHeld = acquireMany(backend, [keptKey], {
    ttlMs: 5000,
    reason: 'matching procStart',
    owner: { agent: 'polite' },
    procStartOf: () => realStart + 1500,
  })
  assert.equal(stillHeld.ok, false, 'a matching procStart means the owner is alive: no steal')
  assert.equal(readMeta(keptPath)?.id, 'lz_alive0000001', 'the healthy lease is untouched')
})

// ---------------------------------------------------------------------------
// §11 #12 -- pool capacity, three real processes
// ---------------------------------------------------------------------------

test('§11 #12 pool slots=2 with three real processes: exactly two win, one slot each', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const key = 'api:testprovider:rpm'
  const startAt = Date.now() + 700
  const request = [{ key, mode: 'pool', slots: 2 }]
  const racers = ['p1', 'p2', 'p3'].map((name) => launch({
    lockRoot: root,
    requests: request,
    ttlMs: 30_000,
    startAt,
    // 600ms was too short: under load the two winners were gone before the third racer
    // even looked, so it legitimately collected a dead slot (§5/G3) and the pool appeared
    // to admit three. The hold must outlast the whole race.
    holdMs: 3000,
    reason: `pool ${name}`,
    ownerName: name,
  }))
  const results = await Promise.all(racers.map((racer) => racer.readResult()))
  await Promise.all(racers.map((racer) => racer.finished))

  const winners = results.filter((result) => result.ok === true)
  const losers = results.filter((result) => result.ok === false)
  assert.equal(winners.length, 2, `exactly two of three must win; got ${JSON.stringify(results.map((r) => r.ok))}`)
  assert.equal(losers.length, 1)

  // The two winners hold DIFFERENT slots of the same facet.
  const slots = winners.map((winner) => winner.entries[0].slot).sort()
  assert.deepEqual(slots, [0, 1], `winners took distinct slots: ${JSON.stringify(slots)}`)
  const files = lockFiles(root).map((file) => file.name).sort()
  assert.deepEqual(files, [`${sanitizeKey(facetOf(key))}.slot-0.lock`, `${sanitizeKey(facetOf(key))}.slot-1.lock`])
  assert.equal(losers[0].conflicts[0].facet, facetOf(key))
  assert.match(String(losers[0].conflicts[0].detail ?? ''), /slot|capacity/i)
})

test('§11 #12 a pool slot freed by a crash is reusable by the next process', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'api:testprovider:rpm'
  const first = acquireMany(backend, [{ key, mode: 'pool', slots: 2 }], { ttlMs: 600_000, reason: 'slot 0' })
  const second = acquireMany(backend, [{ key, mode: 'pool', slots: 2 }], { ttlMs: 600_000, reason: 'slot 1' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.entries[0].slot, 0)
  assert.equal(second.entries[0].slot, 1)
  assert.equal(acquireMany(backend, [{ key, mode: 'pool', slots: 2 }], { ttlMs: 1000, reason: 'no slot left' }).ok, false)

  // Release slot 0: the capacity is available again, and the other holder is untouched.
  assert.equal(releaseMany(backend, first.id).ok, true)
  assert.equal(readMeta(second.entries[0].lockPath)?.id, second.id, 'the sibling slot survived')
  const reused = acquireMany(backend, [{ key, mode: 'pool', slots: 2 }], { ttlMs: 5000, reason: 'reuse slot 0' })
  assert.equal(reused.ok, true)
  assert.equal(reused.entries[0].slot, 0, 'the freed slot is reused first')
})

// ---------------------------------------------------------------------------
// §11 #13 -- the aggregate index is not load-bearing
// ---------------------------------------------------------------------------

test('§11 #13 deleting _leases/ does not weaken exclusion, and release still works', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/indexless'

  const held = acquireMany(backend, [key], { ttlMs: 60_000, reason: 'holder before the index vanished', owner: { agent: 'holder' } })
  assert.equal(held.ok, true)
  const indexPath = path.join(root, INDEX_DIR)
  assert.equal(fs.existsSync(indexPath), true, 'the aggregate record was written')
  assert.equal(JSON.parse(fs.readFileSync(path.join(indexPath, `${held.id}.json`), 'utf8')).id, held.id)

  // Simulate the index being lost (a wipe, a bad mount, a hand-edited lock root).
  fs.rmSync(indexPath, { recursive: true, force: true })
  assert.equal(fs.existsSync(indexPath), false)

  // G1 must be unaffected: the facet file is the authority, so another process is
  // still blocked and is told who holds it.
  const other = launch({ lockRoot: root, requests: [key], ttlMs: 5000, reason: 'indexless intruder', ownerName: 'intruder' })
  const blocked = await other.readResult()
  await other.finished
  assert.equal(blocked.ok, false, 'exclusion must not depend on the index')
  assert.equal(blocked.conflicts[0].heldBy.pid, process.pid)
  assert.equal(blocked.conflicts[0].heldBy.agent, 'holder')

  // ... and releasing by id still works, because the facet files name the whole lease.
  const freed = releaseMany(backend, held.id)
  assert.equal(freed.ok, true, `release must survive a lost index: ${JSON.stringify(freed)}`)
  assert.equal(freed.released.length, held.entries.length)
  assert.equal(lockFiles(root).length, 0, 'no facet file left behind')

  // The next process gets in; a rebuild of the index is not required for that either.
  const next = launch({ lockRoot: root, requests: [key], ttlMs: 60_000, reason: 'after the index was gone', ownerName: 'next' })
  const acquired = await next.readResult()
  await next.finished
  assert.equal(acquired.ok, true, JSON.stringify(acquired.conflicts ?? acquired))
  assert.equal(releaseMany(backend, acquired.id).ok, true)
})

// ---------------------------------------------------------------------------
// §11 #15 -- rollback and release never delete someone else's lock
// ---------------------------------------------------------------------------

test('§11 #15 release keeps a facet that another lease has taken over', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const lease = acquireMany(backend, ['path:D:/mm1', 'path:D:/mm2'], { ttlMs: 60_000, reason: 'will be robbed', owner: { agent: 'mine' } })
  assert.equal(lease.ok, true)
  const [first, second] = lease.entries

  // Another process takes the first facet over (its own ttl expired, or a force steal):
  // the path is the same file name but a DIFFERENT lease id.
  assert.equal(backend.rename(first.lockPath, `${first.lockPath}.stale.manual`), true)
  writeLockFile(first.lockPath, {
    id: 'lz_foreign00001',
    key: 'path:D:/mm1',
    facet: first.facet,
    mode: 'exclusive',
    owner: 'thief',
    reason: 'took over the expired lease',
    pid: process.pid,
    host: hostname(),
    procStart: currentProcStart(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    lockPath: first.lockPath,
  })

  const released = releaseMany(backend, lease.id)
  // The honest answer: we released what was still ours, and we no longer hold the rest.
  assert.equal(released.ok, false)
  assert.equal(released.released.length, 1)
  assert.equal(released.kept.length, 1)
  assert.equal(released.kept[0].lockPath, first.lockPath)
  assert.equal(released.kept[0].onDiskId, 'lz_foreign00001')
  assert.equal(fs.existsSync(first.lockPath), true, "the thief's lock must survive our release")
  assert.equal(readMeta(first.lockPath)?.id, 'lz_foreign00001')
  assert.equal(fs.existsSync(second.lockPath), false, 'our own facet was released')
})

test('§11 #15 rollback keeps a facet taken over while the lease was being acquired', { timeout: 40_000 }, async () => {
  const root = freshRoot()
  const base = localBackend(root)
  const keyA = 'path:D:/r1'
  const keyB = 'path:D:/r2'
  const pathA = facetLockPath(base, keyA)
  const pathB = facetLockPath(base, keyB)
  const now = Date.now()

  // A live blocker owns the second facet (our own pid, a correct procStart, so the
  // liveness rule agrees it is alive).
  writeLockFile(pathB, {
    id: 'lz_blockerb0001',
    key: keyB,
    facet: facetOf(keyB),
    mode: 'exclusive',
    owner: 'blocker',
    reason: 'holds the second facet',
    pid: process.pid,
    host: hostname(),
    procStart: currentProcStart(),
    createdAt: now,
    expiresAt: now + 600_000,
    lockPath: pathB,
  })

  // A backend that lets the FIRST facet be claimed, then has that claim stolen before
  // the second one is attempted: precisely the window in which a naive rollback would
  // unlink a lock it no longer owns.
  let steals = 0
  const stealing = Object.create(base)
  stealing.tryCreate = (lockPath, meta) => {
    const created = base.tryCreate(lockPath, meta)
    if (created && lockPath === pathA && steals === 0) {
      steals += 1
      base.rename(pathA, `${pathA}.stale.steal`)
      writeLockFile(pathA, {
        id: 'lz_foreign00002',
        key: keyA,
        facet: facetOf(keyA),
        mode: 'exclusive',
        owner: 'opportunist',
        reason: 'stole the facet mid-acquisition',
        pid: process.pid,
        host: hostname(),
        procStart: currentProcStart(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
        lockPath: pathA,
      })
    }
    return created
  }

  const result = acquireMany(stealing, [keyA, keyB], {
    ttlMs: 60_000,
    reason: 'rollback vs takeover',
    owner: { agent: 'mine' },
  })

  assert.equal(steals, 1, 'the fault injection fired')
  assert.equal(result.ok, false, 'the second facet is blocked, so the lease must fail')
  assert.equal(result.conflicts[0].facet, facetOf(keyB))
  // Nothing was released, because the facet we took is no longer ours to release.
  assert.deepEqual(result.released, [], `released: ${JSON.stringify(result.released)}`)
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0].onDiskId, 'lz_foreign00002')
  assert.equal(fs.existsSync(pathA), true, 'the opportunist keeps the facet')
  assert.equal(readMeta(pathA)?.id, 'lz_foreign00002', "the rollback did not delete another lease's lock")
  assert.equal(readMeta(pathB)?.id, 'lz_blockerb0001', "the blocker's lock is untouched")
  assert.equal(lockFiles(root).length, 2, 'exactly the two foreign locks remain')
})

test('§11 #15 removeIfOwned refuses a body without a string id, and an unreadable file', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const lockPath = path.join(root, 'odd.lock')
  fs.writeFileSync(lockPath, JSON.stringify({ id: 123, owner: 'x' }))
  assert.equal(backend.remove(lockPath, String(123)), false, 'a non-string id is not ours to delete')
  assert.equal(fs.existsSync(lockPath), true)

  fs.writeFileSync(lockPath, '')
  assert.equal(backend.remove(lockPath, 'lz_anything'), false, 'an unreadable body is not ours to delete')
  assert.equal(fs.existsSync(lockPath), true)
})

test('§3.3 one key that expands to several facets makes one lease over several files', () => {
  // browser:cdp:<port> implies port:<port>: one request, two facet files, one lease id.
  // If the kernel only locked the key's first facet, a plain `port:9222` holder would
  // not see it -- the cross-class implication of §3.3 would be lost in the kernel even
  // though resources.js got it right.
  const root = freshRoot()
  const backend = localBackend(root)
  const cdp = acquireMany(backend, ['browser:cdp:9222'], { ttlMs: 30_000, reason: 'drive a browser', owner: { agent: 'cdp-holder' } })
  assert.equal(cdp.ok, true)
  assert.equal(cdp.facets.length, 2, `expected two facets, got ${JSON.stringify(cdp.facets)}`)
  assert.equal(cdp.entries.length, 2)
  assert.deepEqual(lockFiles(root).length, 2, 'one file per facet of one lease')
  for (const file of lockFiles(root)) assert.equal(file.meta?.id, cdp.id, 'both files carry the same lease id')

  // The implication is enforced through the kernel: a plain port request is blocked.
  const port = acquireMany(backend, ['port:9222'], { ttlMs: 5000, reason: 'bind the same port', owner: { agent: 'port-user' } })
  assert.equal(port.ok, false, 'port:9222 must conflict with browser:cdp:9222')
  assert.equal(port.conflicts[0].facet, facetOf('port:9222'))
  assert.equal(port.conflicts[0].heldBy.agent, 'cdp-holder')

  // Releasing the one key releases both files.
  const released = releaseMany(backend, cdp.id)
  assert.equal(released.ok, true)
  assert.equal(released.released.length, 2)
  assert.equal(lockFiles(root).length, 0)
})

// ---------------------------------------------------------------------------
// regression: releasedFacets must name each path's own facet (Lead's probe)
// ---------------------------------------------------------------------------

test('release: releasedFacets is one-to-one with released, per facet (regression)', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const keyPath = 'path:D:/released-facets'
  const keyPort = 'port:9222'
  // Two facets that expand to different files; every facet file repeats the whole
  // lease, so reporting `facets[0]` named the first facet twice and lost port:9222.
  const lease = acquireMany(backend, [{ key: keyPort }, { key: keyPath }], { ttlMs: 5000, reason: 'probe', owner: { agent: 'a' } })
  assert.equal(lease.ok, true)
  const released = releaseMany(backend, lease.id, {})

  assert.equal(released.ok, true)
  assert.equal(released.released.length, 2)
  assert.equal(released.releasedFacets.length, released.released.length, 'one facet label per released path')
  assert.equal(new Set(released.releasedFacets).size, 2, `facets must be distinct, got ${JSON.stringify(released.releasedFacets)}`)
  assert.deepEqual(released.releasedFacets.slice().sort(), [facetOf(keyPath), facetOf(keyPort)].sort())

  // ... and the label of each entry really is the facet of THAT file: index by the
  // file's own name so the check is independent of iteration order.
  const facetByFile = new Map([
    [path.basename(backend.pathFor(facetOf(keyPort), 'exclusive', 0)), facetOf(keyPort)],
    [path.basename(backend.pathFor(facetOf(keyPath), 'exclusive', 0)), facetOf(keyPath)],
  ])
  for (let i = 0; i < released.released.length; i += 1) {
    const expected = facetByFile.get(path.basename(released.released[i]))
    assert.equal(released.releasedFacets[i], expected, `label ${i} must match ${released.released[i]}`)
  }
})

test('release: a lease whose facet files are all gone reports them as missing, not released', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const lease = acquireMany(backend, ['path:D:/gone'], { ttlMs: 5000, reason: 'vanishing', owner: { agent: 'a' } })
  assert.equal(lease.ok, true)
  for (const entry of lease.entries) fs.rmSync(entry.lockPath, { force: true })
  const released = releaseMany(backend, lease.id)
  assert.equal(released.ok, true)
  assert.deepEqual(released.released, [])
  assert.deepEqual(released.releasedFacets, [], 'facets and paths stay in step even when everything is gone')
  assert.equal(released.missing.length, lease.entries.length)
})

// ---------------------------------------------------------------------------
// known limitation: filesystem aliases break facet equality (§2/§8 gap)
// ---------------------------------------------------------------------------

test('KNOWN LIMITATION §2/§8: an 8.3 short path and its long name are NOT the same facet', () => {
  // This test RECORDS current behaviour rather than blessing it. §2 forbids symlink
  // resolution and says nothing about Windows 8.3 aliases, so canonicalPath() keeps
  // whatever spelling the caller passed. Two agents naming one directory differently
  // therefore hold two different facet files and mutual exclusion silently fails.
  //
  // Fixing it needs alias resolution in resources.js canonicalPath() (realpath-based)
  // AND the same rule in cli/lease.ps1, plus a contract decision on the TOCTOU that
  // §10 excluded. It is a §2/§8 change, not something the lock kernel may decide.
  //
  // Empirically on this platform: fs.realpathSync.native() resolves 8.3 -> long names
  // and junctions, while fs.realpathSync() does NOT resolve 8.3.
  const shortKey = 'path:C:/Users/JOHNDO~1/AppData/Local/Temp/out'
  const longKey = 'path:C:/Users/JohnDoe/AppData/Local/Temp/out'
  assert.notEqual(facetOf(shortKey), facetOf(longKey), 'documented gap: aliases are distinct facets')

  const root = freshRoot()
  const backend = localBackend(root)
  const a = acquireMany(backend, [shortKey], { ttlMs: 5000, reason: 'short spelling', owner: { agent: 'short' } })
  const b = acquireMany(backend, [longKey], { ttlMs: 5000, reason: 'long spelling', owner: { agent: 'long' } })
  // The gap, stated as an assertion so a future fix turns this test red on purpose.
  assert.equal(a.ok, true)
  assert.equal(
    b.ok,
    true,
    'if this ever fails, alias resolution landed somewhere -- update §2/§8 and delete this test',
  )
  assert.notEqual(a.id, b.id)
  assert.notEqual(a.entries[0].lockPath, b.entries[0].lockPath, 'two facet files for one directory: the known gap')
  releaseMany(backend, a.id)
  releaseMany(backend, b.id)
})

// ---------------------------------------------------------------------------
// §8 no silent degradation: a weak model must announce itself
// ---------------------------------------------------------------------------

test('§8 a degraded resource model warns once instead of silently weakening exclusion', () => {
  const messages = []
  const stub = {
    // A model that knows how to canonicalise and expand, but NOT how to decide
    // conflicts: the kernel must fall back to exact equality AND say so.
    canonicalKey: (key) => String(key).toLowerCase(),
    expandFacets: (key) => [String(key).toLowerCase()],
    orderKey: (facet) => String(facet),
    sanitizeKey: (key) => String(key).replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase(),
  }
  try {
    setResourceModel(stub)
    setModelWarningSink((message) => messages.push(message))
    const root = freshRoot()
    const backend = localBackend(root)
    const a = acquireMany(backend, ['path:d:/one'], { ttlMs: 5000, reason: 'stub model', owner: { agent: 'a' } })
    assert.equal(a.ok, true)
    // Ancestor conflict is invisible to the exact-equality fallback: this documents the
    // weakening that the warning announces.
    const b = acquireMany(backend, ['path:d:/one/sub'], { ttlMs: 5000, reason: 'stub model', owner: { agent: 'b' } })
    assert.equal(b.ok, true, 'the fallback under-approximates: exactly why it must warn')
    assert.equal(messages.length, 1, `expected exactly one degradation warning, got ${JSON.stringify(messages)}`)
    assert.match(messages[0], /facetsConflict/)
    assert.match(messages[0], /WEAKER/)

    // The warning is emitted once per member, not once per acquire.
    acquireMany(backend, ['path:d:/two'], { ttlMs: 5000, reason: 'second acquire' })
    assert.equal(messages.length, 1, 'still just the one warning')
  } finally {
    setResourceModel(null)
    setModelWarningSink(null)
  }

  // With the real model back in force, the ancestor conflict is detected again.
  const root = freshRoot()
  const backend = localBackend(root)
  const outer = acquireMany(backend, ['path:D:/anc'], { ttlMs: 5000, reason: 'real model', owner: { agent: 'a' } })
  assert.equal(outer.ok, true)
  const inner = acquireMany(backend, ['path:D:/anc/sub'], { ttlMs: 5000, reason: 'real model', owner: { agent: 'b' } })
  assert.equal(inner.ok, false, 'the real model must catch the ancestor conflict')
  assert.equal(inner.conflicts[0].facet, facetOf('path:D:/anc/sub'))
})

// ---------------------------------------------------------------------------
// §4.1 planning, §6 backends -- the pure parts
// ---------------------------------------------------------------------------

test('§4.1 plan: facets are merged by strength and sorted by the global order', () => {
  const plan = planAcquisition([
    { key: 'path:D:/x', mode: 'shared' },
    { key: 'path:D:/x', mode: 'exclusive' },
    { key: 'api:p:rpm', mode: 'pool', slots: 3 },
    'path:D:/y',
  ])
  const xEntry = plan.filter((entry) => entry.keys.includes('path:D:/x'))
  assert.equal(xEntry.length, 1, 'one entry per facet, not one per request')
  assert.equal(xEntry[0].mode, 'exclusive', 'the stronger mode wins')
  const poolEntry = plan.find((entry) => entry.keys.includes('api:p:rpm'))
  assert.equal(poolEntry.mode, 'pool')
  assert.equal(poolEntry.slots, 3)

  // Ascending orderKey, whatever the request order was: the whole of G2.
  const order = plan.map((entry) => orderKey(entry.facet))
  const sorted = order.slice().sort()
  assert.deepEqual(order, sorted, `plan must be sorted by orderKey; got ${JSON.stringify(order)}`)

  // Planning is order-independent: the same requests in another order give the same plan.
  const shuffled = planAcquisition(['path:D:/y', { key: 'api:p:rpm', mode: 'pool', slots: 3 }, { key: 'path:D:/x', mode: 'exclusive' }])
  assert.deepEqual(shuffled.map((entry) => entry.facet), plan.map((entry) => entry.facet))
})

test('§4.1 plan: bad requests are rejected instead of silently doing nothing', () => {
  assert.throws(() => planAcquisition([]), /at least one resource request/)
  assert.throws(() => planAcquisition(undefined), /at least one resource request/)
  assert.throws(() => planAcquisition([{ key: 'path:D:/x', mode: 'yolo' }]), /Unknown mode/)
  assert.throws(() => planAcquisition([{ key: '' }]), /non-empty key/)
  assert.throws(() => acquireMany(localBackend(freshRoot()), ['path:D:/x'], { ttlMs: 0 }), /ttlMs/)
  assert.throws(
    () => acquireMany(localBackend(freshRoot()), ['path:D:/x'], { ttlMs: 1000, strategy: 'steal' }),
    /Unknown strategy/,
  )
})

test('§6 the local backend satisfies the contract and the kernel only speaks that contract', () => {
  const backend = localBackend(freshRoot())
  assert.equal(isLeaseBackend(backend), true)
  assert.equal(assertBackend(backend), backend)
  for (const name of ['tryCreate', 'read', 'remove', 'rename', 'list', 'stat', 'pathFor']) {
    assert.equal(typeof backend[name], 'function', `LeaseBackend.${name}`)
  }
  // The kernel refuses a bare object instead of half-acquiring and dying.
  assert.equal(isLeaseBackend({}), false)
  assert.throws(() => acquireMany({}, ['path:D:/x'], { ttlMs: 1000 }), /LeaseBackend|requires/)
})

test('§6 the broker backend refuses loudly instead of pretending to work', () => {
  const broker = brokerBackend({ url: 'http://127.0.0.1:9/lease' })
  for (const name of ['tryCreate', 'read', 'remove', 'rename', 'list', 'stat', 'pathFor']) {
    assert.throws(() => broker[name]('x', 'y', 'z'), (err) => {
      assert.equal(err instanceof LeaseNotImplementedError, true, `${name} must throw LeaseNotImplementedError`)
      assert.equal(err.code, 'LEASE_NOT_IMPLEMENTED')
      assert.match(err.message, /not implemented/)
      return true
    }, `${name} must refuse`)
  }
  // §8.3: never silently degrade to a local lock for cross-machine work.
  assert.throws(
    () => acquireMany(broker, ['path:D:/x'], { ttlMs: 1000, reason: 'cross machine' }),
    (err) => err.code === 'LEASE_NOT_IMPLEMENTED',
  )
})

test('release of an unknown id is a no-op, not an error', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const result = releaseMany(backend, 'lz_doesnotexist')
  assert.equal(result.ok, true)
  assert.deepEqual(result.released, [])
  assert.deepEqual(result.kept, [])
  // A path-traversal id is rejected before it can touch the filesystem.
  const unsafe = releaseMany(backend, '../escape')
  assert.equal(unsafe.ok, false)
  assert.match(unsafe.error, /invalid lease id/)
})

test('§4.2 the aggregate record covers every facet of a multi-facet lease', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const lease = acquireMany(backend, ['path:D:/agg1', 'path:D:/agg2'], { ttlMs: 60_000, reason: 'two facets', owner: { agent: 'agg' } })
  assert.equal(lease.ok, true)
  const record = JSON.parse(fs.readFileSync(path.join(root, INDEX_DIR, `${lease.id}.json`), 'utf8'))
  assert.equal(record.id, lease.id)
  assert.equal(record.paths.length, lease.entries.length)
  assert.deepEqual(record.facets.slice().sort(), lease.facets.slice().sort())
  // v1 readers (CLI, index.js) need `path`, `key` and a STRING owner.
  assert.equal(typeof record.path, 'string')
  assert.equal(typeof record.owner, 'string')
  assert.equal(record.owner, 'agg')
  assert.equal(typeof record.key, 'string')
  // Every facet file repeats the lease: whose lease it is, the COMPLETE facet set (known
  // before any file is written), and the paths claimed up to itself. The union across
  // the files therefore covers the whole lease, which is what lets a release rebuild
  // itself with no index at all.
  const claimedUnion = new Set()
  for (const entry of lease.entries) {
    const meta = readMeta(entry.lockPath)
    assert.equal(meta.id, lease.id)
    assert.equal(meta.facet, entry.facet, 'each file names its OWN facet, not the first one')
    assert.deepEqual(meta.facets.slice().sort(), lease.facets.slice().sort(), 'the full facet set is known upfront')
    assert.equal(meta.paths.includes(entry.lockPath), true, 'a file always names itself')
    for (const claimed of meta.paths) claimedUnion.add(claimed)
  }
  assert.deepEqual([...claimedUnion].sort(), record.paths.slice().sort(), 'together the files name every path of the lease')
  assert.equal(releaseMany(backend, lease.id).ok, true)
})

test('§5 ownerInfo survives the round trip in all three shapes v1 and v2 write', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const lease = acquireMany(backend, ['path:D:/own'], {
    ttlMs: 60_000,
    reason: 'owner shape',
    owner: { agent: 'writer', session: 'session-42', procStart: currentProcStart() },
  })
  assert.equal(lease.ok, true)
  const meta = readMeta(lease.entries[0].lockPath)
  // v2 shape...
  assert.equal(meta.ownerInfo.agent, 'writer')
  assert.equal(meta.ownerInfo.session, 'session-42')
  assert.equal(meta.ownerInfo.pid, process.pid)
  assert.equal(meta.ownerInfo.host, hostname())
  assert.equal(typeof meta.ownerInfo.procStart, 'number')
  // ...plus the flat v1-compatible fields the CLI and index.js read.
  assert.equal(meta.owner, 'writer')
  assert.equal(meta.pid, process.pid)
  assert.equal(meta.host, hostname())
  assert.equal(meta.key, 'path:D:/own')
  assert.equal(meta.mode, 'exclusive')

  // A v1 file (no ownerInfo at all) still yields a usable owner record.
  const legacyPath = path.join(root, 'legacy.lock')
  writeLockFile(legacyPath, { id: 'lz_legacy000001', key: 'path:D:/legacy', owner: 'old-cli', pid: 999_999, host: hostname(), expiresAt: 1 })
  const legacy = readMeta(legacyPath)
  assert.equal(isOwnerAlive(legacy), false, 'an expired v1 lease is dead')
  assert.equal(releaseMany(backend, lease.id).ok, true)
})

test('§2 sanitizeKey agrees with resources.js, so one key never names two files', () => {
  if (typeof resourceModel.sanitizeKey !== 'function') return // model keeps its own copy only
  const samples = [
    'path:D:/out',
    'Browser:Chromium',
    'browser:profile:work',
    'port:9222',
    'api:openai:rpm',
    'path:C:/Users/x/AppData/Local/ms-playwright/chromium-1148',
    'named:Some Job',
  ]
  for (const sample of samples) {
    assert.equal(
      sanitizeKey(sample),
      String(resourceModel.sanitizeKey(sample)),
      `lock.js and resources.js disagree on ${sample}: two lock files for one resource`,
    )
  }
})

// ---------------------------------------------------------------------------
// REGRESSION (v2 review, blocking items B1/B2/B4/B6/B7)
// ---------------------------------------------------------------------------

/**
 * @param {string} root lock root.
 * @returns {string[]} the aggregate index record names, when the directory exists.
 */
function indexFiles(root) {
  try {
    return fs.readdirSync(path.join(root, INDEX_DIR)).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

test('B1 §2.1 an invalid key is REFUSED on acquire and leaves nothing on disk', () => {
  // The review's reproduction: the kernel used to catch resources.js's parse error
  // and keep the RAW spelling, so every one of these acquired a lock file of its
  // own (`port_30-20.lock`, `path_.lock`) while the CLI rejected the same key.
  const malformed = [
    ['port:30-20', /lo <= hi/],
    ['port:99999', /outside the port range/],
    ['path:', /empty subject/],
    ['port:', /empty subject/],
  ]
  for (const [key, why] of malformed) {
    const root = freshRoot()
    const backend = localBackend(root)
    assert.throws(
      () => acquireMany(backend, [key], { ttlMs: 5000, reason: 'b1' }),
      (err) => {
        assert.match(err.message, why, `${key}: the model's reason must survive`)
        assert.match(err.message, new RegExp(`Invalid resource key "${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), `${key}: the message must name the key`)
        assert.equal(err.code, 'LEASE_INVALID_KEY')
        assert.equal(err.key, key)
        return true
      },
      `${key} must be refused`,
    )
    assert.equal(lockFiles(root).length, 0, `${key} must not leave a lock file behind`)
    assert.deepEqual(indexFiles(root), [], `${key} must not leave an index record behind`)
  }

  // The READ direction stays tolerant (§2.1): a key found on disk, or passed to a
  // status query, must not throw -- that would blind the caller to foreign locks.
  assert.equal(canonicalKey('port:30-20'), 'port:30-20')
  assert.deepEqual(facetsOf('path:'), ['path:'])
  // planAcquisition is the acquire entry point, so it is strict too.
  assert.throws(() => planAcquisition(['port:30-20']), /Invalid resource key "port:30-20"/)
})

test('B2 §2 a relative path key is refused instead of being resolved against the cwd', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  for (const key of ['path:out', 'path:../up', 'path:./sub']) {
    assert.throws(
      () => acquireMany(backend, [key], { ttlMs: 5000, reason: 'b2' }),
      (err) => {
        assert.match(err.message, /must be ABSOLUTE/, `${key}: the rule must be stated`)
        assert.equal(err.code, 'LEASE_INVALID_KEY')
        return true
      },
      `${key} must be refused`,
    )
  }
  assert.equal(lockFiles(root).length, 0, 'a rejected relative key leaves no lock file')

  // resources.js itself refuses it now (it used to fall back to process.cwd()).
  assert.throws(() => resourceModel.canonicalKey('path:out'), /must be ABSOLUTE/)
  assert.throws(() => resourceModel.canonicalPath('out'), /must be ABSOLUTE/)
  // Drive-relative (C:out) is cwd-dependent too, and the CLI rejects it as well.
  assert.throws(() => resourceModel.canonicalPath('C:out'), /drive-relative/)
  // An explicit base is still honoured: that is the caller saying where it means.
  assert.equal(resourceModel.canonicalKey('path:out', { base: 'D:/work' }), 'path:d:/work/out')
  // pathKey() is the entry point for a BARE path, so it resolves one itself.
  assert.equal(resourceModel.pathKey('out', { base: 'D:/work' }), 'path:d:/work/out')
  assert.equal(resourceModel.pathKey('D:/abs/dir'), 'path:d:/abs/dir')

  // An absolute path still acquires, so the check is not simply "paths are broken".
  const ok = acquireMany(backend, ['path:D:/rel/ok'], { ttlMs: 5000, reason: 'b2' })
  assert.equal(ok.ok, true)
  releaseMany(backend, ok.id)
})

test('B4 a bad key is reported as a bad key, not as a missing resources.js export', () => {
  const messages = []
  // Re-arm the once-per-key notices: an earlier test already reported a bad key,
  // and this test is about the TEXT of the notice, not about suppress-on-repeat.
  setResourceModel(null)
  try {
    setModelWarningSink((message) => messages.push(message))
    const backend = localBackend(freshRoot())
    assert.throws(() => acquireMany(backend, ['port:70000'], { ttlMs: 5000, reason: 'b4' }))
  } finally {
    setModelWarningSink(null)
  }
  assert.equal(messages.length, 1, `one warning, got ${JSON.stringify(messages)}`)
  assert.match(messages[0], /"port:70000"/, 'the warning must name the offending key')
  assert.match(messages[0], /outside the port range/, 'it must quote what is actually wrong')
  // The old text sent operators hunting for a packaging problem that never existed.
  assert.doesNotMatch(messages[0], /does not provide/)
  assert.doesNotMatch(messages[0], /does not export/)

  // A genuinely missing export still uses the degradation channel.
  const degraded = []
  try {
    setResourceModel({ canonicalKey: (key) => String(key), expandFacets: (key) => [String(key)] })
    setModelWarningSink((message) => degraded.push(message))
    const backend = localBackend(freshRoot())
    acquireMany(backend, ['path:d:/deg'], { ttlMs: 5000, reason: 'b4' })
  } finally {
    setResourceModel(null)
    setModelWarningSink(null)
  }
  assert.equal(degraded.length, 1)
  assert.match(degraded[0], /does not provide orderKey\(\)|does not provide facetsConflict\(\)/)
})

test('B6 §4.1 step 1.5 a request that contradicts itself is refused as a whole', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  assert.throws(
    () => acquireMany(backend, ['path:D:/x1', 'path:D:/x1/sub'], { ttlMs: 5000, reason: 'b6' }),
    (err) => {
      assert.equal(err.code, 'LEASE_SELF_CONFLICTING')
      // The message must name BOTH facets, so the caller can see the contradiction.
      assert.match(err.message, /path:d:\/x1/)
      assert.match(err.message, /path:d:\/x1\/sub/)
      return true
    },
  )
  // Nothing was half-acquired and rolled back: nothing was written at all.
  assert.equal(lockFiles(root).length, 0, 'a self-conflicting request leaves no lock file')
  assert.deepEqual(indexFiles(root), [], 'nor an index record')

  // Legitimate groups still pass: sibling paths, and one key whose facets imply
  // each other (browser:cdp:9222 holds its own port facet).
  const siblings = acquireMany(backend, ['path:D:/x1a', 'path:D:/x1b'], { ttlMs: 5000, reason: 'b6 ok' })
  assert.equal(siblings.ok, true)
  releaseMany(backend, siblings.id)
  const cdp = acquireMany(backend, ['browser:cdp:9433', { key: 'browser:profile:p1' }], { ttlMs: 5000, reason: 'b6 ok' })
  assert.equal(cdp.ok, true, 'a key must not conflict with its own expansion')
  releaseMany(backend, cdp.id)

  // Same facet asked twice is MERGED (stronger mode wins), never "self-conflicting".
  const merged = acquireMany(backend, [
    { key: 'path:D:/merge', mode: 'shared' },
    { key: 'path:D:/merge', mode: 'exclusive' },
  ], { ttlMs: 5000, reason: 'b6 merge' })
  assert.equal(merged.ok, true)
  assert.equal(merged.facets.length, 1)
  releaseMany(backend, merged.id)
})

test('B7 §8.6 shared is a single holder, and it uses the same file the CLI writes', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const shared = acquireMany(backend, [{ key: 'port:9441', mode: 'shared' }], { ttlMs: 60_000, reason: 'b7', owner: { agent: 'reader-1' } })
  assert.equal(shared.ok, true)

  // The storage layout is the contract's: ONE <base>.lock, no per-reader file.
  const expected = path.join(root, `${sanitizeKey('port:9441')}.lock`)
  assert.equal(shared.entries[0].lockPath, expected)
  assert.equal(backend.pathFor(facetOf('port:9441'), 'shared', 5), expected, 'a shared slot index must not invent a file name')
  assert.deepEqual(lockFiles(root).map((file) => file.name), [path.basename(expected)])

  // A second shared request is refused by the STORE even though the §3.2 predicate
  // exempts shared+shared -- which is exactly what §8.6 says happens in v2.0.
  assert.equal(
    resourceModel.facetsConflict('port:9441', 'shared', 'port:9441', 'shared'),
    false,
    'the predicate still allows shared+shared (matrix 10); the store is what refuses it',
  )
  const second = acquireMany(backend, [{ key: 'port:9441', mode: 'shared' }], { ttlMs: 60_000, reason: 'b7', owner: { agent: 'reader-2' } })
  assert.equal(second.ok, false, 'a second shared holder must be refused, not given a .shared-N file')
  assert.equal(second.conflicts[0].facet, facetOf('port:9441'))
  assert.deepEqual(lockFiles(root).map((file) => file.name), [path.basename(expected)], 'still exactly one file for the facet')

  // pool is the sanctioned way to admit N readers.
  const pool = acquireMany(backend, [{ key: 'port:9442', mode: 'pool', slots: 2 }], { ttlMs: 60_000, reason: 'b7', owner: { agent: 'pool-1' } })
  assert.equal(pool.ok, true)
  const pool2 = acquireMany(backend, [{ key: 'port:9442', mode: 'pool', slots: 2 }], { ttlMs: 60_000, reason: 'b7', owner: { agent: 'pool-2' } })
  assert.equal(pool2.ok, true, 'a pool of 2 admits two readers')
  assert.equal(pool2.entries[0].slot, 1)
  releaseMany(backend, shared.id)
  releaseMany(backend, pool.id)
  releaseMany(backend, pool2.id)
})

test('§5 pidGated:false is NOT evidence of death, so a live CLI lease survives a plugin acquire', async () => {
  // Found while verifying B7. §5: "CLI 必须写 false -- CLI 是一次性进程 ... 若参与 PID
  // 回收,每条 CLI 租约都会被下一个进程立刻判定'持有者已死'并回收,互斥会稳定崩溃".
  // The kernel used to drop pidGated and judge such a lease by its (dead) pid, so a
  // plugin acquire took over a LIVE CLI lock -- two holders on one facet (G1).
  const deadPid = await findDeadPid()
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'port:9455'
  const facet = facetOf(key)
  const lockPath = backend.pathFor(facet, 'exclusive', 0)

  /** @param {boolean} pidGated write a CLI-shaped record (owner string + ownerInfo). */
  const cliLease = (pidGated) => ({
    id: 'lz_clilease0001',
    key,
    canonicalKey: key,
    facet,
    facets: [facet],
    mode: 'exclusive',
    slots: 1,
    slot: 0,
    owner: 'cli-agent',
    ownerInfo: { agent: 'cli-agent', session: 'sess-cli', pid: deadPid, host: hostname(), procStart: 1, pidGated },
    reason: 'a one-shot CLI acquire',
    pid: deadPid,
    host: hostname(),
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000, // NOT expired: only liveness could take it
  })

  // With pidGated:false the dead pid proves nothing -> the lease still holds.
  writeLockFile(lockPath, cliLease(false))
  const meta = readMeta(lockPath)
  assert.equal(isOwnerAlive(meta), null, 'pidGated:false must be "cannot tell", never "dead"')
  const blocked = acquireMany(backend, [key], { ttlMs: 60_000, reason: 'plugin wants it', owner: { agent: 'plugin' } })
  assert.equal(blocked.ok, false, 'a live CLI lease must not be taken over by the plugin (G1)')
  assert.equal(blocked.conflicts[0].facet, facet)
  assert.equal(readMeta(lockPath).id, 'lz_clilease0001', 'the CLI lease is untouched')

  // The SAME record with pidGated:true (the default) is still reclaimed at once:
  // G3 must keep working for long-lived owners.
  writeLockFile(lockPath, { ...cliLease(true), id: 'lz_clilease0002' })
  assert.equal(isOwnerAlive(readMeta(lockPath)), false, 'a gated dead pid means reclaim now')
  const taken = acquireMany(backend, [key], { ttlMs: 60_000, reason: 'plugin takes the dead one', owner: { agent: 'plugin' } })
  assert.equal(taken.ok, true, 'a genuinely dead owner is still collected (G3)')
  assert.equal(readMeta(lockPath).id, taken.id)
  releaseMany(backend, taken.id)
})

// ---------------------------------------------------------------------------
// helpers that need the process table
// ---------------------------------------------------------------------------

/**
 * Find a pid that is definitely not running (a large, unused one), so a hand-written
 * "crashed owner" lease points at nothing.
 *
 * @returns {Promise<number>} a dead pid.
 */
async function findDeadPid() {
  for (let candidate = 400_000; candidate < 400_200; candidate += 1) {
    if (!pidExists(candidate)) return candidate
  }
  throw new Error('could not find an unused pid on this machine')
}
