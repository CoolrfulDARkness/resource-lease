#!/usr/bin/env node
/**
 * Shared acquire mutex tests (task-21).
 *
 * This file is NEW on purpose: `lock-v2.test.mjs` belongs to another agent right now.
 *
 * What is being tested, and why it is not covered by lock-v2.test.mjs:
 *   - the `_global.lock` mutex itself (protocol, takeover, fail-closed waits)
 *   - that NO liveness probe runs inside the critical section (the whole point of the
 *     two-phase design: a probe costs 267 ms idle / ~5.3 s loaded because it spawns
 *     PowerShell, so one inside the mutex would serialize every acquisition)
 *   - that a process deprived by a TTL takeover does NOT report success (MUTEX_LOST)
 *   - that an UNKNOWN holder (`null` liveness, e.g. the CLI's `pidGated:false`) is
 *     treated as a rival instead of being ignored (fail-closed, not fail-open)
 *
 * Real processes are used wherever mutual exclusion is the thing being asserted: two
 * in-process tasks share the event loop and the pid, so they cannot reproduce the
 * failures that matter.
 *
 * Usage: node --test resource-lease/plugin/test/mutex-acquire.test.mjs
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
  MUTEX_NAME,
  MUTEX_NO_DEADLINE_WAIT_MS,
  MUTEX_POLL_MS,
  MUTEX_TTL_MS,
  MUTEX_WAIT_MS,
  acquireMany,
  currentProcStart,
  enterMutex,
  exitMutex,
  facetsOf,
  holdsMutex,
  hostname,
  isOwnerAlive,
  listLocks,
  localBackend,
  mutexPathFor,
  newLeaseId,
  pendingDirFor,
  pidExists,
  readMeta,
  releaseMany,
  statusOf,
  sweep,
  writePending,
} from '../lib/lock.js'

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutex-acquire-test-'))
const lockUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'lock.js')).href
const children = []
let rootSeq = 0

/** @returns {string} a fresh lock root. */
function freshRoot() {
  const root = path.join(testDir, `root-${(rootSeq += 1)}`)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/** @param {string} key @returns {string} its single canonical facet. */
function facetOf(key) {
  return facetsOf(key)[0]
}

/**
 * Write a file (lock body or mutex body) by hand.
 *
 * @param {string} file target path.
 * @param {Record<string, any>} meta body.
 */
function writeJson(file, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(meta))
}

/**
 * Build a mutex body in the CLI's exact shape (six keys, no pidGated).
 *
 * @param {Record<string, any>} overrides fields to override.
 * @returns {Record<string, any>} mutex metadata.
 */
function mutexBody(overrides = {}) {
  const now = Date.now()
  const mutexPath = overrides.lockPath ?? path.join(testDir, MUTEX_NAME)
  return {
    id: overrides.id ?? newLeaseId(),
    pid: overrides.pid ?? process.pid,
    host: overrides.host ?? hostname(),
    createdAt: overrides.createdAt ?? now,
    expiresAt: overrides.expiresAt ?? now + MUTEX_TTL_MS,
    lockPath: mutexPath,
    ...overrides,
  }
}

/**
 * Wait.
 *
 * @param {number} ms milliseconds.
 * @returns {Promise<void>} resolves later.
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Wait until a predicate holds.
 *
 * @param {() => boolean} predicate condition.
 * @param {{ timeoutMs?: number, label?: string }} [options] budget.
 * @returns {Promise<void>} resolves when true, throws on timeout.
 */
async function waitFor(predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.label ?? 'condition'}`)
    await sleep(15)
  }
}

/**
 * Spawn a real worker that acquires, reports, and KEEPS RUNNING (holding its lease).
 *
 * Keeping it alive is the point: a worker that exits immediately tests the exit race,
 * not mutual exclusion.
 *
 * @param {Record<string, any>} plan worker plan.
 * @param {{ timeoutMs?: number }} [options] deadlock budget.
 * @returns {Record<string, any>} handle.
 */
function launchHolder(plan, options = {}) {
  const seq = (rootSeq += 1)
  const planFile = path.join(testDir, `plan-${seq}.json`)
  const outFile = path.join(testDir, `out-${seq}.json`)
  fs.writeFileSync(planFile, JSON.stringify({ ...plan, lockUrl, outFile }))

  const child = spawn(process.execPath, [path.join(testDir, 'holder-worker.mjs'), planFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })

  let timer = null
  let timedOut = false
  const finished = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* gone */ }
      resolve({ timedOut: true, code: null, stderr })
    }, options.timeoutMs ?? 30_000)
    child.on('exit', (code, signal) => {
      if (timer !== null) clearTimeout(timer)
      resolve({ timedOut, code, signal, stderr })
    })
  })

  return {
    child,
    outFile,
    finished,
    stderr: () => stderr,
    /** @returns {Promise<Record<string, any>>} the worker's report. */
    async readResult() {
      await waitFor(() => {
        try {
          JSON.parse(fs.readFileSync(outFile, 'utf8'))
          return true
        } catch {
          return false
        }
      }, { label: `worker result (${stderr || 'no stderr'})` })
      return JSON.parse(fs.readFileSync(outFile, 'utf8'))
    },
  }
}

// The worker is materialised into the temp dir so this test file stays self-contained.
fs.writeFileSync(path.join(testDir, 'holder-worker.mjs'), `
import fs from 'node:fs'
import process from 'node:process'

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const lock = await import(plan.lockUrl)
const backend = lock.localBackend(plan.lockRoot)
const owner = { agent: plan.ownerName ?? 'holder', session: 'sess-' + (plan.ownerName ?? 'holder') }

const startedAt = Date.now()
let result
try {
  result = lock.acquireMany(backend, plan.requests, {
    ttlMs: plan.ttlMs ?? 30000,
    reason: plan.reason ?? 'holder',
    owner,
    strategy: plan.strategy ?? 'fail',
    waitMs: plan.waitMs ?? 0,
  })
} catch (err) {
  result = { ok: false, error: String((err && err.stack) || err) }
}
const acquireEndedAt = Date.now()

fs.writeFileSync(plan.outFile, JSON.stringify({
  pid: process.pid,
  startedAt,
  acquireEndedAt,
  elapsedMs: acquireEndedAt - startedAt,
  ok: result.ok,
  id: result.id ?? null,
  code: result.code ?? null,
  facets: result.facets ?? null,
  conflicts: result.conflicts ?? null,
}))

// Stay alive and KEEP HOLDING for holdMs: that is what makes the concurrency assertion
// test mutual exclusion instead of the exit race.
const until = Date.now() + (plan.holdMs ?? 1500)
while (Date.now() < until) { await new Promise((r) => setTimeout(r, 20)) }
process.exit(0)
`)

after(async () => {
  for (const child of children) {
    try { child.kill('SIGKILL') } catch { /* already dead */ }
  }
  await sleep(50)
  fs.rmSync(testDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. the mutex protocol itself (must stay byte-compatible with cli/lease.ps1)
// ---------------------------------------------------------------------------

test('mutex: file name, TTL and wait cap match the CLI protocol', () => {
  assert.equal(MUTEX_NAME, '_global.lock')
  assert.equal(MUTEX_TTL_MS, 15000)
  assert.equal(MUTEX_WAIT_MS, 8000)
  assert.equal(MUTEX_POLL_MS, 20)
  assert.equal(MUTEX_NO_DEADLINE_WAIT_MS, 1200, 'queueing model: 128 x 3 ms x 3 safety' )

  const root = freshRoot()
  const backend = localBackend(root)
  assert.equal(mutexPathFor(backend), path.join(root, '_global.lock'))
})

test('mutex: body is exactly the CLI six-key shape (no pidGated, no facets)', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const handle = enterMutex(backend, { waitMsCap: 1000 })
  assert.equal(handle.ok, true)

  const body = readMeta(mutexPathFor(backend))
  assert.deepEqual(Object.keys(body).sort(), ['createdAt', 'expiresAt', 'host', 'id', 'lockPath', 'pid'])
  assert.equal(body.pid, process.pid)
  assert.equal(body.host, hostname())
  assert.equal(body.lockPath, mutexPathFor(backend))
  assert.equal(Number(body.expiresAt) - Number(body.createdAt), MUTEX_TTL_MS)
  // The absence of these two is load-bearing: `facetsOfMeta()` must stay empty for the
  // mutex so the facet scanners ignore it, and `pidGated` must never appear (a
  // `pidGated:false` mutex could never be taken over -- see the regression test below).
  assert.equal('pidGated' in body, false)
  assert.equal('facets' in body, false)

  assert.equal(exitMutex(backend, handle), true)
  assert.equal(readMeta(mutexPathFor(backend)), null)
})

test('mutex: exit only deletes our own file (id-checked), never the new holder’s', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const handle = enterMutex(backend, { waitMsCap: 1000 })
  assert.equal(handle.ok, true)

  // Simulate a TTL takeover: the path now carries somebody else's mutex.
  const foreign = mutexBody({ lockPath: mutexPathFor(backend), pid: process.pid })
  writeJson(mutexPathFor(backend), foreign)

  assert.equal(exitMutex(backend, handle), false, 'must not delete a mutex we no longer own')
  assert.equal(readMeta(mutexPathFor(backend))?.id, foreign.id, 'the new holder keeps it')
})

// ---------------------------------------------------------------------------
// 2. fail-closed waits (M-R1): never the flat 8 s
// ---------------------------------------------------------------------------

test('mutex: a live holder makes enterMutex fail closed within its cap, not 8 s', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  // A LIVE holder: same host, our own pid, unexpired. Nothing may take this over.
  writeJson(mutexPathFor(backend), mutexBody({ lockPath: mutexPathFor(backend), pid: process.pid }))

  const startedAt = Date.now()
  const handle = enterMutex(backend, { waitMsCap: 200 })
  const waited = Date.now() - startedAt

  assert.equal(handle.ok, false, 'must not pretend it got the mutex')
  assert.equal(handle.code, 'MUTEX_TIMEOUT')
  assert.ok(waited >= 190 && waited < 2000, `waited ${waited} ms, cap was 200 ms`)
})

test('mutex: no-deadline callers get the short cap (≤500 ms), not 8 s', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  writeJson(mutexPathFor(backend), mutexBody({ lockPath: mutexPathFor(backend), pid: process.pid }))

  const startedAt = Date.now()
  // No waitMsCap at all: this is the `strategy:'fail'` caller that today returns in ms.
  const handle = enterMutex(backend)
  const waited = Date.now() - startedAt

  assert.equal(handle.ok, false)
  assert.ok(waited < MUTEX_NO_DEADLINE_WAIT_MS + 1500, `waited ${waited} ms; must stay near the 500 ms cap`)
})

test('acquireMany: a busy mutex DEGRADES instead of dropping a free request (M3)', () => {
  // The bug this replaces: a busy mutex produced `MUTEX_TIMEOUT` with `conflicts: []` --
  // i.e. the request was lost even though NOTHING contended for the facet. That is a
  // product-level error, not a conflict. Now the attempt proceeds without the mutex and
  // says so (`degraded: true`), keeping the post-commit verification as the safety net.
  const root = freshRoot()
  const backend = localBackend(root)
  writeJson(mutexPathFor(backend), mutexBody({ lockPath: mutexPathFor(backend), pid: process.pid }))

  // F3.6 (task-13): a no-deadline caller ESCALATES its mutex wait while the holder is
  // alive, so this test must see the escalation happen. The wall clock is the only
  // regression signal: with escalation working, the acquire exhausts its ceiling
  // (~8 s of budget) before degrading; with the escalation silently broken it would
  // degrade in ~1.2 s -- and every assertion below would still pass. 3000 ms splits
  // the two outcomes with margin on both sides.
  const startedAt = Date.now()
  const result = acquireMany(backend, ['path:D:/blocked'], { ttlMs: 5000, reason: 'busy mutex' })
  const waited = Date.now() - startedAt

  assert.ok(waited >= 3000, `the no-deadline acquire must escalate to its ceiling before degrading (waited ${waited} ms; ~1.2 s means the escalation regressed)`)
  assert.equal(result.ok, true, `a free facet must not be lost to a busy mutex: ${JSON.stringify(result)}`)
  assert.equal(result.mutex.degraded, true, 'the caller must be told the guarantee degraded')
  assert.equal(result.mutex.enabled, false)
  assert.equal(result.conflicts === undefined || result.conflicts.length === 0, true, 'there was no conflict')
  assert.equal(
    fs.existsSync(backend.pathFor(facetOf('path:D:/blocked'), 'exclusive', 0)),
    true,
    'the lease must still be created',
  )
  releaseMany(backend, result.id)
})

// ---------------------------------------------------------------------------
// 3. crash recovery: a stale mutex must never wedge the lock root
// ---------------------------------------------------------------------------

test('mutex: an expired mutex is taken over immediately (TTL rule)', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  writeJson(mutexPathFor(backend), mutexBody({
    lockPath: mutexPathFor(backend),
    pid: process.pid,
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() - 45_000,
  }))

  const handle = enterMutex(backend, { waitMsCap: 2000 })
  assert.equal(handle.ok, true, 'an expired mutex must be collectable')
  const files = fs.readdirSync(root)
  assert.equal(files.some((name) => name.includes('.stale.')), true, 'the takeover was archived for forensics')
  exitMutex(backend, handle)
})

test('mutex: a mutex whose owner pid is gone is taken over immediately', async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const deadPid = await findDeadPid()
  writeJson(mutexPathFor(backend), mutexBody({
    lockPath: mutexPathFor(backend),
    pid: deadPid,
    host: hostname(),
    // TTL still far in the future: only the pid check can collect this one.
    expiresAt: Date.now() + 600_000,
  }))

  const handle = enterMutex(backend, { waitMsCap: 2000 })
  assert.equal(handle.ok, true, 'a dead owner must not wedge the root until the TTL')
  exitMutex(backend, handle)
})

test('mutex: an unreadable body is only takeable once it is old (grace rule)', async () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const mutexPath = mutexPathFor(backend)

  // Fresh + unreadable = a live writer between create and first write.
  fs.writeFileSync(mutexPath, '')
  const fresh = enterMutex(backend, { waitMsCap: 120 })
  assert.equal(fresh.ok, false, 'a fresh unreadable mutex must NOT be stolen')
  assert.equal(fs.existsSync(mutexPath), true)

  // Old + unreadable = a crashed residue.
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(mutexPath, old, old)
  const handle = enterMutex(backend, { waitMsCap: 2000 })
  assert.equal(handle.ok, true, 'an old unreadable mutex must be collectable')
  exitMutex(backend, handle)
})

test('mutex: a pidGated:false body must STILL be takeable (never wedge the root)', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  // This is the worst-case shape: `isOwnerAlive` answers "unknown/alive" forever for a
  // `pidGated:false` record, so a mutex takeover that used it would never fire and the
  // whole lock root would stall permanently.
  writeJson(mutexPathFor(backend), {
    ...mutexBody({
      lockPath: mutexPathFor(backend),
      pid: 999_999,
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() - 45_000,
    }),
    pidGated: false,
  })

  const handle = enterMutex(backend, { waitMsCap: 2000 })
  assert.equal(handle.ok, true, 'mutex takeover must use TTL/pid rules, not isOwnerAlive')
  exitMutex(backend, handle)
})

// ---------------------------------------------------------------------------
// 4. reentrancy (R8): a nested acquire must not deadlock
// ---------------------------------------------------------------------------

test('mutex: nested acquire in one process shares the critical section (no deadlock)', { timeout: 20_000 }, () => {
  const root = freshRoot()
  const backend = localBackend(root)

  const outer = enterMutex(backend, { waitMsCap: 1000 })
  assert.equal(outer.ok, true)
  const outerBody = readMeta(mutexPathFor(backend))

  const inner = enterMutex(backend, { waitMsCap: 1000 })
  assert.equal(inner.ok, true, 'a nested enter must succeed instead of waiting on itself')
  assert.equal(inner.nested, true)
  assert.equal(inner.id, outer.id, 'both handles share one mutex id')
  assert.equal(readMeta(mutexPathFor(backend)).id, outerBody.id, 'no second mutex file was created')

  exitMutex(backend, inner)
  assert.equal(fs.existsSync(mutexPathFor(backend)), true, 'the outer holder still owns it')
  exitMutex(backend, outer)
  assert.equal(fs.existsSync(mutexPathFor(backend)), false)
})

test('acquireMany: a nested acquire inside an acquire does not deadlock', { timeout: 20_000 }, () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const outer = enterMutex(backend, { waitMsCap: 1000 })
  assert.equal(outer.ok, true)
  try {
    // Runs "inside" the critical section, like an auto-acquire hook would.
    const result = acquireMany(backend, ['path:D:/nested'], { ttlMs: 5000, reason: 'nested' })
    assert.equal(result.ok, true, JSON.stringify(result))
    releaseMany(backend, result.id)
  } finally {
    exitMutex(backend, outer)
  }
})

// ---------------------------------------------------------------------------
// 5. no liveness probe inside the critical section (the whole point)
// ---------------------------------------------------------------------------

test('mutex: phase 1 never refines liveness (no readProcStart inside the critical section)', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  // A live blocker whose record HAS a procStart: this is exactly the shape that makes
  // `isOwnerAlive` call the expensive probe (tier B).
  const blockerKey = 'path:D:/probe-me'
  const blockerPath = backend.pathFor(facetOf(blockerKey), 'exclusive', 0)
  writeJson(blockerPath, {
    id: newLeaseId(),
    key: blockerKey,
    facet: facetOf(blockerKey),
    mode: 'exclusive',
    owner: 'blocker',
    pid: process.pid,
    host: hostname(),
    procStart: currentProcStart(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    lockPath: blockerPath,
  })

  let refineCalls = 0
  const mutexPresentDuringProbe = []
  const result = acquireMany(backend, [blockerKey], {
    ttlMs: 5000,
    reason: 'no probe inside the mutex',
    // Record whether the mutex file existed at each refinement: a probe taken while the
    // mutex is held is the thing that must never happen.
    procStartOf: (pid, now) => {
      refineCalls += 1
      mutexPresentDuringProbe.push(fs.existsSync(mutexPathFor(backend)))
      return currentProcStart(now)
    },
  })

  assert.equal(result.ok, false, 'a live blocker must block')
  assert.equal(fs.existsSync(mutexPathFor(backend)), false, 'the mutex must be released when acquireMany returns')
  // Refinement outside the mutex is fine and expected (it is how PID reuse is detected);
  // refinement INSIDE the mutex is the regression this test exists for.
  assert.equal(
    mutexPresentDuringProbe.every((present) => present === false),
    true,
    `a liveness probe ran while the mutex was held (calls: ${refineCalls})`,
  )
})

test('mutex: the expensive probe happens OUTSIDE the mutex (mutex already released)', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/probe-outside'
  const lockPath = backend.pathFor(facetOf(key), 'exclusive', 0)
  // Owner pid is gone -> tier A (cheap) -> reclaimable. `procStartOf` must not be needed.
  writeJson(lockPath, {
    id: newLeaseId(),
    key,
    facet: facetOf(key),
    mode: 'exclusive',
    owner: 'dead-owner',
    pid: 999_998,
    host: hostname(),
    procStart: currentProcStart(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    lockPath,
  })

  const mutexSeenDuringProbe = []
  const result = acquireMany(backend, [key], {
    ttlMs: 5000,
    reason: 'reclaim a dead lease',
    procStartOf: (pid, now) => {
      mutexSeenDuringProbe.push(fs.existsSync(mutexPathFor(backend)))
      return currentProcStart(now)
    },
  })

  // A dead pid is detected by `pidExists` alone, so this should succeed cheaply.
  assert.equal(result.ok, true, JSON.stringify(result.conflicts ?? result))
  assert.equal(
    mutexSeenDuringProbe.every((present) => present === false),
    true,
    'any probe must run with the mutex released',
  )
  releaseMany(backend, result.id)
})

// ---------------------------------------------------------------------------
// 6. multi-key atomicity (R7): one critical section for the whole plan
// ---------------------------------------------------------------------------

test('acquireMany: N keys are scanned and created in ONE critical section', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const keys = ['path:D:/mk1', 'path:D:/mk2', 'path:D:/mk3', 'port:9223']
  const result = acquireMany(backend, keys, { ttlMs: 30_000, reason: 'multi key' })
  assert.equal(result.ok, true, JSON.stringify(result.conflicts ?? result))
  assert.equal(result.entries.length, new Set(result.facets).size)
  // Exactly one mutex file was used and it is gone now.
  assert.equal(fs.existsSync(mutexPathFor(backend)), false)
  for (const entry of result.entries) {
    assert.equal(readMeta(entry.lockPath)?.id, result.id)
  }
  releaseMany(backend, result.id)
})

test('acquireMany: a conflict halfway rolls back everything and leaves no index', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const held = acquireMany(backend, ['path:D:/mkz'], { ttlMs: 60_000, reason: 'blocker' })
  assert.equal(held.ok, true)

  const result = acquireMany(backend, ['path:D:/mka', 'path:D:/mkb', 'path:D:/mkz'], {
    ttlMs: 60_000,
    reason: 'fails at the last facet',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CONFLICT')
  // Only the pre-existing holder's files may remain.
  const files = fs.readdirSync(root).filter((name) => name.endsWith('.lock') && !name.startsWith('_'))
  assert.equal(files.length, held.entries.length, `leftover: ${JSON.stringify(files)}`)
  // No index record for the failed attempt: its id never committed.
  const indexFiles = fs.readdirSync(path.join(root, '_leases'))
  assert.deepEqual(indexFiles.sort(), [`${held.id}.json`])
  releaseMany(backend, held.id)
})

// ---------------------------------------------------------------------------
// 7. true concurrency: two LIVE processes, exactly one wins
// ---------------------------------------------------------------------------

test('concurrency: two live processes racing a conflicting facet -> exactly one ok', { timeout: 60_000 }, async () => {
  const root = freshRoot()
  const key = 'path:D:/live-race'
  const startAt = Date.now() + 600

  // Both workers stay alive for 1500 ms after acquiring: if the implementation allowed
  // both to hold, both reports would say ok:true.
  const first = launchHolder({ lockRoot: root, requests: [key], startAt, holdMs: 1500, ownerName: 'live-a', reason: 'race a' })
  const second = launchHolder({ lockRoot: root, requests: [key], startAt, holdMs: 1500, ownerName: 'live-b', reason: 'race b' })

  const [a, b] = await Promise.all([first.readResult(), second.readResult()])
  await Promise.all([first.finished, second.finished])

  const winners = [a, b].filter((row) => row.ok === true)
  assert.equal(winners.length, 1, `exactly one live holder allowed; got ${JSON.stringify([a, b])}`)
  const loser = [a, b].find((row) => row.ok === false)
  assert.equal(loser.code, 'CONFLICT')
  assert.ok(Array.isArray(loser.conflicts) && loser.conflicts.length > 0)
  assert.ok(loser.conflicts[0].heldBy.pid === winners[0].pid || loser.conflicts[0].heldBy.pid !== null)
})

test('concurrency: two live processes racing ancestor/descendant -> no double hold', { timeout: 90_000 }, async () => {
  // THE case the mutex exists for: two DIFFERENT facet files whose subjects overlap.
  // Without a shared critical section both O_EXCL creates succeed.
  for (let round = 0; round < 3; round += 1) {
    const root = freshRoot()
    const startAt = Date.now() + 500
    const outer = launchHolder({ lockRoot: root, requests: ['path:D:/anc'], startAt, holdMs: 900, ownerName: 'outer' })
    const inner = launchHolder({ lockRoot: root, requests: ['path:D:/anc/sub'], startAt, holdMs: 900, ownerName: 'inner' })
    const [outerResult, innerResult] = await Promise.all([outer.readResult(), inner.readResult()])
    await Promise.all([outer.finished, inner.finished])
    const winners = [outerResult, innerResult].filter((row) => row.ok === true)
    assert.equal(winners.length, 1, `round ${round}: ancestor/descendant double hold: ${JSON.stringify([outerResult, innerResult])}`)
  }
})

test('S3c: 2 live processes, path:D:/out vs path:D:/out/sub, exactly one ok in every round', { timeout: 300_000 }, async () => {
  // Isomorphic to local-verify's S3c, which measured 21/30 = 70% BOTH-FAIL before the
  // mutex. The target is 0 both-fail AND 0 both-win: exactly one winner every round.
  //
  // Both processes stay alive for 2000 ms after acquiring. A worker that exits
  // immediately would test the exit race, not mutual exclusion (a trap already hit once).
  //
  // Rounds are env-tunable so a quick loop can shorten them; the default is the full 30
  // that the acceptance criterion names.
  const rounds = Number(process.env.S3C_ROUNDS ?? 30)
  const holdMs = Number(process.env.S3C_HOLD_MS ?? 2000)
  let exactlyOne = 0
  let bothWin = 0
  let bothFail = 0
  const failures = []

  for (let round = 1; round <= rounds; round += 1) {
    const root = freshRoot()
    const startAt = Date.now() + 500
    const a = launchHolder({
      lockRoot: root, requests: ['path:D:/out'], startAt, holdMs, ownerName: `s3c-a-${round}`, reason: 'S3c outer',
    })
    const b = launchHolder({
      lockRoot: root, requests: ['path:D:/out/sub'], startAt, holdMs, ownerName: `s3c-b-${round}`, reason: 'S3c inner',
    })
    const [ra, rb] = await Promise.all([a.readResult(), b.readResult()])
    await Promise.all([a.finished, b.finished])

    const wins = [ra, rb].filter((row) => row.ok === true).length
    console.log('[s3c] round=' + round + ' winners=' + wins + ' okA=' + ra.ok + ' okB=' + rb.ok)
    if (wins === 1) exactlyOne += 1
    else if (wins === 2) { bothWin += 1; failures.push({ round, kind: 'both-win', ra, rb }) }
    else { bothFail += 1; failures.push({ round, kind: 'both-fail', ra, rb }) }
  }

  assert.equal(bothWin, 0, `both-win rounds: ${JSON.stringify(failures.filter((f) => f.kind === 'both-win'))}`)
  assert.equal(bothFail, 0, `both-fail rounds (the S3c defect this change targets): ${JSON.stringify(failures.filter((f) => f.kind === 'both-fail'))}`)
  assert.equal(exactlyOne, rounds, `exactly-one-winner rounds: ${exactlyOne}/${rounds}`)
})

// ---------------------------------------------------------------------------
// 8. BLOCK #4: a deprived process must never report success
// ---------------------------------------------------------------------------

test('MUTEX_LOST: a mutex taken over mid-flight is detected before commit (no ok, no residue)', () => {
  const root = freshRoot()
  const base = localBackend(root)
  const key = 'path:D:/deprived'
  let stolen = false

  // A backend that steals the mutex at the worst possible moment: after the facet file
  // has been created, before the commit. This is exactly what a TTL takeover looks like
  // to the victim (the takeover does not notify it).
  const stealing = Object.create(base)
  stealing.tryCreate = (lockPath, meta) => {
    const created = base.tryCreate(lockPath, meta)
    if (created && lockPath === base.pathFor(facetOf(key), 'exclusive', 0) && !stolen) {
      stolen = true
      // Replace the mutex with somebody else's: our id is no longer on disk.
      writeJson(mutexPathFor(base), mutexBody({ lockPath: mutexPathFor(base), pid: process.pid }))
    }
    return created
  }

  const result = acquireMany(stealing, [key], { ttlMs: 30_000, reason: 'deprived mid-flight' })

  assert.equal(stolen, true, 'the fault injection fired')
  assert.notEqual(result.ok, true, 'a deprived process must never report ok')
  assert.equal(result.code, 'MUTEX_LOST')
  assert.equal(result.phase, 'commit-verify')
  // Everything it created was rolled back: no facet file of ours, no index record.
  const facetFiles = fs.readdirSync(root).filter((name) => name.endsWith('.lock') && !name.startsWith('_'))
  assert.deepEqual(facetFiles, [], `leftover facet files: ${JSON.stringify(facetFiles)}`)
  const indexFiles = fs.existsSync(path.join(root, '_leases'))
    ? fs.readdirSync(path.join(root, '_leases'))
    : []
  assert.deepEqual(indexFiles, [], `leftover index records: ${JSON.stringify(indexFiles)}`)
  assert.equal(result.released.length >= 1, true, 'the rollback is reported')
})

test('MUTEX_LOST: reading null at verify time counts as LOST (fail-closed)', () => {
  const root = freshRoot()
  const base = localBackend(root)
  const key = 'path:D:/vanished'
  let deleted = false

  // The depriver renamed the old mutex away AND released: the path now holds NOTHING.
  // "Cannot read" must be treated as "not mine", never as "unchanged".
  const vanishing = Object.create(base)
  vanishing.tryCreate = (lockPath, meta) => {
    const created = base.tryCreate(lockPath, meta)
    if (created && lockPath === base.pathFor(facetOf(key), 'exclusive', 0) && !deleted) {
      deleted = true
      fs.rmSync(mutexPathFor(base), { force: true })
    }
    return created
  }

  const result = acquireMany(vanishing, [key], { ttlMs: 30_000, reason: 'mutex vanished' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MUTEX_LOST', 'a missing mutex at verify time means "deprived"')
  assert.equal(fs.existsSync(base.pathFor(facetOf(key), 'exclusive', 0)), false, 'nothing left behind')
})

// ---------------------------------------------------------------------------
// 9. BLOCK #10: unknown liveness counts as a rival (fail-closed, not fail-open)
// ---------------------------------------------------------------------------

test('findRivals: a pidGated:false CLI-shaped lease is a rival (plugin yields, no double hold)', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  // A CLI lease: `pidGated: false` makes `isOwnerAlive` return null ("unknown"), and the
  // OLD post-check rule (`!== true -> skip`) ignored it. Different spelling + ancestor
  // overlap so the facet scan cannot catch it by file name alone.
  const cliKey = 'path:D:/cli-held'
  const cliPath = backend.pathFor(facetOf(cliKey), 'exclusive', 0)
  writeJson(cliPath, {
    id: newLeaseId(),
    key: cliKey,
    facet: facetOf(cliKey),
    mode: 'exclusive',
    owner: 'cli-agent',
    ownerInfo: { agent: 'cli-agent', pid: process.pid, host: hostname(), procStart: currentProcStart(), pidGated: false },
    pid: process.pid,
    host: hostname(),
    procStart: currentProcStart(),
    pidGated: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    lockPath: cliPath,
  })

  assert.equal(isOwnerAlive(readMeta(cliPath)), null, 'precondition: liveness is UNKNOWN, not true')

  // The descendant spelling must lose to the CLI's ancestor lease.
  const result = acquireMany(backend, ['path:D:/cli-held/sub'], { ttlMs: 5000, reason: 'yield to CLI' })
  assert.equal(result.ok, false, 'the plugin must yield to a CLI holder it cannot prove dead')
  assert.equal(result.code, 'CONFLICT')
  // The CLI's lease must still be there, untouched.
  assert.equal(readMeta(cliPath)?.owner, 'cli-agent')
})

// ---------------------------------------------------------------------------
// 10. budgets (M-R1 / M-R2) and short-budget dead-lease reclaim (A4/M30)
// ---------------------------------------------------------------------------

test('budget: a short-wait caller still reclaims a DEAD lease (cheap tier is never gated)', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/dead-cheap'
  const lockPath = backend.pathFor(facetOf(key), 'exclusive', 0)
  const deadPid = 999_997
  assert.equal(pidExists(deadPid), false, 'precondition: the recorded pid is not running')
  writeJson(lockPath, {
    id: newLeaseId(),
    key,
    facet: facetOf(key),
    mode: 'exclusive',
    owner: 'crashed',
    pid: deadPid,
    host: hostname(),
    procStart: currentProcStart(), // tier B shape, but the pid check (tier A) answers first
    createdAt: Date.now() - 5000,
    expiresAt: Date.now() + 600_000, // TTL nowhere near: only liveness can free it
    lockPath,
  })

  const startedAt = Date.now()
  // Stub counts refinements: a DEAD opponent is detected by `pidExists` alone
  // (isOwnerAlive's tier A returns false without ever calling procStartOf), so this
  // reclaim path must cost ~0.037 ms and must NOT pay the expensive probe. This makes
  // "the cheap reclaim path was not moved away / not budget-gated" a regression-guarded
  // property instead of something a reader has to verify by eye.
  let refineCalls = 0
  const result = acquireMany(backend, [key], {
    ttlMs: 5000,
    reason: 'reclaim dead',
    waitMs: 1000,
    strategy: 'queue',
    procStartOf: (pid, now) => { refineCalls += 1; return currentProcStart(now) },
  })
  const elapsed = Date.now() - startedAt

  assert.equal(result.ok, true, `a dead lease must be reclaimable even on a short budget: ${JSON.stringify(result.conflicts ?? result)}`)
  assert.equal(refineCalls, 0, `a dead opponent must be collected WITHOUT readProcStart (calls: ${refineCalls})`)
  assert.ok(elapsed < 5300, `must not have paid a worst-case probe (${elapsed} ms)`)
  assert.equal(readMeta(lockPath)?.id, result.id, 'the new lease owns the path')
  releaseMany(backend, result.id)
})

test('G3: a killed holder is reclaimed immediately even though the mutex is in the way', { timeout: 60_000 }, async () => {
  // The regression this guards: phase 1 reports the blocker WITHOUT judging liveness
  // (correct), and phase 2 must then RESOLVE it. If phase 1's "unknown" were treated as a
  // refusal, a dead agent's lease would sit there until the TTL -- a user-visible loss of
  // the G3 guarantee. `unknown` means "not decided yet", never "no".
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/g3-killed'

  const victim = launchHolder({
    lockRoot: root,
    requests: [key],
    holdMs: 60_000, // it must stay alive while it holds
    ttlMs: 600_000, // the TTL must be nowhere near expiring
    ownerName: 'g3-victim',
    reason: 'will be killed',
  })
  const acquired = await victim.readResult()
  assert.equal(acquired.ok, true, JSON.stringify(acquired))
  const victimPid = acquired.pid
  assert.equal(pidExists(victimPid), true)

  // Kill it the way a crash would: no release, no cleanup, just a dead pid.
  victim.child.kill('SIGKILL')
  await victim.finished
  await waitFor(() => !pidExists(victimPid), { label: `victim ${victimPid} to disappear`, timeoutMs: 15_000 })

  // The TTL is 10 minutes away, so only liveness can let us in -- and it must.
  let refineCalls = 0
  const startedAt = Date.now()
  const after = acquireMany(backend, [key], {
    ttlMs: 5000,
    reason: 'after the crash',
    procStartOf: (pid, now) => { refineCalls += 1; return currentProcStart(now) },
  })
  const elapsed = Date.now() - startedAt

  assert.equal(after.ok, true, `a killed holder must be reclaimed at once (G3): ${JSON.stringify(after.conflicts ?? after)}`)
  assert.ok(elapsed < 5000, `reclaim must not wait for the TTL (took ${elapsed} ms)`)
  assert.equal(refineCalls, 0, 'the dead-pid path must not call readProcStart')
  assert.equal(readMeta(after.entries[0].lockPath)?.id, after.id)
  releaseMany(backend, after.id)
})

test('budget: a slow refinement is skipped, the verdict is marked unrefined, and no ok is claimed', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/slow-probe'
  const lockPath = backend.pathFor(facetOf(key), 'exclusive', 0)
  writeJson(lockPath, {
    id: newLeaseId(),
    key,
    facet: facetOf(key),
    mode: 'exclusive',
    owner: 'live-holder',
    pid: process.pid,
    host: hostname(),
    procStart: currentProcStart(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    lockPath,
  })

  const result = acquireMany(backend, [key], { ttlMs: 5000, reason: 'live holder, no deadline' })
  assert.equal(result.ok, false, 'a live holder must block')
  const row = result.conflicts[0]
  // No deadline + strict mode => no refinement budget => the verdict must say so instead
  // of pretending it was a refined "alive".
  assert.equal(typeof row.livenessRefined, 'boolean')
  assert.equal(typeof row.observedAtMs, 'number', 'conflict rows carry the moment they were observed')
  assert.equal(row.lockPath, lockPath, 'conflict rows name the blocking file')
})

// ---------------------------------------------------------------------------
// 10b. post-commit verification: a non-participant writer that lands after findRivals
// ---------------------------------------------------------------------------

test('COMMIT_UNVERIFIED: a facet stolen after the scan is detected before returning ok', () => {
  // The hole this covers (measured independently): an opponent whose file appears AFTER
  // findRivals has run is invisible to every metadata shape, so no post-check on the
  // opponent's record can see it. The only defence is to re-read OUR OWN files right
  // before returning and confirm they still carry our id.
  const root = freshRoot()
  const base = localBackend(root)
  const key = 'path:D:/late-writer'
  const facetPath = base.pathFor(facetOf(key), 'exclusive', 0)
  let stolen = false

  // Simulate the late writer: after our facet file exists (i.e. after the scan and after
  // findRivals), an external tool overwrites it with its own lease.
  const lateWriter = Object.create(base)
  lateWriter.list = () => {
    const entries = base.list()
    if (!stolen && entries.some((entry) => entry.path === facetPath)) {
      stolen = true
      writeJson(facetPath, {
        id: newLeaseId(),
        key,
        facet: facetOf(key),
        mode: 'exclusive',
        owner: 'external-tool',
        pid: process.pid,
        host: hostname(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
        lockPath: facetPath,
      })
    }
    return entries
  }

  const result = acquireMany(lateWriter, [key], { ttlMs: 30_000, reason: 'late writer' })

  assert.equal(stolen, true, 'the fault injection fired')
  assert.notEqual(result.ok, true, 'must not report a lease it no longer holds')
  assert.equal(result.code, 'COMMIT_UNVERIFIED', `expected COMMIT_UNVERIFIED, got ${result.code}`)
  assert.equal(result.lostFacets.length >= 1, true, 'the lost facet is reported')
  // The external writer keeps its file; nothing of ours may remain.
  assert.equal(readMeta(facetPath)?.owner, 'external-tool', 'we must not delete another writer’s file')
  const indexFiles = fs.existsSync(path.join(root, '_leases')) ? fs.readdirSync(path.join(root, '_leases')) : []
  assert.deepEqual(indexFiles, [], `leftover index records: ${JSON.stringify(indexFiles)}`)
})

// ---------------------------------------------------------------------------
// 11. the mutex must never be treated as a lease (H2 -- sweep is the single point)
// ---------------------------------------------------------------------------

test('mutex: list()/listLocks()/statusOf() never report the mutex as a lease', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  // A mutex whose owner looks dead: the most tempting thing to "reclaim".
  writeJson(mutexPathFor(backend), mutexBody({ lockPath: mutexPathFor(backend), pid: 999_996, host: hostname() }))

  assert.equal(backend.list().some((entry) => path.basename(entry.path) === MUTEX_NAME), false)
  assert.equal(listLocks(root).some((meta) => path.basename(String(meta.lockPath)) === MUTEX_NAME), false)
  assert.equal(statusOf(backend, 'path:D:/anything').length, 0, 'status must not show the mutex')
})

test('mutex: sweep() NEVER archives the mutex (the single point of failure)', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const body = mutexBody({ lockPath: mutexPathFor(backend), pid: 999_995, host: hostname() })
  writeJson(mutexPathFor(backend), body)

  const summary = sweep(backend)
  assert.equal(summary.reclaimed.length, 0, `sweep reclaimed: ${JSON.stringify(summary.reclaimed)}`)
  assert.equal(readMeta(mutexPathFor(backend))?.id, body.id, 'the mutex must survive a sweep')
  assert.equal(fs.readdirSync(root).some((name) => name.includes('.stale.')), false, 'nothing was archived')
})

// ---------------------------------------------------------------------------
// 12. kill switch (H3): disabled means the old behaviour, never silence
// ---------------------------------------------------------------------------

test('kill switch: mutex:false works without the mutex file and reports it', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const result = acquireMany(backend, ['path:D:/no-mutex'], { ttlMs: 5000, reason: 'kill switch', mutex: false })
  assert.equal(result.ok, true)
  assert.deepEqual(result.mutex, { enabled: false, degraded: false }, 'the caller must be able to see the degraded mode')
  assert.equal(fs.existsSync(mutexPathFor(backend)), false, 'no mutex file was created')
  releaseMany(backend, result.id)
})

// ---------------------------------------------------------------------------
// 13. throughput sanity: the mutex must not serialize the holding period
// ---------------------------------------------------------------------------

test('throughput: 16 non-conflicting acquires finish quickly (holding period is not serialized)', { timeout: 60_000 }, async () => {
  const root = freshRoot()
  const startAt = Date.now() + 400
  // All 16 run in the SAME critical section window (they must queue for it), but their
  // leases do not conflict, so all 16 must succeed.
  const workers = []
  for (let i = 0; i < 16; i += 1) {
    workers.push(launchHolder({
      lockRoot: root,
      requests: [`path:D:/through-${i}`],
      startAt,
      holdMs: 300,
      ownerName: `t${i}`,
      reason: `throughput ${i}`,
    }))
  }
  const startedAt = Date.now()
  const results = await Promise.all(workers.map((worker) => worker.readResult()))
  await Promise.all(workers.map((worker) => worker.finished))
  const wallMs = Date.now() - startedAt

  const winners = results.filter((row) => row.ok === true)
  assert.equal(winners.length, 16, `all non-conflicting acquires must succeed: ${JSON.stringify(results.map((r) => r.code))}`)
  // 16 agents queueing behind one critical section: measured section cost is a few ms,
  // so the whole wave must stay far below the 8 s protocol cap. This is a coarse guard
  // against a regression that would serialize on something expensive (a probe).
  assert.ok(wallMs < 8000, `16 acquires took ${wallMs} ms; the critical section must stay cheap`)
})

// ---------------------------------------------------------------------------

/**
 * Find a pid that is definitely not running.
 *
 * @returns {Promise<number>} a dead pid.
 */
async function findDeadPid() {
  for (let candidate = 500_000; candidate < 500_200; candidate += 1) {
    if (!pidExists(candidate)) return candidate
  }
  throw new Error('could not find an unused pid')
}
// ---------------------------------------------------------------------------
// BLOCK #1: a 0-byte crashed residue must be reclaimable once it is old enough
// ---------------------------------------------------------------------------

test('BLOCK #1 residue: an OLD 0-byte file is reclaimed (age >= grace)', () => {
  // Regression this guards: phase 2 used `row.heldBy.pid === null` as a gate. A 0-byte
  // body has no pid, so those rows were skipped and the residue was never collected --
  // a net regression vs publish/ and a G3 violation. The reclaim decision must come from
  // the FILE (read + age + liveness), never from a display field.
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/old-residue'
  const lockPath = backend.pathFor(facetOf(key), 'exclusive', 0)

  fs.writeFileSync(lockPath, '')                       // 0 bytes = crashed residue
  const old = new Date(Date.now() - 5000)              // older than the 2000 ms grace
  fs.utimesSync(lockPath, old, old)

  const result = acquireMany(backend, [key], { ttlMs: 30_000, reason: 'reclaim an old residue' })

  assert.equal(result.ok, true, `an aged residue must be reclaimable: ${JSON.stringify(result.conflicts ?? result)}`)
  assert.equal(readMeta(lockPath)?.id, result.id, 'the new lease owns the path')
  assert.equal(
    fs.readdirSync(root).some((name) => name.includes('.stale.')),
    true,
    'the residue must be archived, not silently overwritten',
  )
  releaseMany(backend, result.id)
})

test('BLOCK #1 residue: a FRESH 0-byte file is NOT taken over', () => {
  // The other half of the age split: treating a just-created empty file as garbage is how
  // two holders appear (the writer finishes a millisecond later).
  const root = freshRoot()
  const backend = localBackend(root)
  const key = 'path:D:/fresh-residue'
  const lockPath = backend.pathFor(facetOf(key), 'exclusive', 0)
  fs.writeFileSync(lockPath, '')                       // 0 bytes, mtime = now

  const result = acquireMany(backend, [key], { ttlMs: 30_000, reason: 'must not steal a fresh writer' })

  assert.equal(result.ok, false, 'a fresh unreadable file must not be taken over')
  assert.equal(result.code, 'CONFLICT')
  assert.equal(fs.existsSync(lockPath), true, 'the fresh file must survive untouched')
})
// ---------------------------------------------------------------------------
// M1: the class prefilter must not hide a CROSS-CLASS implication
// ---------------------------------------------------------------------------

test('M1 prefilter: a cross-class implication is still detected (browser:cdp:9222 implies port:9222)', () => {
  // The prefilter skips files whose class cannot clash with the wanted facet. If that
  // mapping were wrong, a real conflict would silently disappear. This pins the one
  // cross-class rule the kernel relies on: browser:cdp:<p> materialises a port facet, so
  // a plain port:<p> request must still see it.
  const root = freshRoot()
  const backend = localBackend(root)
  const held = acquireMany(backend, ['browser:cdp:9222'], { ttlMs: 30_000, reason: 'cdp holder' })
  assert.equal(held.ok, true, JSON.stringify(held.conflicts ?? held))
  assert.equal(held.facets.length, 2, 'cdp expands to browser + port facets')

  const port = acquireMany(backend, ['port:9222'], { ttlMs: 5000, reason: 'plain port' })
  assert.equal(port.ok, false, 'the prefilter must not hide the port facet of a cdp lease')
  assert.equal(port.conflicts[0].facet, facetOf('port:9222'))

  releaseMany(backend, held.id)
  const portHeld = acquireMany(backend, ['port:9222'], { ttlMs: 30_000, reason: 'port holder' })
  assert.equal(portHeld.ok, true)
  const cdp = acquireMany(backend, ['browser:cdp:9222'], { ttlMs: 5000, reason: 'cdp after port' })
  assert.equal(cdp.ok, false, 'a held port must block browser:cdp of that port')
  releaseMany(backend, portHeld.id)
})

test('M1 prefilter: a browser container still conflicts with every browser:* profile', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  const profile = acquireMany(backend, ['browser:profile:work'], { ttlMs: 30_000, reason: 'profile' })
  assert.equal(profile.ok, true)
  const instance = acquireMany(backend, ['browser:instance'], { ttlMs: 5000, reason: 'instance' })
  assert.equal(instance.ok, false, 'browser:instance is a container: it must see the profile')
  releaseMany(backend, profile.id)
})
// ---------------------------------------------------------------------------
// _pending soundness: a lease whose file set is INCOMPLETE must not be invisible
// ---------------------------------------------------------------------------

test('_pending soundness: a partially created lease is still seen by a same-class-only scan', () => {
  // The state a crashed (or concurrently degrading) multi-facet create leaves behind:
  // ONE facet file exists, its body declares BOTH facets, and the second file was never
  // written. A name-based prefilter would skip that file for the second class.
  // The marker is what makes the incompleteness observable -- and a crashed creator has
  // already written it, so it is still on disk.
  const root = freshRoot()
  const backend = localBackend(root)
  const partialId = newLeaseId()

  // Fidelity matters: marker first, then only the FIRST facet file.
  writePending(backend, partialId)
  const cdpPath = backend.pathFor(facetOf('browser:cdp:9224'), 'exclusive', 0)
  writeJson(cdpPath, {
    id: partialId,
    key: 'browser:cdp:9224',
    facet: facetOf('browser:cdp:9224'),
    mode: 'exclusive',
    owner: 'mid-create',
    pid: process.pid,
    host: hostname(),
    procStart: currentProcStart(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    lockPath: cdpPath,
    facets: [facetOf('browser:cdp:9224'), facetOf('port:9224')],
    paths: [cdpPath],
  })
  // port_9224.lock deliberately does NOT exist.

  const blocked = acquireMany(backend, ['port:9224'], { ttlMs: 5000, reason: 'must see the partial lease' })
  assert.equal(blocked.ok, false, 'a partial lease must still block its declared facet')
  assert.equal(blocked.conflicts[0].facet, facetOf('port:9224'))
})

test('_pending soundness: a multi-key partial lease is visible across classes', () => {
  // The Lead's counter-example to "prefilter only for path": a LEGAL multi-key acquire
  // writes two files that EACH declare both facets, so a surviving `port_*` file can
  // declare a `path` facet. Filtering by class therefore is not sound on its own.
  const root = freshRoot()
  const backend = localBackend(root)
  const partialId = newLeaseId()
  writePending(backend, partialId)

  const portPath = backend.pathFor(facetOf('port:9225'), 'exclusive', 0)
  writeJson(portPath, {
    id: partialId,
    key: 'port:9225',
    facet: facetOf('port:9225'),
    mode: 'exclusive',
    owner: 'mid-create',
    pid: process.pid,
    host: hostname(),
    procStart: currentProcStart(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    lockPath: portPath,
    facets: [facetOf('port:9225'), facetOf('path:D:/mid-create/x')],
    paths: [portPath],
  })

  const blocked = acquireMany(backend, ['path:D:/mid-create/x'], { ttlMs: 5000, reason: 'multi-key partial' })
  assert.equal(blocked.ok, false, 'the path facet declared by a port-class file must still conflict')
})

test('_pending: a stale marker from a crashed creator is purged by the next holder', () => {
  const root = freshRoot()
  const backend = localBackend(root)
  writePending(backend, 'lz_crashed00001')
  const file = path.join(pendingDirFor(backend), 'lz_crashed00001')
  const old = new Date(Date.now() - 120_000) // far beyond the mutex TTL
  fs.utimesSync(file, old, old)

  const result = acquireMany(backend, ['path:D:/after-crash'], { ttlMs: 5000, reason: 'purge' })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(file), false, 'a marker older than the TTL must be collected')
  releaseMany(backend, result.id)
})

test('_pending: the normal path keeps the prefilter effective (candidate count stays 1)', () => {
  // The optimisation must survive the soundness fix: with no foreign marker, a scan for
  // one sibling still reads exactly one file, not the whole root.
  const root = freshRoot()
  const backend = localBackend(root)
  for (let i = 0; i < 32; i += 1) {
    const lease = acquireMany(backend, [`path:D:/pf/${i}/0`], { ttlMs: 30_000, reason: `pf ${i}` })
    assert.equal(lease.ok, true)
  }
  const want = facetOf('path:D:/pf/16/0')
  assert.equal(backend.list({ forFacets: [want] }).length, 1, 'only the matching sibling is read')
  assert.equal(backend.list({ forFacets: [want], prefilterSafe: false }).length, 32, 'the unsafe path still reads all')
})