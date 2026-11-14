/**
 * Cross-tool test: the MCP server and the PowerShell CLI must see ONE set of
 * leases, in both directions.
 *
 * This is the core selling point of the delivery, and it is the assertion that
 * breaks first if anyone "improves" the lock format, the sanitize rule, or the
 * index layout. Four independent directions are checked:
 *
 *   MCP acquires   -> lease.ps1 status sees it
 *   MCP acquires   -> lease.ps1 acquire on that key exits 2 (busy)
 *   lease.ps1 acquires -> resource_status sees it, resource_acquire fails busy
 *   lease.ps1 release <id> releases a lease the MCP server created (index interop)
 *
 * Plus key sanitization: "dir:src/parser" and "dir_src_parser" are different
 * keys but the same lock file, so the two tools must still collide. If that
 * ever stops colliding, mutual exclusion between tools is silently gone.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  CLI,
  McpClient,
  PACKAGE_ROOT,
  SERVER,
  createSandbox,
  detectPowerShell,
  lockFileFor,
  readLockJson,
  runCli,
  scrubEnv,
} from './lib/harness.mjs'
import { done, section, skip, test } from './lib/tiny.mjs'

const sandbox = createSandbox('cross')
const client = new McpClient({ lockRoot: sandbox.lockRoot, label: 'mcp' }).start()

let powerShell = null

/**
 * The CLI half of this file needs two things that a third-party checkout may
 * legitimately not have: the CLI file inside the package, and a PowerShell host.
 * When either is missing the checks are SKIPPED with a printed reason -- never
 * faked, and never a red run that is actually an environment problem.
 */
let cliSkipReason = null

/**
 * Run a CLI-dependent check, or skip it with the recorded reason.
 *
 * @param {string} name check name.
 * @param {() => Promise<void> | void} fn body.
 * @returns {Promise<void>} resolves when done (or skipped).
 */
function cliTest(name, fn) {
  if (cliSkipReason !== null) {
    skip(name, cliSkipReason)
    return Promise.resolve()
  }
  return test(name, fn)
}

try {
  section(`03 cross-tool -- lock root ${sandbox.lockRoot}`)
  try {
    powerShell = detectPowerShell()
    console.log(`  (PowerShell host: ${powerShell.cmd}, version ${powerShell.version})`)
  } catch (error) {
    cliSkipReason = `no PowerShell host available: ${error instanceof Error ? error.message : error}`
  }
  if (cliSkipReason === null && !fs.existsSync(CLI)) {
    cliSkipReason =
      `the packaged reference CLI is not present: ${CLI}\n` +
      '        (it ships as <package>/cli/lease.ps1; copy the whole package, not just mcp/)'
  }
  if (cliSkipReason !== null) {
    console.log(`  (CLI-dependent checks will be SKIPPED: ${cliSkipReason.split('\n')[0]})`)
  }

  await cliTest('the CLI under test lives inside this package', () => {
    const resolved = path.resolve(CLI)
    assert.equal(fs.existsSync(resolved), true, `expected the packaged CLI at ${resolved}`)
    assert.ok(
      resolved === PACKAGE_ROOT || resolved.startsWith(PACKAGE_ROOT + path.sep),
      `${resolved} must live under ${PACKAGE_ROOT}, or this suite tests a file that is not part of the package`,
    )
    console.log(`        CLI: ${resolved}`)
  })

  await client.initialize()
  const serverPid = (await client.call('resource_acquire', {
    key: 'browser:chromium',
    reason: 'cross-tool lease',
  })).result.structuredContent
  const serverOwner = serverPid.owner

  await cliTest('lease.ps1 status sees a lease created by the MCP server', () => {
    const result = runCli(['status'], sandbox.lockRoot)
    assert.equal(result.code, 0, `status exited ${result.code}: ${result.output}`)
    assert.ok(result.stdout.includes('browser:chromium'), `status output missing the key:\n${result.stdout}`)
    assert.ok(result.stdout.includes(serverOwner), `status output missing owner ${serverOwner}:\n${result.stdout}`)
    assert.ok(result.stdout.includes('exclusive'), `status output missing the mode:\n${result.stdout}`)
    // remain column renders as "<n>s" or "EXPIRED(takeable)".
    assert.ok(/\ds\b/.test(result.stdout), `status output missing the remaining time:\n${result.stdout}`)
    console.log(`        lease.ps1 status: ${result.stdout.trim().split('\n').filter((line) => line.includes('browser')).join(' | ').trim()}`)
  })

  await cliTest('lease.ps1 acquire on the same key exits 2 and names the MCP holder', () => {
    const result = runCli(['acquire', 'browser:chromium', '--ttl', '5s', '--owner', 'ps-loser', '--reason', 'should be refused'], sandbox.lockRoot)
    assert.equal(result.code, 2, `expected exit 2 (busy), got ${result.code}; output:\n${result.output}`)
    assert.ok(/Resource busy: browser:chromium/.test(result.output), `busy message missing:\n${result.output}`)
    assert.ok(result.output.includes(serverOwner), `busy message must name the MCP holder ${serverOwner}:\n${result.output}`)
    assert.ok(/ms left/.test(result.output), `busy message must carry the remaining TTL:\n${result.output}`)
    console.log(`        lease.ps1 acquire: exit ${result.code} -- ${result.stderr.trim().split('\n').find((line) => line.includes('Resource busy')).trim()}`)
  })

  await test('MCP-acquired lease keeps the CLI-compatible lock body on disk', () => {
    const meta = readLockJson(lockFileFor(sandbox.lockRoot, 'browser:chromium'))
    assert.notEqual(meta, null)
    assert.equal(meta.id, serverPid.id)
    assert.equal(meta.owner, serverOwner)
    assert.equal(meta.mode, 'exclusive')
    assert.equal(meta.slots, 1)
    assert.equal(meta.slot, 0)
    assert.equal(meta.reason, 'cross-tool lease')
    assert.equal(typeof meta.pid, 'number')
    assert.equal(typeof meta.host, 'string')
    assert.equal(meta.expiresAt - meta.createdAt, 30000)
  })

  await cliTest('a lease created by lease.ps1 appears in resource_status', async () => {
    const acquired = runCli(['acquire', 'port:9222', '--ttl', '60s', '--owner', 'ps-wins', '--reason', 'CLI owns this port'], sandbox.lockRoot)
    assert.equal(acquired.code, 0, `CLI acquire failed (${acquired.code}): ${acquired.output}`)
    const parsed = JSON.parse(acquired.stdout)
    assert.equal(parsed.owner, 'ps-wins')
    assert.equal(parsed.key, 'port:9222')

    const status = await client.call('resource_status', { key: 'port:9222' })
    const structured = status.result.structuredContent
    assert.equal(structured.count, 1)
    assert.ok(structured.text.includes('ps-wins'), `resource_status must name the CLI holder:\n${structured.text}`)
    assert.ok(structured.text.includes('CLI owns this port'), `resource_status must carry the CLI reason:\n${structured.text}`)
    assert.ok(!structured.text.includes('you'), 'a CLI lease is not "you"')
    console.log(`        resource_status: ${structured.text.split('\n').pop().trim()}`)
  })

  await cliTest('MCP acquire on a CLI-held key fails busy, naming the CLI holder', async () => {
    const response = await client.call('resource_acquire', { key: 'port:9222', reason: 'MCP wants the port' })
    assert.equal(response.result.isError, true, 'the port is held by the CLI, so this must fail')
    const text = response.result.content[0].text
    assert.ok(text.includes('ps-wins'), `busy message must name the CLI holder:\n${text}`)
    assert.ok(text.includes('CLI owns this port'), `busy message must carry the CLI reason:\n${text}`)
    assert.ok(/\ds left/.test(text), `busy message must carry the remaining time:\n${text}`)
    console.log(`        resource_acquire: ${text.trim()}`)
  })

  await cliTest('lease.ps1 release <id> releases a lease the MCP server created', async () => {
    const released = runCli(['release', serverPid.id], sandbox.lockRoot)
    assert.equal(released.code, 0, `CLI release of the MCP lease failed (${released.code}): ${released.output}`)
    assert.ok(released.stdout.includes(serverPid.id), `unexpected release output:\n${released.stdout}`)

    assert.equal(fs.existsSync(lockFileFor(sandbox.lockRoot, 'browser:chromium')), false, 'the lock file is gone')
    assert.equal(fs.existsSync(path.join(sandbox.lockRoot, '_leases', `${serverPid.id}.json`)), false, 'the index record is gone')

    const status = await client.call('resource_status', { key: 'browser:chromium' })
    assert.equal(status.result.structuredContent.count, 0, 'resource_status agrees the lease is gone')
  })

  await cliTest('lease.ps1 release --all --owner releases the CLI lease', async () => {
    const released = runCli(['release', '--all', '--owner', 'ps-wins'], sandbox.lockRoot)
    assert.equal(released.code, 0, `CLI release --all failed (${released.code}): ${released.output}`)
    assert.ok(/released=1/.test(released.stdout), `expected released=1, got:\n${released.stdout}`)

    const status = await client.call('resource_status')
    assert.equal(status.result.structuredContent.count, 0, 'no leases left')
    const cliStatus = runCli(['status'], sandbox.lockRoot)
    assert.ok(/Resource leases: none/.test(cliStatus.stdout), `CLI should see no leases:\n${cliStatus.stdout}`)
  })

  await test('key sanitization keeps both tools on the same lock file', async () => {
    // "dir:src/parser" -> dir_src_parser.lock ; "dir_src_parser" -> same file.
    const acquired = await client.call('resource_acquire', { key: 'dir:src/parser', reason: 'same file, different spelling' })
    assert.equal(acquired.result.isError, undefined)
    assert.equal(path.basename(acquired.result.structuredContent.lockPath), 'dir_src_parser.lock')
    if (cliSkipReason !== null) {
      skip('  ... the CLI half of the sanitization check', cliSkipReason)
      await client.call('resource_release', { all: true })
      return
    }

    const viaCli = runCli(['acquire', 'dir_src_parser', '--ttl', '5s', '--owner', 'ps-alias'], sandbox.lockRoot)
    assert.equal(viaCli.code, 2, `the CLI must collide on the same lock file, got exit ${viaCli.code}:\n${viaCli.output}`)
    assert.ok(/Resource busy/.test(viaCli.output))

    await client.call('resource_release', { all: true })
    const freeAgain = runCli(['acquire', 'dir_src_parser', '--ttl', '5s', '--owner', 'ps-alias'], sandbox.lockRoot)
    assert.equal(freeAgain.code, 0, `after the MCP release the CLI must succeed, got ${freeAgain.code}:\n${freeAgain.output}`)
    runCli(['release', '--all', '--owner', 'ps-alias'], sandbox.lockRoot)
  })

  await test('a mixed-case key is lowercased onto the same lock file in both tools', async () => {
    // "Browser:Chromium" and "browser:chromium" must be ONE lock. Windows would
    // hide a mismatch (case-insensitive filenames); Linux would not, and the
    // tools would stop excluding each other with no error anywhere.
    const acquired = await client.call('resource_acquire', { key: 'Browser:Chromium', reason: 'case parity' })
    assert.equal(acquired.result.isError, undefined, 'the mixed-case key must be accepted')
    const lockPath = acquired.result.structuredContent.lockPath
    assert.equal(path.basename(lockPath), 'browser_chromium.lock', `the lock file name must be lowercased, got ${path.basename(lockPath)}`)
    assert.equal(fs.existsSync(lockFileFor(sandbox.lockRoot, 'Browser:Chromium')), true)
    if (cliSkipReason !== null) {
      skip('  ... the CLI half of the mixed-case check', cliSkipReason)
      await client.call('resource_release', { all: true })
      return
    }

    const viaCli = runCli(['acquire', 'browser:chromium', '--ttl', '5s', '--owner', 'ps-case'], sandbox.lockRoot)
    assert.equal(viaCli.code, 2, `the CLI must collide on the lowercased file, got exit ${viaCli.code}:\n${viaCli.output}`)
    assert.ok(/Resource busy/.test(viaCli.output))

    await client.call('resource_release', { all: true })
    const freeAgain = runCli(['acquire', 'browser:chromium', '--ttl', '5s', '--owner', 'ps-case'], sandbox.lockRoot)
    assert.equal(freeAgain.code, 0, `after the MCP release the CLI must succeed, got ${freeAgain.code}:\n${freeAgain.output}`)
    runCli(['release', '--all', '--owner', 'ps-case'], sandbox.lockRoot)
  })

  await test('both tools resolve the same default lock root when nothing is configured', () => {
    if (cliSkipReason !== null) {
      skip('both tools resolve the same default lock root', cliSkipReason)
      return
    }
    // Not a behaviour test: a guard against the docs claiming interop while the
    // two defaults have drifted apart. Runs with DSH_RESOURCE_LOCK_ROOT unset,
    // so it reads the real default of each side (`help` creates nothing).
    const probe = runCli(['help'], null)
    assert.equal(probe.code, 0)
    assert.ok(probe.stdout.includes('Lock root:'), `CLI help should print its lock root:\n${probe.stdout}`)
    // The help line reads "Lock root: <dir>  (override with DSH_RESOURCE_LOCK_ROOT)".
    const cliDefault = probe.stdout
      .split('\n')
      .find((line) => line.includes('Lock root:'))
      .split('Lock root:')[1]
      .split('(')[0]
      .trim()
    assert.ok(cliDefault.toLowerCase().includes('dsh-resource-lease'), `unexpected CLI default: ${cliDefault}`)

    const { stdout: serverDefaultOut } = spawnSync(
      process.execPath,
      [SERVER, '--print-lock-root'],
      { env: scrubEnv(), encoding: 'utf8', timeout: 30000, windowsHide: true },
    )
    const serverDefault = serverDefaultOut.trim()
    assert.ok(serverDefault.toLowerCase().includes('dsh-resource-lease'), `unexpected server default: ${serverDefault}`)

    const normalize = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    assert.equal(normalize(cliDefault), normalize(serverDefault),
      'the CLI and the MCP server must default to the same lock root, or they silently fail to see each other')
    console.log(`        CLI default:    ${cliDefault}`)
    console.log(`        server default: ${serverDefault}`)
  })
} finally {
  await client.close()
  sandbox.dispose()
}

done()
