/**
 * Mutual exclusion test.
 *
 * Three layers, because "it works when I try it" is not evidence:
 *   1. the literal requirement: two independent server processes ask for the
 *      same key at the same moment -- exactly one wins;
 *   2. an 8-way race repeated across three keys, so a lucky ordering cannot
 *      pass it;
 *   3. a control experiment on the primitives themselves, which is the only
 *      way to show that the file lock is doing the work: the same race with an
 *      idempotent `mkdirSync(target, { recursive: true })` lets EVERY process
 *      win (the "do not use a directory as a lock" trap from DESIGN.md
 *      section 7), while openSync(...,'wx') lets exactly one win.
 *
 *   Note on the trap's exact shape: bare `fs.mkdirSync(target)` DOES throw
 *   EEXIST, so it would arbitrate by accident -- it is the recursive (or
 *   PowerShell `-Force`) form that silently succeeds for every racer, and that
 *   form is the natural thing to write. A directory is also the wrong carrier
 *   for the lease body: the 12 fields cannot be written into it atomically.
 *
 * Every attempt fires in the same event-loop tick (frames are written before
 * any promise is awaited) and the raw fixture children share a spin-wait
 * start line, so the races are genuinely simultaneous rather than merely
 * close together.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpClient, createSandbox, lockFileFor, startClients } from './lib/harness.mjs'
import { done, section, test } from './lib/tiny.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RACE_CHILD = path.join(HERE, 'lib', 'raw-race-child.mjs')

const sandbox = createSandbox('mutex')

/**
 * Run the raw-primitive race: N children all try to grab `target` at the same
 * instant, and we count the winners.
 *
 * @param {'dir'|'wx'} mode which primitive to use.
 * @param {string} target path to create.
 * @param {number} racers how many processes race.
 * @returns {Promise<{ winners: number[], losers: number, results: Array<{ won: boolean, error?: string, pid: number }> }>} outcome.
 */
async function rawRace(mode, target, racers) {
  const startAt = Date.now() + 1500
  const children = []
  for (let i = 0; i < racers; i += 1) {
    children.push(
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [RACE_CHILD, mode, target, String(startAt)], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          stdout += chunk
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('error', reject)
        child.on('exit', (code) => {
          const line = stdout.trim().split('\n').filter(Boolean).pop()
          if (line === undefined) {
            reject(new Error(`race child exited ${code} with no output: ${stderr}`))
            return
          }
          resolve(JSON.parse(line))
        })
      }),
    )
  }
  const results = await Promise.all(children)
  const winners = results.filter((result) => result.won)
  return { winners: winners.map((result) => result.pid), losers: results.length - winners.length, results }
}

/**
 * Fire one acquire from every client in the same tick and wait for all.
 *
 * @param {McpClient[]} clients initialized clients.
 * @param {string} key resource key.
 * @returns {Promise<Array<Record<string, any>>>} responses.
 */
async function raceAcquire(clients, key) {
  const promises = clients.map((client) => client.send('tools/call', {
    name: 'resource_acquire',
    arguments: { key, reason: 'mutex race' },
  }))
  return Promise.all(promises)
}

section(`02 mutex -- lock root ${sandbox.lockRoot}`)

try {
  await test('two independent processes, same key, same instant: exactly one succeeds', async () => {
    const clients = await startClients(2, sandbox.lockRoot, 'duo')
    try {
      const [a, b] = await raceAcquire(clients, 'browser:chromium')
      const results = [a, b]
      const winners = results.filter((response) => response.result.isError !== true)
      const losers = results.filter((response) => response.result.isError === true)
      assert.equal(winners.length, 1, `exactly one winner expected, got ${winners.length}`)
      assert.equal(losers.length, 1, `exactly one loser expected, got ${losers.length}`)

      const winnerOwner = winners[0].result.structuredContent.owner
      const loserText = losers[0].result.content[0].text
      assert.ok(/Resource busy: browser:chromium/.test(loserText), loserText)
      assert.ok(loserText.includes(winnerOwner), 'the loser is told who holds the lock')
      assert.ok(/\ds left/.test(loserText), 'the loser is told how long is left')

      assert.deepEqual(sandbox.listLockFiles(), ['browser_chromium.lock'], 'one lock file, not two')
      const released = await clients[0].call('resource_release', { all: true })
      const released2 = await clients[1].call('resource_release', { all: true })
      assert.equal(released.result.structuredContent.released + released2.result.structuredContent.released, 1)
    } finally {
      for (const client of clients) await client.close()
    }
  })

  await test('8 processes racing for 3 different keys: one winner per key every round', async () => {
    const keys = ['port:9240', 'browser:profile:main', 'dir:src/parser']
    const clients = await startClients(8, sandbox.lockRoot, 'oct')
    try {
      for (const key of keys) {
        const responses = await raceAcquire(clients, key)
        const winners = responses.filter((response) => response.result.isError !== true)
        const losers = responses.filter((response) => response.result.isError === true)

        assert.equal(winners.length, 1, `${key}: exactly one winner, got ${winners.length}`)
        assert.equal(losers.length, 7, `${key}: seven losers, got ${losers.length}`)
        for (const loser of losers) {
          assert.equal(loser.result.isError, true)
          assert.ok(/Resource busy/.test(loser.result.content[0].text))
        }

        const lockFiles = sandbox.listLockFiles()
        assert.equal(lockFiles.length, 1, `${key}: one lock file, got ${lockFiles.join(', ')}`)
        assert.deepEqual(lockFiles, [path.basename(lockFileFor(sandbox.lockRoot, key))])

        const winnerOwner = winners[0].result.structuredContent.owner
        const winnerIndex = responses.indexOf(winners[0])
        const released = await clients[winnerIndex].call('resource_release', { all: true })
        assert.equal(released.result.structuredContent.released, 1, `${key}: the winner releases its lease`)
        assert.equal(sandbox.listLockFiles().length, 0, `${key}: the lock root is empty again`)
        assert.ok(winnerOwner.startsWith('pid:'))
      }
    } finally {
      for (const client of clients) await client.close()
    }
  })

  await test('concurrent acquires of DIFFERENT keys do not block each other', async () => {
    const clients = await startClients(4, sandbox.lockRoot, 'par')
    try {
      const keys = ['port:9300', 'port:9301', 'screen:focus', 'repo:root']
      const responses = await Promise.all(clients.map((client, index) => client.call('resource_acquire', {
        key: keys[index],
        reason: `parallel ${index}`,
      })))
      for (const response of responses) {
        assert.equal(response.result.isError, undefined, `unexpected error: ${JSON.stringify(response.result)}`)
      }
      assert.equal(sandbox.listLockFiles().length, 4, 'the lock is per key, not global')
      for (const client of clients) await client.call('resource_release', { all: true })
    } finally {
      for (const client of clients) await client.close()
    }
  })

  await test('the loser can acquire right after the winner releases (no stuck state)', async () => {
    const clients = await startClients(2, sandbox.lockRoot, 'seq')
    try {
      const responses = await raceAcquire(clients, 'port:9400')
      const winnerIndex = responses.findIndex((response) => response.result.isError !== true)
      assert.notEqual(winnerIndex, -1, 'someone must win the first race')
      const loserIndex = winnerIndex === 0 ? 1 : 0

      const second = await clients[loserIndex].call('resource_acquire', { key: 'port:9400', reason: 'second try' })
      assert.equal(second.result.isError, true, 'still busy while the first holder keeps it')

      await clients[winnerIndex].call('resource_release', { all: true })
      const third = await clients[loserIndex].call('resource_acquire', { key: 'port:9400', reason: 'second try' })
      assert.equal(third.result.isError, undefined, 'the key is free once released')
      await clients[loserIndex].call('resource_release', { all: true })
    } finally {
      for (const client of clients) await client.close()
    }
  })

  await test('CONTROL: an idempotent mkdir lock lets every racer win, so it cannot arbitrate', async () => {
    const racers = 6
    const result = await rawRace('dir-recursive', path.join(sandbox.base, 'mkdir-lock'), racers)
    assert.equal(result.winners.length, racers,
      `recursive mkdir is idempotent: expected all ${racers} racers to "win", got ${result.winners.length}. `
      + 'Reporting a single winner here would mean the race was not simultaneous enough to be meaningful.')
    assert.equal(result.results.filter((one) => one.error !== '').length, 0, 'nobody sees an error')
  })

  await test('CONTROL: openSync(...,"wx") lets exactly one racer win', async () => {
    const fileTarget = path.join(sandbox.base, 'wx-lock')
    const result = await rawRace('wx', fileTarget, 6)
    assert.equal(result.winners.length, 1, `exactly one winner expected, got ${result.winners.length}`)
    assert.equal(result.losers, 5)
    for (const failed of result.results.filter((one) => !one.won)) {
      assert.equal(failed.error, 'EEXIST', 'losers fail with EEXIST, not a silent success')
    }
  })
} finally {
  sandbox.dispose()
}

done()
