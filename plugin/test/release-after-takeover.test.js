/**
 * Regression test for the double-holder bug in the release path.
 *
 * The bug: a lease is released BY PATH. When the lease has expired and another
 * holder took it over (rename CAS + a fresh file at the same path), the old
 * holder's release deletes the NEW holder's live lock. Two agents then hold the
 * same resource and neither notices.
 *
 * The scenario below is the real one, built with the plugin's own primitives:
 *   acquire -> expire -> takeover by another holder -> old id releases
 *   => the new holder's lock file MUST still exist.
 *
 * Run with: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'
import * as lock from '../lib/lock.js'

/** The other holder's pid; the real one would be a different OS process. */
const OTHER_PID = process.pid + 4242

/**
 * A minimal stand-in for the Cordis context `apply()` consumes: enough for the
 * service registration, the three tools, the prompt context, the guard, and the
 * per-agent cleanup hooks.
 *
 * @param {string[]} warnings collected log lines.
 * @returns {any} a context whose `get('resources')` yields the service.
 */
function fakeContext(warnings) {
  const services = new Map()
  const ctx = {
    logger: () => ({
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      info: (...args) => warnings.push(args.map(String).join(' ')),
      debug: () => {},
    }),
    get: (name) => services.get(name),
    set: (name, value) => services.set(name, value),
    // Run the effect body now, as the loader does, and keep the disposer.
    effect: (body) => {
      const disposer = body()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: () => {},
    tools: {
      register: () => () => {},
      guard: () => () => {},
    },
    systemPrompt: {
      context: () => () => {},
    },
  }
  return ctx
}

/**
 * Boot one plugin instance against `lockRoot` and return its `resources`
 * service. Two instances in one process model "the plugin was reloaded while a
 * lease was still on disk".
 *
 * @param {string} lockRoot lock directory.
 * @param {string[]} warnings collected log lines.
 * @returns {any} the `resources` service.
 */
function boot(lockRoot, warnings) {
  const ctx = fakeContext(warnings)
  apply(ctx, { lockRoot, defaultTtlMs: 1000, maxWaitMs: 0 })
  const service = ctx.get('resources')
  assert.ok(service, 'the resources service was registered')
  return service
}

/** @returns {string} a fresh lock root under the OS temp directory. */
function freshLockRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resource-lease-test-'))
}

/**
 * Backdate a lease's `expiresAt` so it counts as expired without waiting for a
 * real TTL. Written through the lock module so the on-disk shape stays exact.
 *
 * @param {string} lockPath lock file path.
 */
function expireNow(lockPath) {
  const meta = lock.readMeta(lockPath)
  assert.ok(meta, 'the lock file exists before it is expired')
  fs.writeFileSync(lockPath, JSON.stringify({ ...meta, expiresAt: Date.now() - 1 }))
}

/**
 * Simulate another holder taking over an expired lease: the rename CAS, then a
 * FRESH lease at the same path with a new id and a different pid -- exactly what
 * `attempt()` does in a second process.
 *
 * @param {string} lockPath lock file path.
 * @param {Record<string, any>} newMeta metadata for the new holder.
 */
function takeoverByOther(lockPath, newMeta) {
  const now = Date.now()
  assert.equal(lock.tryTakeover(lockPath, now, OTHER_PID), true, 'the expired lease was taken over')
  assert.equal(lock.tryAcquire(lockPath, newMeta), true, 'the new holder created its lock file')
}

test('release after a takeover keeps the new holder\'s lock (in-memory path)', async () => {
  const warnings = []
  const lockRoot = freshLockRoot()
  const service = boot(lockRoot, warnings)

  const mine = await service.lease({ key: 'browser:chromium', reason: 'capture screenshots', ttlMs: 1000 })
  const lockPath = mine.lockPath
  assert.equal(lock.readMeta(lockPath).id, mine.id, 'the lock file records our id')

  // The TTL passes and another agent takes the resource over.
  expireNow(lockPath)
  const theirs = {
    id: 'lz_newholder001',
    key: mine.key,
    mode: 'exclusive',
    slots: 1,
    slot: 0,
    owner: 'agent-b',
    reason: 'export report screenshots',
    pid: OTHER_PID,
    host: os.hostname(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
    lockPath,
  }
  takeoverByOther(lockPath, theirs)

  // The old holder now walks its normal release path.
  const released = service.release(mine.id)

  assert.equal(released, false, 'a lease that was taken over does not count as released')
  assert.ok(fs.existsSync(lockPath), 'the new holder\'s lock file MUST still exist')
  assert.equal(lock.readMeta(lockPath).id, theirs.id, 'the lock still belongs to the new holder')
  assert.equal(lock.readMeta(lockPath).owner, 'agent-b', 'the new holder is still the owner')
  assert.deepEqual(
    service.list().map((row) => row.id),
    [theirs.id],
    'the new holder\'s lease is still live',
  )
  assert.equal(
    warnings.some((line) => line.includes(theirs.id) || line.includes('taken over')),
    true,
    'the mismatch was logged instead of deleted silently',
  )

  // A second release attempt must stay harmless.
  assert.equal(service.release(mine.id), false, 'the stale id cannot release anything')
  assert.ok(fs.existsSync(lockPath), 'the new holder\'s lock survives a second release too')
})

test('release after a takeover keeps the new holder\'s lock (index fallback path)', async () => {
  const warnings = []
  const lockRoot = freshLockRoot()
  const before = boot(lockRoot, warnings)
  const mine = await before.lease({ key: 'port:9222', reason: 'dev server', ttlMs: 1000 })
  const lockPath = mine.lockPath

  // A reload: the new instance has an empty in-memory map, so release() has to
  // fall back to the shared `_leases` index.
  const after = boot(lockRoot, warnings)

  expireNow(lockPath)
  // Same PID on purpose: the fallback exists to release leases of THIS process
  // that outlived a reload, so its old guard was only "pid === process.pid".
  // Here another session in the same process took the resource over, which that
  // guard cannot tell apart from our own lease -- only the id can.
  const theirs = {
    id: 'lz_newholder002',
    key: mine.key,
    mode: 'exclusive',
    slots: 1,
    slot: 0,
    owner: 'agent-c',
    reason: 'restart dev server',
    pid: process.pid,
    host: os.hostname(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
    lockPath,
  }
  takeoverByOther(lockPath, theirs)

  assert.equal(after.release(mine.id), false, 'the index fallback does not delete a taken-over lease')
  assert.ok(fs.existsSync(lockPath), 'the new holder\'s lock file MUST still exist')
  assert.equal(lock.readMeta(lockPath).id, theirs.id, 'the lock still belongs to the new holder')
  assert.deepEqual(
    after.list().map((row) => row.id),
    [theirs.id],
    'the new holder\'s lease is still live',
  )
})

test('releasing a lease this process still owns removes its lock and index record', async () => {
  const warnings = []
  const lockRoot = freshLockRoot()
  const service = boot(lockRoot, warnings)

  const mine = await service.lease({ key: 'screen:focus', reason: 'click through the checkout', ttlMs: 60000 })
  assert.ok(fs.existsSync(mine.lockPath), 'the lock file exists while the lease is held')
  assert.ok(lock.readIndex(lockRoot, mine.id), 'the index record exists while the lease is held')

  assert.equal(service.release(mine.id), true, 'our own live lease is released')
  assert.equal(fs.existsSync(mine.lockPath), false, 'the lock file is gone')
  assert.equal(lock.readIndex(lockRoot, mine.id), null, 'the index record is gone')
  assert.deepEqual(service.list(), [], 'no live lease is left')
})

test('releasing a lease whose lock is already gone reports no release', async () => {
  const warnings = []
  const lockRoot = freshLockRoot()
  const service = boot(lockRoot, warnings)

  const mine = await service.lease({ key: 'repo:root', reason: 'rebase', ttlMs: 60000 })
  fs.rmSync(mine.lockPath, { force: true })

  assert.equal(service.release(mine.id), false, 'nothing was deleted, so nothing was released')
  assert.equal(warnings.some((line) => line.includes('already gone')), true, 'the missing file was logged')
})

test('removeIfOwned refuses to delete a lock recorded under another id', () => {
  const lockRoot = freshLockRoot()
  const lockPath = lock.lockPathFor(lockRoot, 'dir:src/parser', 'exclusive', 0)
  const theirs = { id: 'lz_newholder003', key: 'dir:src/parser', mode: 'exclusive', slots: 1, slot: 0, owner: 'agent-d', reason: 'format pass', pid: OTHER_PID, createdAt: Date.now(), expiresAt: Date.now() + 60000, lockPath }
  assert.equal(lock.tryAcquire(lockPath, theirs), true)

  const mismatch = lock.removeIfOwned(lockPath, 'lz_someoneelse1')
  assert.equal(mismatch.removed, false, 'the delete was refused')
  assert.equal(mismatch.onDiskId, theirs.id, 'the id actually found on disk is reported')
  assert.ok(fs.existsSync(lockPath), 'the lock file survived')

  const match = lock.removeIfOwned(lockPath, theirs.id)
  assert.equal(match.removed, true, 'the owning id removes its own lock')
  assert.equal(fs.existsSync(lockPath), false, 'the lock file is gone')
})