/**
 * Protocol test: drive a real server subprocess with a real JSON-RPC
 * sequence -- initialize -> notifications/initialized -> tools/list ->
 * tools/call acquire -> tools/call status -> tools/call release -- and assert
 * the shape of every response plus the on-disk contract of every lock file.
 *
 * Assertions are intentionally concrete (exact field sets, exact id pattern,
 * exact exit of a released lock) because the whole point of this server is a
 * contract that other tools read.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  McpClient,
  createSandbox,
  lockFileFor,
  readLockJson,
  sleep,
} from './lib/harness.mjs'
import { done, section, test } from './lib/tiny.mjs'

/** The fixed lock file field set, shared with the PowerShell CLI. */
const LOCK_FIELDS = ['id', 'key', 'mode', 'slots', 'slot', 'owner', 'reason', 'pid', 'host', 'createdAt', 'expiresAt', 'lockPath']

const sandbox = createSandbox('protocol')
const client = new McpClient({ lockRoot: sandbox.lockRoot, label: 'main' }).start()

/** Lease id captured from the acquire call, reused by status/release. */
let leaseId = ''

try {
  section(`01 protocol -- lock root ${sandbox.lockRoot}`)

  await test('initialize returns protocolVersion, capabilities.tools and serverInfo', async () => {
    const response = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'rl-test-main', version: '0.0.0' },
    })
    assert.equal(response.jsonrpc, '2.0')
    assert.equal(typeof response.id, 'number', 'response must echo the request id')
    assert.equal(response.error, undefined)
    assert.equal(response.result.protocolVersion, '2025-06-18', 'a supported version is echoed back')
    assert.equal(typeof response.result.capabilities.tools, 'object')
    assert.equal(response.result.serverInfo.name, 'resource-lease')
    assert.equal(typeof response.result.serverInfo.version, 'string')
    assert.ok(response.result.instructions.length > 100, 'initialize should carry usage instructions')
    assert.ok(/resource_acquire/.test(response.result.instructions))
  })

  await test('notifications/initialized produces no response at all', async () => {
    client.notify('notifications/initialized')
    await client.expectSilence(250)
  })

  await test('tools/list exposes exactly the three lease tools with valid schemas', async () => {
    const response = await client.request('tools/list')
    const tools = response.result.tools
    assert.deepEqual(tools.map((tool) => tool.name), ['resource_acquire', 'resource_release', 'resource_status'])

    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}.inputSchema.type`)
      assert.equal(typeof tool.inputSchema.properties, 'object', `${tool.name}.inputSchema.properties`)
      assert.ok(tool.description.length > 120, `${tool.name}.description must tell the model when to use it`)
      assert.equal(tool.outputSchema.type, 'object')
    }

    const acquire = tools.find((tool) => tool.name === 'resource_acquire')
    assert.deepEqual(acquire.inputSchema.required, ['key', 'reason'])
    for (const word of ['browser', 'port', 'screen', 'shared write target', 'BEFORE using it']) {
      assert.ok(acquire.description.includes(word), `acquire description should mention "${word}"`)
    }
    assert.ok(acquire.description.includes('resource_release'), 'acquire description should mention releasing')
    assert.deepEqual(acquire.inputSchema.properties.mode.enum, ['exclusive', 'shared', 'pool'])

    const acquireProps = Object.keys(acquire.outputSchema.properties).sort()
    assert.deepEqual(acquireProps, ['expiresAt', 'id', 'key', 'lockPath', 'mode', 'owner', 'reason', 'slot', 'slots', 'ttlMs', 'waitedMs'])
  })

  await test('ping answers {} and keeps the process alive', async () => {
    const response = await client.request('ping')
    assert.deepEqual(response.result, {})
    assert.equal(client.exit, null, 'the server must still be running')
  })

  await test('tools/call acquire returns a lease and writes the contract lock file', async () => {
    const response = await client.call('resource_acquire', {
      key: 'browser:chromium',
      reason: 'protocol test screenshots',
    })
    assert.equal(response.result?.isError, undefined, `unexpected isError: ${JSON.stringify(response.result)}`)

    const structured = response.result.structuredContent
    leaseId = structured.id
    assert.match(leaseId, /^lz_[0-9a-f]{12}$/, 'lease id must look like lz_<12 hex>')
    assert.equal(structured.key, 'browser:chromium')
    assert.equal(structured.mode, 'exclusive')
    assert.equal(structured.slot, 0)
    assert.equal(structured.slots, 1)
    assert.equal(structured.reason, 'protocol test screenshots')
    assert.match(structured.owner, /^pid:\d+$/, 'owner defaults to pid:<pid>')
    assert.equal(structured.ttlMs, 30000, 'default TTL is 30s')
    assert.ok(structured.expiresAt > Date.now(), 'expiresAt is in the future')
    assert.equal(structured.lockPath, lockFileFor(sandbox.lockRoot, 'browser:chromium'))
    assert.equal(response.result.content[0].type, 'text')
    assert.ok(response.result.content[0].text.includes(leaseId), 'the text must carry the id to release with')

    const meta = readLockJson(structured.lockPath)
    assert.notEqual(meta, null, 'the lock file must exist on disk')
    assert.deepEqual(Object.keys(meta).sort(), [...LOCK_FIELDS].sort(), 'lock file field set is the shared contract')
    assert.equal(meta.id, structured.id)
    assert.equal(meta.key, 'browser:chromium')
    assert.equal(meta.mode, 'exclusive')
    assert.equal(meta.slot, 0)
    assert.equal(meta.slots, 1)
    assert.equal(meta.owner, structured.owner)
    assert.equal(meta.reason, 'protocol test screenshots')
    assert.equal(typeof meta.pid, 'number')
    assert.equal(typeof meta.host, 'string')
    assert.equal(meta.expiresAt - meta.createdAt, 30000)
    assert.equal(meta.lockPath, structured.lockPath)

    const indexFile = path.join(sandbox.lockRoot, '_leases', `${structured.id}.json`)
    assert.ok(fs.existsSync(indexFile), 'the CLI index record is written so lease.ps1 release <id> can find it')
    const record = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    assert.equal(record.id, structured.id)
    assert.equal(record.key, 'browser:chromium')
    assert.equal(record.path, structured.lockPath)
  })

  await test('tools/call status lists the live lease with owner and remaining time', async () => {
    const response = await client.call('resource_status')
    const structured = response.result.structuredContent
    assert.ok(structured.count >= 1)
    assert.equal(structured.lockRoot, sandbox.lockRoot)
    assert.ok(structured.text.includes('browser:chromium'), 'status text names the key')
    assert.ok(structured.text.includes('you'), 'own leases are marked')
    assert.ok(structured.text.includes(leaseId), 'own leases show the id')
    assert.ok(/\ds left/.test(structured.text), 'status text shows remaining seconds')
  })

  await test('tools/call status filters by key', async () => {
    const response = await client.call('resource_status', { key: 'port:9999' })
    assert.equal(response.result.structuredContent.count, 0)
    assert.ok(response.result.structuredContent.text.includes('No live leases'))
  })

  await test('tools/call release deletes the lock file and the index record', async () => {
    const response = await client.call('resource_release', { id: leaseId })
    const structured = response.result.structuredContent
    assert.equal(structured.released, 1)
    assert.equal(structured.ids, leaseId)
    assert.ok(structured.text.includes(leaseId))

    assert.equal(fs.existsSync(lockFileFor(sandbox.lockRoot, 'browser:chromium')), false, 'lock file is gone')
    assert.equal(fs.existsSync(path.join(sandbox.lockRoot, '_leases', `${leaseId}.json`)), false, 'index record is gone')

    const after = await client.call('resource_status')
    assert.equal(after.result.structuredContent.count, 0)
  })

  await test('releasing an unknown id is isError:true, not a crash', async () => {
    const response = await client.call('resource_release', { id: 'lz_000000000000' })
    assert.equal(response.result.isError, true, 'unknown lease must be an isError result')
    assert.ok(/resource_status/.test(response.result.content[0].text), 'the message says how to inspect state')
    const ping = await client.request('ping')
    assert.deepEqual(ping.result, {}, 'the server survived the failed release')
  })

  await test('acquire without reason is isError:true with an actionable message', async () => {
    const response = await client.call('resource_acquire', { key: 'port:9222' })
    assert.equal(response.result.isError, true)
    assert.ok(/reason/.test(response.result.content[0].text))
    assert.equal(sandbox.listLockFiles().length, 0, 'a rejected acquire must not leave a lock file behind')
  })

  await test('acquire with an invalid mode is isError:true', async () => {
    const response = await client.call('resource_acquire', { key: 'port:9222', reason: 'x', mode: 'greedy' })
    assert.equal(response.result.isError, true)
    assert.ok(/exclusive/.test(response.result.content[0].text), 'the message lists the valid modes')
  })

  await test('busy acquire reports the holder, the reason and the remaining time', async () => {
    const first = await client.call('resource_acquire', { key: 'dir:src/parser', reason: 'formatting the parser' })
    assert.equal(first.result.isError, undefined)

    const second = await client.call('resource_acquire', { key: 'dir:src/parser', reason: 'second writer' })
    const text = second.result.content[0].text
    assert.equal(second.result.isError, true)
    assert.ok(/Resource busy: dir:src\/parser/.test(text), text)
    assert.ok(text.includes(first.result.structuredContent.owner), 'busy message names the holder')
    assert.ok(text.includes('formatting the parser'), 'busy message carries the holder reason')
    assert.ok(/\ds left/.test(text), 'busy message carries the remaining time')
    assert.ok(/waitMs/.test(text), 'busy message suggests waiting instead of retrying in a loop')

    const released = await client.call('resource_release', { key: 'dir:src/parser' })
    assert.equal(released.result.structuredContent.released, 1, 'release by key works')
  })

  await test('pool mode hands out one slot per holder and then fails', async () => {
    const a = await client.call('resource_acquire', { key: 'browser:pool', reason: 'slot a', mode: 'pool', slots: 2 })
    const b = await client.call('resource_acquire', { key: 'browser:pool', reason: 'slot b', mode: 'pool', slots: 2 })
    const c = await client.call('resource_acquire', { key: 'browser:pool', reason: 'slot c', mode: 'pool', slots: 2 })
    assert.equal(a.result.structuredContent.slot, 0)
    assert.equal(b.result.structuredContent.slot, 1)
    assert.equal(c.result.isError, true, 'a full pool must refuse a third holder')
    assert.ok(fs.existsSync(lockFileFor(sandbox.lockRoot, 'browser:pool', 'pool', 0)))
    assert.ok(fs.existsSync(lockFileFor(sandbox.lockRoot, 'browser:pool', 'pool', 1)))
    assert.equal(fs.existsSync(lockFileFor(sandbox.lockRoot, 'browser:pool', 'pool', 2)), false)

    const released = await client.call('resource_release', { all: true })
    assert.equal(released.result.structuredContent.released, 2, 'release all=true releases both slots')
  })

  await test('unknown tool name is a JSON-RPC -32602 error', async () => {
    const response = await client.call('resource_steal', {})
    assert.equal(response.error?.code, -32602)
    assert.ok(/resource_acquire/.test(response.error.message), 'the error lists the available tools')
  })

  await test('unknown method is a JSON-RPC -32601 error', async () => {
    const response = await client.request('resources/list')
    assert.equal(response.error?.code, -32601)
  })

  await test('a malformed line yields -32700 and the server keeps serving', async () => {
    client.writeRaw('{ this is not json')
    const parseError = await new Promise((resolve, reject) => {
      const started = Date.now()
      const poll = setInterval(() => {
        const found = client.unsolicited.find((message) => message.error?.code === -32700)
        if (found !== undefined) {
          clearInterval(poll)
          resolve(found)
        } else if (Date.now() - started > 5000) {
          clearInterval(poll)
          reject(new Error('no -32700 response to the malformed line'))
        }
      }, 25)
    })
    assert.equal(parseError.error.code, -32700)
    const ping = await client.request('ping')
    assert.deepEqual(ping.result, {})
  })

  await test('stdout carried JSON-RPC only: no stray log lines', async () => {
    assert.deepEqual(client.badLines, [], 'every stdout line must parse as JSON')
    for (const line of client.stdoutLines) {
      const message = JSON.parse(line)
      assert.equal(message.jsonrpc, '2.0')
    }
    assert.ok(client.stdoutLines.length >= 12, 'the sequence above produced real traffic')
    assert.ok(client.stderr.includes('[resource-lease]'), 'diagnostics go to stderr')
    assert.ok(client.stderr.includes('lock root:'), 'stderr names the resolved lock root')
  })

  await test('--lock-root beats DSH_RESOURCE_LOCK_ROOT, which beats the platform default', async () => {
    const envRoot = path.join(sandbox.base, 'locks-from-env')
    const argClient = new McpClient({
      lockRoot: sandbox.lockRoot,
      env: { DSH_RESOURCE_LOCK_ROOT: envRoot },
      label: 'arg',
    }).start()
    const envClient = new McpClient({
      lockRoot: sandbox.lockRoot,
      useLockRootArg: false,
      env: { DSH_RESOURCE_LOCK_ROOT: envRoot },
      label: 'env',
    }).start()
    try {
      await argClient.initialize()
      await envClient.initialize()
      await argClient.call('resource_acquire', { key: 'port:1111', reason: 'arg wins' })
      await envClient.call('resource_acquire', { key: 'port:2222', reason: 'env wins' })

      assert.ok(fs.existsSync(lockFileFor(sandbox.lockRoot, 'port:1111')), '--lock-root wins over the environment')
      assert.ok(fs.existsSync(lockFileFor(envRoot, 'port:2222')), 'the environment is used when there is no flag')
      assert.equal(fs.existsSync(lockFileFor(sandbox.lockRoot, 'port:2222')), false)
    } finally {
      await argClient.close()
      await envClient.close()
    }
  })

  await test('an unsupported protocolVersion falls back to the newest version spoken', async () => {
    const probe = new McpClient({ lockRoot: sandbox.lockRoot, label: 'proto' }).start()
    try {
      const response = await probe.initialize('1999-01-01')
      assert.equal(response.result.protocolVersion, '2025-06-18', 'never echo a version we cannot speak')
    } finally {
      await probe.close()
    }
  })

  await test('an in-flight waitMs acquire does not keep the process alive after disconnect', async () => {
    // A queueing acquire sleeps up to maxWaitMs. If that timer were left
    // pending, the process would survive the client by up to two minutes with
    // nobody to answer. shutdown() cancels the waits, so exit is immediate.
    const holder = new McpClient({ lockRoot: sandbox.lockRoot, label: 'holder2' }).start()
    const waiter = new McpClient({ lockRoot: sandbox.lockRoot, label: 'waiter' }).start()
    try {
      await holder.initialize()
      await waiter.initialize()
      await holder.call('resource_acquire', { key: 'port:9555', reason: 'held during the test', ttlMs: 120000 })

      const inflight = waiter.call('resource_acquire', { key: 'port:9555', reason: 'queueing', waitMs: 60000 }, 70000)
      inflight.catch(() => {}) // the connection dies mid-flight; the rejection is expected
      await sleep(250)

      const closedAt = Date.now()
      await waiter.close()
      const elapsed = Date.now() - closedAt
      assert.equal(waiter.exit?.code, 0, `the server should exit 0 on stdin close, got ${JSON.stringify(waiter.exit)}`)
      assert.ok(elapsed < 3000, `the process must not linger on a pending waitMs timer (took ${elapsed}ms)`)
      console.log(`        exited ${elapsed}ms after disconnect, while a 60s wait was pending`)

      await holder.call('resource_release', { all: true })
    } finally {
      await holder.close()
      await waiter.close()
    }
  })

  await test('closing the connection releases the leases it held', async () => {
    const holder = new McpClient({ lockRoot: sandbox.lockRoot, label: 'holder' }).start()
    await holder.initialize()
    await holder.call('resource_acquire', { key: 'screen:focus', reason: 'about to disconnect' })
    const lockPath = lockFileFor(sandbox.lockRoot, 'screen:focus')
    assert.ok(fs.existsSync(lockPath), 'the lease exists while the client is connected')
    await holder.close()
    await sleep(100)
    assert.equal(fs.existsSync(lockPath), false, 'a clean disconnect hands the resource back')
    assert.equal(holder.exit?.code, 0, 'the server exits 0 on stdin close')
  })
} finally {
  await client.close()
  sandbox.dispose()
}

done()
