/**
 * TTL test: a lease that is not released must expire and become takeable, in
 * both directions between this server and the PowerShell CLI.
 *
 * This is the crash-recovery guarantee. A lease that outlives its holder
 * without expiring is worse than no lease at all, so every path here asserts
 * the observable facts: the old holder really blocks while the TTL runs, the
 * old lock file is archived as `.stale.`, and the new holder is a *different*
 * lease id.
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
  sleep,
} from './lib/harness.mjs'
import { done, section, test } from './lib/tiny.mjs'

const sandbox = createSandbox('ttl')

/** A TTL short enough to keep the suite fast, above the server's 1000ms floor. */
const SHORT_TTL_MS = 1200

/**
 * @returns {string[]} archived takeover files in the lock root.
 */
function staleFiles() {
  try {
    return fs.readdirSync(sandbox.lockRoot).filter((name) => name.includes('.stale.'))
  } catch {
    return []
  }
}

section(`04 ttl -- lock root ${sandbox.lockRoot}`)

try {
  await test('a lease blocks other holders until its TTL runs out, then one takes over', async () => {
    const first = new McpClient({ lockRoot: sandbox.lockRoot, label: 'first' }).start()
    const second = new McpClient({ lockRoot: sandbox.lockRoot, label: 'second' }).start()
    try {
      await first.initialize()
      await second.initialize()

      const held = await first.call('resource_acquire', {
        key: 'browser:chromium',
        reason: 'short lease',
        ttlMs: SHORT_TTL_MS,
      })
      assert.equal(held.result.isError, undefined)
      const oldLease = held.result.structuredContent
      assert.equal(oldLease.ttlMs, SHORT_TTL_MS)

      const whileHeld = await second.call('resource_acquire', { key: 'browser:chromium', reason: 'too early' })
      assert.equal(whileHeld.result.isError, true, 'the TTL has not run out yet, so the lease must still hold')

      const lockPath = lockFileFor(sandbox.lockRoot, 'browser:chromium')
      const before = readLockJson(lockPath)
      assert.equal(before.id, oldLease.id)

      // Let the TTL lapse. 300ms of slack keeps this from being a flaky race
      // against the 1ms granularity of expiresAt.
      await sleep(SHORT_TTL_MS + 300)

      const takeover = await second.call('resource_acquire', { key: 'browser:chromium', reason: 'takeover after expiry' })
      assert.equal(takeover.result.isError, undefined, `takeover failed: ${JSON.stringify(takeover.result)}`)
      const newLease = takeover.result.structuredContent
      assert.notEqual(newLease.id, oldLease.id, 'the takeover must mint a NEW lease id')
      assert.equal(newLease.reason, 'takeover after expiry')
      assert.match(newLease.owner, /^pid:\d+$/)

      const after = readLockJson(lockPath)
      assert.equal(after.id, newLease.id, 'the lock file now carries the new lease')

      const archived = staleFiles()
      assert.equal(archived.length, 1, `the expired lease must be archived as .stale., found: ${archived.join(', ')}`)
      const archivedBody = readLockJson(path.join(sandbox.lockRoot, archived[0]))
      assert.equal(archivedBody?.id, oldLease.id, 'the archived copy is the OLD lease, kept for forensics')
      assert.equal(archivedBody?.owner, oldLease.owner)
      console.log(`        archived: ${archived[0]} (old id ${oldLease.id} -> new id ${newLease.id})`)

      // The old holder can no longer release the new lease by its stale id.
      const staleRelease = await first.call('resource_release', { id: oldLease.id })
      assert.equal(staleRelease.result.isError, true, 'a taken-over lease id is no longer yours to release')
      assert.equal(readLockJson(lockPath)?.id, newLease.id, 'the failed release left the new lease intact')

      await second.call('resource_release', { all: true })
      assert.equal(sandbox.listLockFiles().length, 0)
    } finally {
      await first.close()
      await second.close()
    }
  })

  await test('REGRESSION: a stale in-memory record must not delete the new holder\'s lease', async () => {
    // The bug this pins down: holder A keeps its lease record in memory. The
    // lease expires, B takes over (new id, same lock file path). A then calls
    // resource_release with its OLD id. A naive implementation deletes the
    // lock file it recorded -- which is now B's lock -- so B loses a resource
    // it still legitimately holds. The lock file is authoritative, so the
    // recorded id must match the file's id before anything is deleted.
    const a = new McpClient({ lockRoot: sandbox.lockRoot, label: 'staleA' }).start()
    const b = new McpClient({ lockRoot: sandbox.lockRoot, label: 'staleB' }).start()
    try {
      await a.initialize()
      await b.initialize()
      const lockPath = lockFileFor(sandbox.lockRoot, 'dir:regression')

      const aLease = (await a.call('resource_acquire', { key: 'dir:regression', reason: 'A holds', ttlMs: 1000 })).result.structuredContent
      await sleep(1400)
      const bLease = (await b.call('resource_acquire', { key: 'dir:regression', reason: 'B takes over' })).result.structuredContent
      assert.notEqual(aLease.id, bLease.id)

      const staleRelease = await a.call('resource_release', { id: aLease.id })
      assert.equal(staleRelease.result.isError, true, 'A must not be able to release a lease that was taken over')
      assert.ok(/took the resource over/.test(staleRelease.result.content[0].text), staleRelease.result.content[0].text)

      const onDisk = readLockJson(lockPath)
      assert.notEqual(onDisk, null, "B's lock file must still exist")
      assert.equal(onDisk.id, bLease.id, "B's lease must be untouched")

      const bStaysBusy = await a.call('resource_acquire', { key: 'dir:regression', reason: 'A tries again' })
      assert.equal(bStaysBusy.result.isError, true, 'B still holds the resource')

      const bRelease = await b.call('resource_release', { id: bLease.id })
      assert.equal(bRelease.result.structuredContent.released, 1, 'B releases its own lease normally')
      assert.equal(sandbox.listLockFiles().length, 0)
    } finally {
      await a.close()
      await b.close()
    }
  })

  await test('resource_status hides expired leases unless includeExpired is set', async () => {
    const client = new McpClient({ lockRoot: sandbox.lockRoot, label: 'status' }).start()
    try {
      await client.initialize()
      const held = await client.call('resource_acquire', {
        key: 'repo:root',
        reason: 'expiring soon',
        ttlMs: SHORT_TTL_MS,
      })
      assert.equal(held.result.isError, undefined)
      await sleep(SHORT_TTL_MS + 300)

      const hidden = await client.call('resource_status', { key: 'repo:root' })
      assert.equal(hidden.result.structuredContent.count, 0, 'expired leases are hidden by default')

      const shown = await client.call('resource_status', { key: 'repo:root', includeExpired: true })
      assert.equal(shown.result.structuredContent.count, 1, 'includeExpired surfaces the takeable lease')
      assert.ok(/expired, takeable/.test(shown.result.structuredContent.text), shown.result.structuredContent.text)

      await client.call('resource_release', { all: true })
      assert.equal(sandbox.listLockFiles().length, 0, 'releasing our own expired lease still works')
    } finally {
      await client.close()
    }
  })

  await test('ttlMs below the floor is clamped to 1000ms (no instantly-dead lease)', async () => {
    const client = new McpClient({ lockRoot: sandbox.lockRoot, label: 'clamp' }).start()
    try {
      await client.initialize()
      const held = await client.call('resource_acquire', { key: 'screen:focus', reason: 'tiny ttl', ttlMs: 10 })
      assert.equal(held.result.structuredContent.ttlMs, 1000)
      const meta = readLockJson(lockFileFor(sandbox.lockRoot, 'screen:focus'))
      assert.equal(meta.expiresAt - meta.createdAt, 1000)
      await client.call('resource_release', { all: true })
    } finally {
      await client.close()
    }
  })

  await test('duration strings are accepted for ttlMs ("2s" == 2000ms)', async () => {
    const client = new McpClient({ lockRoot: sandbox.lockRoot, label: 'units' }).start()
    try {
      await client.initialize()
      const held = await client.call('resource_acquire', { key: 'port:9500', reason: 'string ttl', ttlMs: '2s' })
      assert.equal(held.result.structuredContent.ttlMs, 2000)
      await client.call('resource_release', { all: true })
    } finally {
      await client.close()
    }
  })

  await test('waitMs queues instead of failing, and succeeds once the holder releases', async () => {
    const holder = new McpClient({ lockRoot: sandbox.lockRoot, label: 'holder' }).start()
    const waiter = new McpClient({ lockRoot: sandbox.lockRoot, label: 'waiter' }).start()
    try {
      await holder.initialize()
      await waiter.initialize()
      const held = await holder.call('resource_acquire', { key: 'port:9600', reason: 'holder works' })
      assert.equal(held.result.isError, undefined)

      const waiting = waiter.call('resource_acquire', { key: 'port:9600', reason: 'waiter queues', waitMs: 8000 }, 15000)
      await sleep(300)
      await holder.call('resource_release', { all: true })

      const response = await waiting
      assert.equal(response.result.isError, undefined, `the queue should have been served: ${JSON.stringify(response.result)}`)
      const acquired = response.result.structuredContent
      assert.ok(acquired.waitedMs >= 200, `waitedMs should show the queue time, got ${acquired.waitedMs}`)
      console.log(`        queued acquire: waited ${acquired.waitedMs}ms, lease ${acquired.id}`)
      await waiter.call('resource_release', { all: true })
    } finally {
      await holder.close()
      await waiter.close()
    }
  })

  await test('waitMs times out with a busy error naming the holder', async () => {
    const holder = new McpClient({ lockRoot: sandbox.lockRoot, label: 'holder2' }).start()
    const waiter = new McpClient({ lockRoot: sandbox.lockRoot, label: 'waiter2' }).start()
    try {
      await holder.initialize()
      await waiter.initialize()
      await holder.call('resource_acquire', { key: 'port:9700', reason: 'long work', ttlMs: 60000 })

      const started = Date.now()
      const response = await waiter.call('resource_acquire', { key: 'port:9700', reason: 'waits then fails', waitMs: 600 }, 15000)
      const elapsed = Date.now() - started
      assert.equal(response.result.isError, true)
      assert.ok(elapsed >= 550, `should have waited about 600ms, waited ${elapsed}ms`)
      assert.ok(/Resource busy: port:9700/.test(response.result.content[0].text))
      assert.ok(/long work/.test(response.result.content[0].text))
      await holder.call('resource_release', { all: true })
    } finally {
      await holder.close()
      await waiter.close()
    }
  })

  await test('CROSS-TOOL: the CLI takes over an expired MCP lease', async () => {
    const client = new McpClient({ lockRoot: sandbox.lockRoot, label: 'expiring' }).start()
    try {
      await client.initialize()
      const held = await client.call('resource_acquire', {
        key: 'browser:profile:main',
        reason: 'MCP will vanish',
        ttlMs: SHORT_TTL_MS,
      })
      const oldId = held.result.structuredContent.id
      await sleep(SHORT_TTL_MS + 600)

      const cli = runCli(['acquire', 'browser:profile:main', '--ttl', '20s', '--owner', 'cli-takeover', '--reason', 'took over'], sandbox.lockRoot)
      assert.equal(cli.code, 0, `the CLI must be able to take over the expired lease (exit ${cli.code}):\n${cli.output}`)
      const meta = readLockJson(lockFileFor(sandbox.lockRoot, 'browser:profile:main'))
      assert.equal(meta.owner, 'cli-takeover')
      assert.notEqual(meta.id, oldId)

      const status = await client.call('resource_status', { key: 'browser:profile:main' })
      assert.equal(status.result.structuredContent.count, 1)
      assert.ok(status.result.structuredContent.text.includes('cli-takeover'))
      console.log(`        CLI took over: old ${oldId} -> new ${meta.id} (owner cli-takeover)`)

      runCli(['release', '--all', '--owner', 'cli-takeover'], sandbox.lockRoot)
    } finally {
      await client.close()
    }
  })

  await test('CROSS-TOOL: the MCP server takes over an expired CLI lease', async () => {
    const cli = runCli(['acquire', 'port:9800', '--ttl', '1s', '--owner', 'cli-expiring', '--reason', 'CLI lease lapsing'], sandbox.lockRoot)
    assert.equal(cli.code, 0, `CLI acquire failed:\n${cli.output}`)
    const cliLease = JSON.parse(cli.stdout)
    await sleep(1600)

    const client = new McpClient({ lockRoot: sandbox.lockRoot, label: 'takerover' }).start()
    try {
      await client.initialize()
      const takeover = await client.call('resource_acquire', { key: 'port:9800', reason: 'MCP takes over' })
      assert.equal(takeover.result.isError, undefined, `takeover failed: ${JSON.stringify(takeover.result)}`)
      const meta = readLockJson(lockFileFor(sandbox.lockRoot, 'port:9800'))
      assert.notEqual(meta.id, cliLease.id, 'the MCP server minted a new lease')
      assert.match(meta.owner, /^pid:\d+$/)
      assert.ok(staleFiles().length >= 1, 'the CLI lease was archived as .stale.')
      console.log(`        MCP took over: old ${cliLease.id} -> new ${meta.id}`)
      await client.call('resource_release', { all: true })
      assert.equal(sandbox.listLockFiles().length, 0)
    } finally {
      await client.close()
      runCli(['release', '--all', '--owner', 'cli-expiring'], sandbox.lockRoot)
    }
  })
} finally {
  sandbox.dispose()
}

done()
