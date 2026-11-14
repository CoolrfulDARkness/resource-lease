/**
 * Regression tests for the takeover guards and the cross-tool key rule.
 *
 * Every case here is a bug that a round-2 adversarial review reproduced against
 * the plugin while the CLI and the MCP server already got it right:
 *
 *   [1] a FRESH lock file with no readable body must not be taken over -- that
 *       state is exactly "a live writer between openSync('wx') and its first
 *       write". The plugin used to archive it and hand the key to a second
 *       holder: two agents, one lock, neither noticed.
 *   [2] control: an OLD unreadable file IS a crashed residue and must be taken
 *       over, or a crash would lock the key forever.
 *   [3]/[4] after archiving, re-read the ARCHIVED copy: if it turns out to be a
 *       live lease, put it back and report failure.
 *   [5] removeIfOwned must fail closed on any body it cannot identify (no id,
 *       non-string id, torn JSON), the way the CLI's release does.
 *   [6] the key rule lowercases, or "Browser:Chromium" and "browser:chromium"
 *       name two lock files on a case-sensitive filesystem and mutual exclusion
 *       silently stops working.
 *   [7] the real race, across processes: a slow writer holds a fresh lock, the
 *       plugin tries to lease the same key, and only the writer may win.
 *   [8] a directory squatting on the lock path is archived (the CLI used to be
 *       stuck forever on it; the plugin and the MCP server self-heal).
 *
 * Run with: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'
import * as lock from '../lib/lock.js'

/** A pid that is definitely not this process, for "another holder". */
const OTHER_PID = process.pid + 4242

/**
 * A minimal stand-in for the Cordis context `apply()` consumes.
 *
 * @param {string[]} logs collected log lines.
 * @returns {any} context whose `get('resources')` yields the service.
 */
function fakeContext(logs) {
  const services = new Map()
  return {
    logger: () => ({
      warn: (...args) => logs.push(args.map(String).join(' ')),
      info: (...args) => logs.push(args.map(String).join(' ')),
      debug: () => {},
    }),
    get: (name) => services.get(name),
    set: (name, value) => services.set(name, value),
    effect: (body) => {
      const disposer = body()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: () => {},
    tools: { register: () => () => {}, guard: () => () => {} },
    systemPrompt: { context: () => () => {} },
  }
}

/**
 * Boot one plugin instance against `lockRoot`.
 *
 * @param {string} lockRoot lock directory.
 * @param {string[]} logs collected log lines.
 * @returns {any} the `resources` service.
 */
function boot(lockRoot, logs) {
  const ctx = fakeContext(logs)
  apply(ctx, { lockRoot, defaultTtlMs: 60000, maxWaitMs: 0 })
  const service = ctx.get('resources')
  assert.ok(service, 'the resources service was registered')
  return service
}

/** @returns {string} a fresh lock root under the OS temp directory. */
function freshLockRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resource-lease-guard-'))
}

/**
 * Create a lock file with no readable body, the exact state openSync('wx')
 * leaves behind before the first write.
 *
 * @param {string} lockPath lock file path.
 * @param {number} ageMs how old its mtime should be.
 */
function emptyLockFile(lockPath, ageMs) {
  fs.closeSync(fs.openSync(lockPath, 'wx'))
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(lockPath, when, when)
  }
}

/**
 * @param {string} lockRoot lock directory.
 * @returns {string[]} every archived `.stale.` entry in it.
 */
function staleEntries(lockRoot) {
  return fs.readdirSync(lockRoot).filter((name) => name.includes('.stale.'))
}

/**
 * @param {string} dir directory to wait for a file in.
 * @param {number} [timeoutMs] how long to wait.
 * @returns {Promise<void>} resolves once the directory is non-empty.
 */
async function waitForEntry(dir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.readdirSync(dir).length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`nothing appeared in ${dir} within ${timeoutMs}ms`)
}

test('[1] a fresh lock file with no readable body is NOT takeable', () => {
  const lockRoot = freshLockRoot()
  const lockPath = lock.lockPathFor(lockRoot, 'half:key', 'exclusive', 0)
  emptyLockFile(lockPath, 0) // created just now, body not written yet

  assert.equal(lock.tryTakeover(lockPath, Date.now(), process.pid), false, 'a live writer must keep its lock')
  assert.equal(fs.existsSync(lockPath), true, 'the lock file is still at the live path')
  assert.deepEqual(staleEntries(lockRoot), [], 'nothing was archived')
})

test('[2] an OLD lock file with no readable body IS takeable (crashed residue)', () => {
  const lockRoot = freshLockRoot()
  const lockPath = lock.lockPathFor(lockRoot, 'crash:key', 'exclusive', 0)
  emptyLockFile(lockPath, 10 * 60 * 1000) // a crashed writer, ten minutes ago

  assert.equal(lock.tryTakeover(lockPath, Date.now(), process.pid), true, 'crashed residue must self-heal')
  assert.equal(fs.existsSync(lockPath), false, 'the residue was moved aside')
  assert.equal(staleEntries(lockRoot).length, 1, 'exactly one archive was created')
})

test('[3]/[4] a takeover is undone when the archived copy turns out to be live', () => {
  const lockRoot = freshLockRoot()
  const lockPath = lock.lockPathFor(lockRoot, 'late:write', 'exclusive', 0)
  emptyLockFile(lockPath, 10 * 60 * 1000) // looks like a residue when we read it

  // The real scenario: the writer finishes writing between our read and our
  // rename. Hooking renameSync reproduces that window deterministically instead
  // of hoping for scheduling luck.
  const live = {
    id: 'lz_latewriter01',
    key: 'late:write',
    mode: 'exclusive',
    slots: 1,
    slot: 0,
    owner: 'late-writer',
    reason: 'finished writing after our read',
    pid: OTHER_PID,
    host: 'test',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
    lockPath,
  }
  const realRename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (from === lockPath) fs.writeFileSync(lockPath, JSON.stringify(live))
    return realRename(from, to)
  }

  const notices = []
  let moved
  try {
    moved = lock.tryTakeover(lockPath, Date.now(), process.pid, (message) => notices.push(message))
  } finally {
    fs.renameSync = realRename
  }

  assert.equal(moved, false, 'the takeover was refused once the archived body turned out to be live')
  assert.equal(fs.existsSync(lockPath), true, 'the live lock was restored to its path')
  assert.equal(lock.readMeta(lockPath).id, live.id, 'the restored lock still belongs to its owner')
  assert.deepEqual(staleEntries(lockRoot), [], 'no archive was left behind')
  assert.equal(notices.length, 1, 'the abort was reported to the caller')
  assert.match(notices[0], /live lease/, `unexpected notice: ${notices[0]}`)
})

test('[5] removeIfOwned fails closed on any body it cannot identify', () => {
  const lockRoot = freshLockRoot()
  const bodies = {
    'no id': JSON.stringify({ owner: 'someone-else', expiresAt: Date.now() + 60000 }),
    'empty object': '{}',
    'numeric id': JSON.stringify({ id: 123, owner: 'someone-else', expiresAt: Date.now() + 60000 }),
    'null id': JSON.stringify({ id: null, owner: 'someone-else', expiresAt: Date.now() + 60000 }),
    'torn json': '{"id":"lz_torn","own',
  }
  let index = 0
  for (const [label, body] of Object.entries(bodies)) {
    index += 1
    const lockPath = path.join(lockRoot, `body_${index}.lock`)
    fs.writeFileSync(lockPath, body)
    const result = lock.removeIfOwned(lockPath, 'lz_someoneelse1')
    assert.equal(result.removed, false, `${label}: the delete must be refused`)
    assert.equal(result.onDiskId, null, `${label}: the unreadable id is reported as null`)
    assert.equal(fs.existsSync(lockPath), true, `${label}: the lock file survived`)
  }

  // Control: the owning id still removes its own lock.
  const ownPath = path.join(lockRoot, 'own.lock')
  fs.writeFileSync(ownPath, JSON.stringify({ id: 'lz_mine00000001', expiresAt: Date.now() + 1000 }))
  assert.equal(lock.removeIfOwned(ownPath, 'lz_mine00000001').removed, true, 'a matching id releases the lock')
})

test('[6] keys are sanitized AND lowercased onto one lock file', () => {
  const lockRoot = freshLockRoot()
  const upper = lock.lockPathFor(lockRoot, 'Browser:Chromium', 'exclusive', 0)
  const lower = lock.lockPathFor(lockRoot, 'browser:chromium', 'exclusive', 0)

  assert.equal(path.basename(upper), 'browser_chromium.lock', 'the lock file name must be lowercase')
  assert.equal(upper, lower, 'two spellings of one key must name the same file')
  assert.equal(
    lock.lockPathFor(lockRoot, 'browser:profile:main', 'pool', 1),
    path.join(lockRoot, 'browser_profile_main.slot-1.lock'),
    'pool slots keep their suffix and are lowercased too',
  )
})

test('[7] a slow writer holding a fresh lock is not stolen by lease()', async () => {
  const lockRoot = freshLockRoot()
  const service = boot(lockRoot, [])
  const lockPath = lock.lockPathFor(lockRoot, 'race:key', 'exclusive', 0)

  // A real second process grabs the create right, then stalls before writing the
  // body -- "the holder is mid-write", scaled up so the window is observable.
  const writerSource = `
    const fs = require('node:fs')
    const lockPath = process.argv[1]
    const fd = fs.openSync(lockPath, 'wx')
    const now = Date.now()
    setTimeout(() => {
      fs.writeFileSync(fd, JSON.stringify({
        id: 'lz_slowwriter01', key: 'race:key', mode: 'exclusive', slots: 1, slot: 0,
        owner: 'slow-writer', reason: 'still writing its lock file',
        pid: process.pid, host: 'test', createdAt: now, expiresAt: now + 60000, lockPath,
      }))
      fs.closeSync(fd)
      console.log('WRITER_FINISHED')
    }, 1200)
  `
  const writer = spawn(process.execPath, ['-e', writerSource, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let writerOut = ''
  writer.stdout.on('data', (chunk) => (writerOut += chunk))
  writer.stderr.on('data', (chunk) => (writerOut += chunk))

  try {
    await waitForEntry(lockRoot) // the writer has created its lock file
    assert.equal(fs.statSync(lockPath).size, 0, 'the writer has not written its body yet')

    await assert.rejects(
      service.lease({ key: 'race:key', reason: 'plugin wants the same key', ttlMs: 60000 }),
      /busy|held/i,
      'the plugin must not steal a key a live writer is still creating',
    )
    assert.deepEqual(service.list(), [], 'the plugin holds nothing')
    assert.deepEqual(staleEntries(lockRoot), [], 'the writer lock was not archived')

    await new Promise((resolve) => writer.on('exit', resolve))
    assert.match(writerOut, /WRITER_FINISHED/, `the writer failed: ${writerOut}`)
    assert.equal(lock.readMeta(lockPath).id, 'lz_slowwriter01', 'the writer still owns the only lock')
  } finally {
    if (writer.exitCode === null) writer.kill()
    fs.rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('[8] a directory squatting on the lock path is archived', () => {
  const lockRoot = freshLockRoot()
  const lockPath = lock.lockPathFor(lockRoot, 'dir:key', 'exclusive', 0)
  fs.mkdirSync(lockPath)
  const when = new Date(Date.now() - 5 * 60 * 1000)
  fs.utimesSync(lockPath, when, when)

  assert.equal(lock.tryTakeover(lockPath, Date.now(), process.pid), true, 'a stale directory is a residue too')
  assert.equal(fs.existsSync(lockPath), false, 'the directory was moved off the lock path')
  assert.equal(staleEntries(lockRoot).length, 1, 'the directory was archived, not deleted')
  assert.equal(lock.tryAcquire(lockPath, { id: 'lz_afterdir01', expiresAt: Date.now() + 60000 }), true, 'the lock path is usable again')

  // A brand-new directory gets the same grace as an unreadable file.
  const freshPath = lock.lockPathFor(lockRoot, 'dir:fresh', 'exclusive', 0)
  fs.mkdirSync(freshPath)
  assert.equal(lock.tryTakeover(freshPath, Date.now(), process.pid), false, 'a just-created directory is not a residue')
})
