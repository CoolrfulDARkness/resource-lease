/**
 * Release must FAIL CLOSED when the lock file on disk does not carry the id we
 * are releasing.
 *
 * Why this exists. releaseById() deletes a lock file by path, so the only thing
 * standing between a late release and someone else's live lease is the id check.
 * That check used to be written as
 *
 *     if (typeof onDisk.id === 'string' && onDisk.id !== id) return false
 *
 * which only rejects a *different string*. A lock file that parses but has no
 * usable id -- `{}` from an older/other tool, or `{"id":12345}` -- fell straight
 * through to removeLock() and was DELETED, i.e. a silent hijack of whatever held
 * that path. The plugin (removeIfOwned) and the CLI (Remove-LeaseById, which
 * compares a stringified '' and keeps the file) both already refused; only this
 * server deleted. The rule is now identical in all three: no exact string id,
 * no delete.
 *
 * Deterministic: the on-disk states are written directly, no races.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

import { McpClient, createSandbox, lockFileFor, readLockJson } from './lib/harness.mjs'
import { done, section, test } from './lib/tiny.mjs'

const sandbox = createSandbox('release-fail-closed')
const client = new McpClient({ lockRoot: sandbox.lockRoot, label: 'fail-closed' }).start()

/**
 * Acquire one lease and hand back its id and lock file path.
 *
 * @param {string} key resource key.
 * @returns {Promise<{ id: string, lockPath: string }>} the new lease.
 */
async function acquire(key) {
  const response = await client.call('resource_acquire', { key, reason: 'fail-closed test', ttlMs: 30_000 })
  assert.equal(response.result.isError, undefined, `acquire failed: ${JSON.stringify(response.result)}`)
  return {
    id: response.result.structuredContent.id,
    lockPath: lockFileFor(sandbox.lockRoot, key),
  }
}

/**
 * Rewrite a live lock file's body, keeping it parseable and unexpired.
 *
 * @param {string} lockPath lock file path.
 * @param {Record<string, any>} body replacement JSON body.
 */
function rewriteBody(lockPath, body) {
  const current = readLockJson(lockPath)
  assert.notEqual(current, null, 'the lock file must exist before it is rewritten')
  fs.writeFileSync(lockPath, JSON.stringify({ ...current, ...body }))
}

section(`06 release fail-closed -- lock root ${sandbox.lockRoot}`)

try {
  await client.initialize()

  await test('a lock file whose id is a NUMBER is not deleted', async () => {
    const lease = await acquire('failclosed:numeric')
    rewriteBody(lease.lockPath, { id: 12345 })

    const response = await client.call('resource_release', { id: lease.id })
    assert.equal(response.result.isError, true, 'releasing a lock that no longer carries our id must fail')
    assert.equal(fs.existsSync(lease.lockPath), true, 'the lock file must NOT be deleted')
    assert.equal(readLockJson(lease.lockPath).id, 12345, 'the foreign body is left untouched')
    fs.rmSync(lease.lockPath, { force: true })
  })

  await test('a lock file with no id field at all is not deleted', async () => {
    const lease = await acquire('failclosed:no-id')
    const body = readLockJson(lease.lockPath)
    delete body.id
    fs.writeFileSync(lease.lockPath, JSON.stringify(body))

    const response = await client.call('resource_release', { id: lease.id })
    assert.equal(response.result.isError, true, 'a lock file with no id is not provably ours')
    assert.equal(fs.existsSync(lease.lockPath), true, 'the lock file must NOT be deleted')
    assert.equal(readLockJson(lease.lockPath).id, undefined)
    fs.rmSync(lease.lockPath, { force: true })
  })

  await test('an exact id match still releases normally (the guard is not a blanket refusal)', async () => {
    const lease = await acquire('failclosed:match')
    rewriteBody(lease.lockPath, { reason: 'body rewritten by its own holder' })

    const response = await client.call('resource_release', { id: lease.id })
    assert.equal(response.result.isError, undefined, `a matching release must succeed: ${JSON.stringify(response.result)}`)
    assert.equal(response.result.structuredContent.released, 1)
    assert.equal(fs.existsSync(lease.lockPath), false, 'our own lock file is deleted')
  })
} finally {
  await client.close()
  sandbox.dispose()
}

done()
