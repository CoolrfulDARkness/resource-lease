/**
 * Takeover safety test: a lock file that cannot be parsed is NOT automatically
 * stale.
 *
 * Why this exists. Under load the CLI produced TWO holders of one lock: agent A
 * created the lock file and was still writing its body, agent B read it, got no
 * JSON, concluded "expired", archived A's brand-new 30s lease and created its
 * own. Both then believed they were exclusive. Reproduced by racing two
 * processes; the giveaway in the log was a takeover whose "previous owner" was
 * `?`, because the reader had seen an empty file.
 *
 * The rule now (identical in the CLI, this server and the plugin):
 *   - parseable + expired            -> take over
 *   - unreadable + OLD (past grace)  -> take over (crashed residue)
 *   - unreadable + FRESH             -> treat as HELD, never steal
 *
 * These tests are deterministic: they create the exact on-disk state instead of
 * hoping a race reproduces.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  McpClient,
  createSandbox,
  lockFileFor,
  readLockJson,
  runCli,
} from './lib/harness.mjs'
import { done, section, test } from './lib/tiny.mjs'

const sandbox = createSandbox('takeover')
const client = new McpClient({ lockRoot: sandbox.lockRoot, label: 'takeover' }).start()

/** @param {string} key resource key. @returns {string} its lock file path. */
function lockOf(key) {
  return lockFileFor(sandbox.lockRoot, key)
}

/**
 * Create an empty (unparseable) lock file and backdate its mtime.
 *
 * @param {string} lockPath lock file path.
 * @param {number} ageMs how far in the past to set the mtime.
 */
function writeEmptyLock(lockPath, ageMs) {
  fs.writeFileSync(lockPath, '')
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(lockPath, when, when)
  }
}

/** @returns {string[]} archived `.stale.` files in the lock root. */
function staleFiles() {
  try {
    return fs.readdirSync(sandbox.lockRoot).filter((name) => name.includes('.stale.'))
  } catch {
    return []
  }
}

section(`05 takeover -- lock root ${sandbox.lockRoot}`)

try {
  await client.initialize()

  await test('a FRESH unreadable lock file counts as held, and is not archived', async () => {
    const key = 'half:key'
    const lockPath = lockOf(key)
    writeEmptyLock(lockPath, 0)

    const response = await client.call('resource_acquire', { key, reason: 'must not steal a half-written lock' })
    assert.equal(response.result.isError, true, 'a lock file that is being written must not be stolen')
    assert.equal(fs.existsSync(lockPath), true, 'the half-written lock file must still be there')
    assert.deepEqual(staleFiles(), [], 'nothing may be archived for a fresh unreadable lock file')
    assert.equal(readLockJson(lockPath), null, 'the file is still unparseable, i.e. untouched')

    // The CLI must agree, because it reads the same files.
    const viaCli = runCli(['acquire', key, '--wait', '0', '--owner', 'ps-late', '--ttl', '5s'], sandbox.lockRoot)
    assert.equal(viaCli.code, 2, `the CLI must also treat it as busy, got ${viaCli.code}:\n${viaCli.output}`)
    assert.deepEqual(staleFiles(), [], 'the CLI must not archive it either')

    fs.rmSync(lockPath, { force: true })
  })

  await test('an OLD unreadable lock file is a crashed residue and IS taken over', async () => {
    const key = 'half:old:key'
    const lockPath = lockOf(key)
    writeEmptyLock(lockPath, 60_000)

    const response = await client.call('resource_acquire', { key, reason: 'recover crashed residue' })
    assert.equal(response.result.isError, undefined, `takeover of a stale residue failed: ${JSON.stringify(response.result)}`)
    const lease = response.result.structuredContent
    assert.equal(readLockJson(lockPath).id, lease.id, 'the new lease owns the lock file now')
    assert.equal(staleFiles().length, 1, 'the unreadable residue was archived for forensics')

    await client.call('resource_release', { id: lease.id })
    assert.equal(fs.existsSync(lockPath), false)
  })

  await test('an unreadable-but-old lock file is taken over by the CLI too (same rule)', () => {
    const key = 'half:cli:key'
    const lockPath = lockOf(key)
    writeEmptyLock(lockPath, 60_000)

    const acquired = runCli(['acquire', key, '--wait', '0', '--owner', 'ps-recover', '--ttl', '5s'], sandbox.lockRoot)
    assert.equal(acquired.code, 0, `the CLI must recover an old residue, got ${acquired.code}:\n${acquired.output}`)
    assert.match(acquired.stderr, /Took over/, `the takeover must be logged:\n${acquired.stderr}`)
    assert.notEqual(readLockJson(lockPath), null, 'the new lease body is on disk')

    runCli(['release', '--all', '--owner', 'ps-recover'], sandbox.lockRoot)
  })

  await test('a parseable lease is never taken over while its TTL runs', async () => {
    const key = 'live:key'
    const first = new McpClient({ lockRoot: sandbox.lockRoot, label: 'live' }).start()
    try {
      await first.initialize()
      const held = await first.call('resource_acquire', { key, reason: 'still alive', ttlMs: 30_000 })
      assert.equal(held.result.isError, undefined)
      const lockPath = lockOf(key)
      assert.equal(readLockJson(lockPath).reason, 'still alive')

      const archivedBefore = staleFiles().length
      const second = await client.call('resource_acquire', { key, reason: 'must be refused' })
      assert.equal(second.result.isError, true, 'a live lease must refuse a second holder')
      assert.equal(staleFiles().length, archivedBefore, 'a live lease must never be archived')
      assert.equal(readLockJson(lockPath).reason, 'still alive', 'the live lease is untouched')
    } finally {
      await first.close()
    }
  })

  await test('a file with valid JSON but an old mtime is not expired (TTL is the only clock)', async () => {
    const key = 'mtime:key'
    const lockPath = lockOf(key)
    const meta = {
      id: 'lz_mtime0000001',
      key,
      mode: 'exclusive',
      slots: 1,
      slot: 0,
      owner: 'clock-test',
      reason: 'expiresAt is in the future',
      pid: 4242,
      host: 'X',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      lockPath,
    }
    fs.writeFileSync(lockPath, JSON.stringify(meta))
    const old = new Date(Date.now() - 3_600_000)
    fs.utimesSync(lockPath, old, old)

    // mtime is an hour old, but expiresAt says "60s left": the lease holds.
    const response = await client.call('resource_acquire', { key, reason: 'must be refused' })
    assert.equal(response.result.isError, true, 'an old mtime must not override a lease that has not expired')
    assert.equal(readLockJson(lockPath).id, meta.id)
    assert.equal(path.basename(lockPath), 'mtime_key.lock')
    fs.rmSync(lockPath, { force: true })
  })
} finally {
  await client.close()
  sandbox.dispose()
}

done()