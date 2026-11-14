/**
 * Test harness: sandbox lock roots, an MCP stdio client, and the PowerShell
 * CLI bridge the cross-tool test needs.
 *
 * Design notes:
 *  - Every test gets its OWN temp lock root, so the real
 *    %LOCALAPPDATA%\dsh-resource-lease\locks is never touched. That is both
 *    hygiene and determinism: a stray lease on the machine must not be able
 *    to fail this suite.
 *  - The inherited DSH_* environment is scrubbed before spawning, so a
 *    developer's shell cannot change what the tests measure.
 *  - The client parses stdout strictly: a line that is not valid JSON-RPC is
 *    recorded as a failure of the "stdout stays pure" contract, not ignored.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * publish/mcp
 */
export const MCP_DIR = path.resolve(HERE, '..', '..')
/** publish/mcp/resource-lease-mcp.mjs */
export const SERVER = path.join(MCP_DIR, 'resource-lease-mcp.mjs')
/**
 * The reference CLI that ships INSIDE this package: publish/cli/lease.ps1
 * (= <publish root>/cli/lease.ps1). Resolved through MCP_DIR so a checkout of
 * the published tree always tests its own CLI; an absolute path or a path that
 * climbs out of the package would make this suite test someone else's file (and
 * fail outright for anyone who only has the package).
 */
export const CLI = path.resolve(MCP_DIR, '..', 'cli', 'lease.ps1')
/** The package root this suite may test: publish/ */
export const PACKAGE_ROOT = path.resolve(MCP_DIR, '..')

/**
 * Create an isolated lock root under the OS temp directory.
 *
 * @param {string} tag short label used in the directory name.
 * @returns {{ base: string, lockRoot: string, dispose: () => void, listLockFiles: () => string[] }} sandbox.
 */
export function createSandbox(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `rl-mcp-${tag}-`))
  const lockRoot = path.join(base, 'locks')
  fs.mkdirSync(lockRoot, { recursive: true })
  return {
    base,
    lockRoot,
    /** Delete the sandbox unless RL_KEEP=1 (handy when a test fails). */
    dispose() {
      if (process.env.RL_KEEP === '1') {
        console.log(`  (kept sandbox: ${base})`)
        return
      }
      try {
        fs.rmSync(base, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
    /** @returns {string[]} every *.lock file name currently in the lock root. */
    listLockFiles() {
      try {
        return fs.readdirSync(lockRoot).filter((name) => name.endsWith('.lock'))
      } catch {
        return []
      }
    },
  }
}

/**
 * The lock file path the CLI and this server would both compute for a key.
 *
 * Reimplemented here on purpose: the test must not import the server's own
 * helper, or a wrong sanitize rule in the server would still pass.
 *
 * @param {string} lockRoot lock directory.
 * @param {string} key resource key.
 * @param {'exclusive'|'shared'|'pool'} [mode] arbitration mode.
 * @param {number} [slot] slot index for pool mode.
 * @returns {string} lock file path.
 */
export function lockFileFor(lockRoot, key, mode = 'exclusive', slot = 0) {
  // Sanitize + lowercase, exactly as the CLI's Get-KeyBase and the server's
  // sanitizeKey do. Lowercasing is part of the rule: without it a mixed-case
  // key names a second lock file on a case-sensitive filesystem.
  const base = String(key).replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase()
  return mode === 'pool'
    ? path.join(lockRoot, `${base}.slot-${slot}.lock`)
    : path.join(lockRoot, `${base}.lock`)
}

/**
 * Read and parse a lock file, for asserting the on-disk contract.
 *
 * @param {string} lockPath lock file path.
 * @returns {Record<string, any> | null} parsed body, or null when absent.
 */
export function readLockJson(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {number} ms delay.
 * @returns {Promise<void>} resolves after the delay.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Environment keys the server reads; scrubbed so the host shell cannot interfere. */
const SCRUBBED_ENV = [
  'DSH_RESOURCE_LOCK_ROOT',
  'DSH_RESOURCE_TTL',
  'DSH_RESOURCE_MAX_WAIT',
  'DSH_AGENT_NAME',
]

/**
 * Copy process.env without the keys the server reads, then apply overrides.
 *
 * @param {Record<string, string>} [extra] values to set after scrubbing.
 * @returns {NodeJS.ProcessEnv} a clean environment.
 */
export function scrubEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of SCRUBBED_ENV) delete env[key]
  return Object.assign(env, extra)
}

/**
 * A minimal MCP client: spawns the real server and speaks newline-delimited
 * JSON-RPC 2.0 over its stdio.
 */
export class McpClient {
  /**
   * @param {{ lockRoot: string, args?: string[], env?: Record<string, string>, label?: string, useLockRootArg?: boolean }} options client options.
   */
  constructor(options) {
    this.lockRoot = options.lockRoot
    this.args = options.args ?? []
    this.env = options.env ?? {}
    this.label = options.label ?? 'client'
    this.useLockRootArg = options.useLockRootArg !== false
    this.pending = new Map()
    this.nextId = 0
    this.stdoutLines = []
    this.badLines = []
    this.unsolicited = []
    this.stderr = ''
    this.exit = null
    this.buffer = ''
    this.child = null
  }

  /** Spawn the server process. */
  start() {
    const env = scrubEnv(this.env)

    const argv = [SERVER]
    if (this.useLockRootArg) argv.push('--lock-root', this.lockRoot)
    argv.push(...this.args)

    this.child = spawn(process.execPath, argv, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk
    })
    this.child.on('exit', (code, signal) => {
      this.exit = { code, signal }
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`server ${this.label} exited (code=${code}, signal=${signal}) before replying`))
      }
      this.pending.clear()
    })
    return this
  }

  /**
   * Split stdout into lines and route each parsed message.
   *
   * @param {string} chunk stdout text.
   */
  onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim() === '') continue
      this.stdoutLines.push(line)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.badLines.push(line)
        continue
      }
      const pending = this.pending.get(message.id)
      if (pending !== undefined) {
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        pending.resolve(message)
      } else {
        this.unsolicited.push(message)
      }
    }
  }

  /**
   * Write one JSON-RPC frame.
   *
   * @param {Record<string, any>} frame message to send.
   * @returns {boolean} true when written.
   */
  write(frame) {
    return this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  /**
   * Send a request and wait for the matching response.
   *
   * @param {string} method JSON-RPC method.
   * @param {Record<string, any>} [params] request params.
   * @param {number} [timeoutMs] how long to wait.
   * @returns {Promise<Record<string, any>>} the full response message.
   */
  request(method, params, timeoutMs = 30000) {
    this.nextId += 1
    const id = this.nextId
    const frame = { jsonrpc: '2.0', id, method }
    if (params !== undefined) frame.params = params
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method} (${this.label})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write(frame)
    })
  }

  /**
   * Send a request without awaiting it. Writing several of these in one tick
   * is how the mutex test gets real simultaneity.
   *
   * @param {string} method JSON-RPC method.
   * @param {Record<string, any>} [params] request params.
   * @param {number} [timeoutMs] how long to wait.
   * @returns {Promise<Record<string, any>>} the full response message.
   */
  send(method, params, timeoutMs = 30000) {
    return this.request(method, params, timeoutMs)
  }

  /**
   * Send a notification (no id, no response expected).
   *
   * @param {string} method JSON-RPC method.
   * @param {Record<string, any>} [params] notification params.
   */
  notify(method, params) {
    const frame = { jsonrpc: '2.0', method }
    if (params !== undefined) frame.params = params
    this.write(frame)
  }

  /**
   * Write a raw line, for malformed-input tests.
   *
   * @param {string} line text to write verbatim.
   */
  writeRaw(line) {
    this.child.stdin.write(line + '\n')
  }

  /**
   * Run the standard handshake.
   *
   * @param {string} [protocolVersion] version to request.
   * @returns {Promise<Record<string, any>>} the initialize response.
   */
  async initialize(protocolVersion = '2025-06-18') {
    const response = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: `rl-test-${this.label}`, version: '0.0.0' },
    })
    this.notify('notifications/initialized')
    return response
  }

  /**
   * Call a tool and return the JSON-RPC response.
   *
   * @param {string} name tool name.
   * @param {Record<string, any>} [args] tool arguments.
   * @param {number} [timeoutMs] how long to wait.
   * @returns {Promise<Record<string, any>>} response.
   */
  call(name, args = {}, timeoutMs = 30000) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs)
  }

  /**
   * Assert that no response arrives for `ms` (used for notifications).
   *
   * @param {number} ms quiet window.
   * @returns {Promise<void>} resolves after the window.
   */
  async expectSilence(ms) {
    const before = this.stdoutLines.length
    await sleep(ms)
    if (this.stdoutLines.length !== before) {
      throw new Error(`${this.label} produced ${this.stdoutLines.length - before} message(s) where silence was required`)
    }
  }

  /** Close stdin and wait for the process to exit. */
  async close() {
    if (this.child === null) return
    if (this.exit !== null) return
    try {
      this.child.stdin.end()
    } catch {
      /* already closed */
    }
    const exited = await Promise.race([
      new Promise((resolve) => this.child.once('exit', () => resolve(true))),
      sleep(5000).then(() => false),
    ])
    if (!exited) {
      this.child.kill('SIGKILL')
      await sleep(200)
    }
  }
}

/**
 * Concurrency helper: run several clients against the same sandbox.
 *
 * @param {number} count how many clients.
 * @param {string} lockRoot lock directory they share.
 * @param {string} [tag] label prefix.
 * @returns {Promise<McpClient[]>} started and initialized clients.
 */
export async function startClients(count, lockRoot, tag = 'c') {
  const clients = []
  for (let i = 0; i < count; i += 1) {
    clients.push(new McpClient({ lockRoot, label: `${tag}${i}` }).start())
  }
  await Promise.all(clients.map((client) => client.initialize()))
  return clients
}

/** Cached PowerShell descriptor. */
let powerShellCache = null

/**
 * Find a usable PowerShell host.
 *
 * The reference CLI is `#Requires -Version 5.1`, so Windows PowerShell is
 * enough; pwsh is preferred when present because its JSON output is the same
 * but its startup is faster.
 *
 * @returns {{ cmd: string, version: string }} the host to use.
 */
export function detectPowerShell() {
  if (powerShellCache !== null) return powerShellCache

  const candidates = []
  if (typeof process.env.DSH_PWSH === 'string' && process.env.DSH_PWSH.trim() !== '') {
    candidates.push(process.env.DSH_PWSH.trim())
  }
  candidates.push('pwsh', 'pwsh.exe', 'powershell.exe', 'powershell')
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }

  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    })
    if (probe.status === 0) {
      powerShellCache = { cmd, version: String(probe.stdout).trim() }
      return powerShellCache
    }
  }
  throw new Error('no PowerShell host found (tried pwsh, powershell.exe); the cross-tool test needs one')
}

/**
 * Run the reference CLI against a sandbox lock root.
 *
 * @param {string[]} args CLI arguments, e.g. ['status'].
 * @param {string | null} lockRoot sandbox lock directory, or null to leave
 *   DSH_RESOURCE_LOCK_ROOT unset so the CLI's own default resolution is
 *   exercised (reading it is harmless: `help` creates nothing).
 * @returns {{ code: number | null, stdout: string, stderr: string, output: string }} result.
 */
export function runCli(args, lockRoot) {
  if (!fs.existsSync(CLI)) {
    throw new Error(
      `the reference CLI is missing: ${CLI}\n` +
        'It ships with this package as <package>/cli/lease.ps1. Without it the cross-tool checks cannot run; ' +
        'they must be SKIPPED explicitly, never faked against some other copy.',
    )
  }
  const ps = detectPowerShell()
  const env = { ...process.env }
  delete env.DSH_AGENT_NAME
  if (lockRoot === null) {
    delete env.DSH_RESOURCE_LOCK_ROOT
  } else {
    env.DSH_RESOURCE_LOCK_ROOT = lockRoot
  }
  const result = spawnSync(
    ps.cmd,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLI, ...args],
    { env, encoding: 'utf8', timeout: 60000, windowsHide: true },
  )
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { code: result.status, stdout, stderr, output: `${stdout}${stderr}` }
}
