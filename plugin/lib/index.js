/**
 * dsh-resource-lease -- Host plugin.
 *
 * Arbitrates exclusive machine resources (browsers, fixed ports, screen
 * focus, shared write targets) between agents that may be running in
 * different sessions, different processes, or even different harness
 * instances -- and between agents and the zero-dependency CLI
 * (`cli/lease.ps1`), because both sides use the same lock files.
 *
 * Host-only: no Client half, no Web UI, no build step, and -- importantly --
 * no bare-specifier imports outside this directory. See "Self-containment"
 * below.
 *
 * What it contributes:
 *   1. a `resources` Host service: lease / release / releaseAll / list
 *   2. three model-facing tools: resource_acquire / resource_release /
 *      resource_status
 *   3. runtime context injected into every step, listing live leases and the
 *      leases the calling agent holds -- and NOTHING when no lease is live
 *   4. a synchronous tools guard that denies protected tools until the caller
 *      holds the mapped resource
 *   5. automatic release when an agent is disposed, and when the plugin
 *      unloads
 *
 * Self-containment (why nothing is imported from `@deepseek-ai/*`):
 *   `install_bundle` installs a local package directory as a SYMLINK, and Node
 *   resolves bare specifiers from the symlink's REAL path -- i.e. from this
 *   workspace directory, not from the profile's node_modules and not from the
 *   dsh installation inside app.asar. A static import of `@deepseek-ai/*`
 *   therefore fails with ERR_MODULE_NOT_FOUND, and a dynamic `import()` fails
 *   the same way. This module imports only `node:` builtins and its own
 *   sibling `./lock.js`, so it loads wherever the directory is linked.
 *
 *   The one thing this costs is `defineTool` from `@deepseek-ai/dsh-tools`,
 *   which is reimplemented below. Its real implementation (read from the
 *   installed package) does three things: compile the author-facing parameter
 *   shorthand into a raw JSON Schema, compile `output.schema` the same way,
 *   and wrap `execute` with argument validation that throws `ToolArgsError`.
 *   The port below emits the same raw schemas directly and keeps a smaller,
 *   explicit validation step; it does not reproduce the argument-schema walk.
 */

import os from 'node:os'
import * as lock from './lock.js'

const MODES = ['exclusive', 'shared', 'pool']
const ON_TIMEOUT = ['fail', 'queue', 'steal']

/**
 * Hard dependencies: without the tool registry and the prompt registry this
 * plugin has nothing to contribute, so it stays inactive instead of throwing.
 */
export const inject = ['tools', 'systemPrompt']

/** Placement of our runtime context among the assembled prompt contexts. */
const CONTEXT_ORDER = 125
/** Prompt context name; also the registry key that scoped entries shadow. */
const CONTEXT_NAME = 'resource-lease'

/**
 * No `Config` export on purpose.
 *
 * A Config schema in this harness is a schemastery `Schema`, and schemastery
 * is a bare `@deepseek-ai/*` specifier that a symlink-installed plugin cannot
 * resolve (see "Self-containment" above). Publishing a look-alike object
 * instead would risk the Loader rejecting the plugin at activation, and the
 * priority here is that the `config:` block in `cordis.patch.yml` actually
 * reaches `apply()`.
 *
 * With no `Config`, the Loader passes the row's config through unvalidated,
 * and normalizeConfig() below applies every default, coerces every value, and
 * falls back safely on anything unrecognized. The documented contract for
 * users is README.md and the commented block in cordis.patch.yml.
 */

/**
 * Compile a compact property map into a raw JSON Schema object node.
 *
 * This mirrors what `defineTool`'s `parameterSchemaSpecToJsonSchema` produces
 * for the implicit parameter root: an object node whose properties are the
 * given value nodes, plus a `required` array collected from the properties
 * marked `required: true`. Only the keys in the harness's supported schema
 * subset are ever emitted (`type`, `properties`, `required`, `items`, `enum`,
 * `const`, `description`, `additionalProperties`), because `tools.register`
 * runs `assertSupportedJsonSchema` on the result and would reject anything
 * else.
 *
 * @param {Record<string, { type: string, required?: boolean, description?: string, enum?: Array<string | number | boolean | null> }>} properties property name -> value node.
 * @returns {{ type: 'object', properties: Record<string, any>, required?: string[] }} raw object schema.
 */
function parameterSchema(properties) {
  const compiled = {}
  const required = []
  for (const [name, node] of Object.entries(properties)) {
    const value = { type: node.type }
    if (node.description !== undefined) value.description = node.description
    if (Array.isArray(node.enum)) value.enum = [...node.enum]
    compiled[name] = value
    if (node.required === true) required.push(name)
  }
  const schema = { type: 'object', properties: compiled }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * Compile an output property map into a closed raw JSON Schema object node.
 *
 * Output schemas are closed (`additionalProperties: false`) because the value
 * is produced by this plugin, not by the model, so an unexpected field is a
 * bug worth surfacing rather than accepting.
 *
 * @param {Parameters<typeof parameterSchema>[0]} properties property name -> value node.
 * @returns {{ type: 'object', properties: Record<string, any>, required?: string[], additionalProperties: false }} raw object schema.
 */
function outputSchema(properties) {
  return { ...parameterSchema(properties), additionalProperties: false }
}

/**
 * Minimal stand-in for `@deepseek-ai/dsh-tools`' `defineTool`.
 *
 * The real helper compiles the author shorthand above into raw JSON Schema and
 * wraps `execute` with argument validation that throws `ToolArgsError`. The
 * registry only consumes the finished definition (`register` checks that
 * `output` has a `schema` and a `render` function, then runs
 * `assertSupportedJsonSchema` on both schemas), so emitting the raw schemas
 * directly is equivalent at runtime.
 *
 * What this port deliberately does NOT reproduce: `defineTool`'s
 * schema-walk argument validation. Each `execute` below therefore validates
 * the handful of fields it actually depends on and throws a message the model
 * can act on, which is the same outcome for a caller.
 *
 * @param {{ name: string, description: string, parameters: Parameters<typeof parameterSchema>[0], output: { schema: Record<string, any>, render: (args: unknown, value: any) => Array<{ type: 'text', text: string }> }, execute: (args: any, exec: any) => Promise<any> }} options tool definition in the author shorthand.
 * @returns {Record<string, any>} a registry-ready ToolDefinition.
 */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: parameterSchema(options.parameters),
    output: {
      schema: options.output.schema,
      render: options.output.render,
    },
    execute: options.execute,
  }
}

/**
 * Merge the row config with built-in defaults.
 *
 * Written independently of the Config schema on purpose: the schema is the
 * user-facing contract, this is what the code actually runs on.
 *
 * @param {unknown} raw the Loader row's config.
 * @returns {{ enabled: boolean, lockRoot: string, defaultTtlMs: number, maxWaitMs: number, onTimeout: string, resources: Record<string, { mode: string, slots: number }>, protectedTools: Record<string, string> }} resolved config.
 */
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}

  const resources = {}
  if (c.resources && typeof c.resources === 'object' && !Array.isArray(c.resources)) {
    for (const [key, spec] of Object.entries(c.resources)) {
      if (!spec || typeof spec !== 'object') continue
      const mode = MODES.includes(spec.mode) ? spec.mode : 'exclusive'
      const slots = Number.isFinite(spec.slots) && spec.slots >= 1 ? Math.trunc(spec.slots) : 1
      resources[key] = { mode, slots }
    }
  }

  const protectedTools = {}
  if (c.protectedTools && typeof c.protectedTools === 'object' && !Array.isArray(c.protectedTools)) {
    for (const [tool, key] of Object.entries(c.protectedTools)) {
      if (typeof key === 'string' && key.trim() !== '') protectedTools[tool] = key.trim()
    }
  }

  // The CLI honours DSH_RESOURCE_TTL; only let it through when the row does
  // not set defaultTtlMs, so explicit configuration always wins.
  const ttlFromEnv = c.defaultTtlMs === undefined ? lock.toMs(process.env.DSH_RESOURCE_TTL, undefined) : undefined
  const defaultTtlMs = Number.isFinite(c.defaultTtlMs) && c.defaultTtlMs >= 1000
    ? Math.trunc(c.defaultTtlMs)
    : Number.isFinite(ttlFromEnv) && ttlFromEnv >= 1000
      ? ttlFromEnv
      : 30000

  const maxWaitMs = Number.isFinite(c.maxWaitMs) && c.maxWaitMs >= 0 ? Math.trunc(c.maxWaitMs) : 120000

  return {
    enabled: c.enabled !== false,
    lockRoot: typeof c.lockRoot === 'string' && c.lockRoot.trim() !== '' ? c.lockRoot.trim() : lock.defaultLockRoot(),
    defaultTtlMs,
    maxWaitMs,
    onTimeout: ON_TIMEOUT.includes(c.onTimeout) ? c.onTimeout : 'fail',
    resources,
    protectedTools,
  }
}

/**
 * Identify the agent behind a tool call or a prompt assembly.
 *
 * `agent.session.id` is the session id (what the tool runtime exposes as
 * `exec.agent.session.id`); `agent.id` is the same value on hosts that expose
 * it flat. Leases are keyed by this string, which is what makes "my leases"
 * and "someone else's leases" distinguishable.
 *
 * @param {unknown} agent an Agent, or a prompt assembly scope.
 * @returns {string | undefined} stable agent key, or undefined when unknown.
 */
function agentKey(agent) {
  if (!agent || typeof agent !== 'object') return undefined
  const session = /** @type {any} */ (agent).session
  const sessionId = session && typeof session === 'object' ? session.id : undefined
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId
  const id = /** @type {any} */ (agent).id
  if (typeof id === 'string' && id !== '') return id
  return undefined
}

/** @returns {string} this process's fallback owner name. */
function processOwner() {
  return `pid:${process.pid}`
}

/**
 * Render one lease as a compact phrase, e.g. `pool slot 2/4, 12s left`.
 *
 * @param {Record<string, any>} meta lease metadata.
 * @param {number} now current epoch ms.
 * @returns {string} one-line description.
 */
function describeLease(meta, now) {
  const parts = []
  parts.push(meta.mode === 'pool' ? `pool slot ${Number(meta.slot) + 1}/${Number(meta.slots)}` : String(meta.mode ?? 'exclusive'))
  const remaining = Number(meta.expiresAt) - now
  parts.push(remaining > 0 ? `${Math.ceil(remaining / 1000)}s left` : 'expired, takeable')
  return parts.join(', ')
}

/** @param {string} tool tool name. @returns {string} a logger, never throwing. */
function makeLogger(ctx) {
  try {
    const factory = /** @type {any} */ (ctx)?.logger
    if (typeof factory === 'function') {
      const logger = factory('dsh-resource-lease')
      if (logger && typeof logger.warn === 'function') return logger
    }
  } catch {
    /* logging must never break the plugin */
  }
  const fallback = (level) => (...args) => {
    try {
      if (level === 'warn') console.warn('[dsh-resource-lease]', ...args)
    } catch {
      /* no console, no problem */
    }
  }
  return { warn: fallback('warn'), info: () => {}, debug: () => {} }
}

/** @param {number} ms delay. @returns {Promise<void>} resolves after the delay. */
function sleep(ms) {
  // Deliberately not unref'd: a wait that is the only pending work must still
  // finish, otherwise an acquire could stall the caller forever.
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build the model-facing text for a tool result.
 *
 * @param {(value: any) => string} fn value projector.
 * @returns {(args: unknown, value: any) => Array<{ type: 'text', text: string }>} render function.
 */
function textRender(fn) {
  return (_args, value) => [{ type: 'text', text: fn(value) }]
}

/**
 * Register the resource lease service, tools, prompt context, guard, and
 * per-agent cleanup.
 *
 * @param {any} ctx the plugin's Cordis context.
 * @param {unknown} config the Loader row's config.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) return

  const log = makeLogger(ctx)
  /** Leases this process holds: lease id -> metadata. */
  const held = new Map()
  /** Disposers registered on agent contexts, so plugin unload removes them. */
  const agentCleanups = new Set()

  // ---------------------------------------------------------------- state

  /**
   * Every readable, unexpired lock in the shared lock root -- including the
   * ones held by the CLI and by other harness instances.
   *
   * @returns {Array<Record<string, any>>} live leases.
   */
  function liveLeases() {
    const now = Date.now()
    return lock.listLocks(cfg.lockRoot).filter((meta) => !lock.isExpired(meta, now))
  }

  /**
   * Whether `owner` currently holds `key`.
   *
   * @param {string} owner owner name.
   * @param {string} key resource key.
   * @returns {boolean} true when a live lease matches.
   */
  function holds(owner, key) {
    const now = Date.now()
    return lock
      .listLocks(cfg.lockRoot)
      .some((meta) => meta.owner === owner && meta.key === key && !lock.isExpired(meta, now))
  }

  /**
   * Forget a lease in memory (does not touch disk).
   *
   * @param {string} id lease id.
   */
  function forget(id) {
    const meta = held.get(id)
    if (meta === undefined) return
    held.delete(id)
  }

  /**
   * Log why a release did not delete a lock file the caller believed it held.
   *
   * @param {string} id lease id being released.
   * @param {string | null} onDiskId id actually recorded in the lock file.
   */
  function logNotOurs(id, onDiskId) {
    if (onDiskId === null) {
      log.warn(`lease ${id}: its lock file is already gone; dropped the stale local record`)
      return
    }
    log.warn(`lease ${id} was taken over by ${onDiskId}; left the new holder's lock file in place`)
  }

  /**
   * Release one lease: delete its lock file and its index record.
   *
   * The lock file is authoritative. After a takeover the SAME path holds the
   * NEW holder's lease, so the delete is guarded by an id comparison
   * (lock.removeIfOwned) -- releasing by path alone would delete a live lock
   * that belongs to someone else. When the ids disagree, nothing is deleted:
   * the stale local record is dropped and the mismatch is logged, which is the
   * same semantics as the MCP server's releaseById().
   *
   * @param {string} id lease id.
   * @returns {boolean} true when this process's lock file was actually removed.
   */
  function releaseOne(id) {
    if (typeof id !== 'string' || id === '') return false

    const meta = held.get(id)
    if (meta !== undefined) {
      // A lease recorded in memory is still only releasable by the process
      // that created it.
      if (Number(meta.pid) !== process.pid) return false
      const result = lock.removeIfOwned(meta.lockPath, id)
      lock.removeIndex(cfg.lockRoot, id)
      forget(id)
      if (!result.removed) logNotOurs(id, result.onDiskId)
      return result.removed
    }
    // Not in memory: the plugin may have been reloaded while holding it, so
    // fall back to the shared index -- but only for this process's own leases.
    const record = lock.readIndex(cfg.lockRoot, id)
    if (record === null) return false
    const lockPath = typeof record.path === 'string' ? record.path : ''
    if (lockPath === '') return false
    const onDisk = lock.readMeta(lockPath)
    const ownedHere = onDisk !== null && Number(onDisk.pid) === process.pid
    if (!ownedHere) return false
    const result = lock.removeIfOwned(lockPath, id)
    lock.removeIndex(cfg.lockRoot, id)
    if (!result.removed) logNotOurs(id, result.onDiskId)
    return result.removed
  }

  // -------------------------------------------------------------- acquire

  /**
   * Try to take one lease without waiting.
   *
   * @param {{ key: string, mode: string, slots: number, ttlMs: number, owner: string, reason: string, force?: boolean }} spec what to take.
   * @returns {Record<string, any> | null} the lease, or null when busy.
   */
  function attempt(spec) {
    for (let slot = 0; slot < spec.slots; slot += 1) {
      // Two passes per slot: the first fails because the file exists, the
      // second runs after an expired holder was moved aside.
      for (let pass = 0; pass < 2; pass += 1) {
        const lockPath = lock.lockPathFor(cfg.lockRoot, spec.key, spec.mode, slot)
        const createdAt = Date.now()
        const meta = {
          id: lock.newLeaseId(),
          key: spec.key,
          mode: spec.mode,
          slots: spec.slots,
          slot,
          owner: spec.owner,
          reason: spec.reason,
          pid: process.pid,
          host: os.hostname(),
          createdAt,
          expiresAt: createdAt + spec.ttlMs,
          lockPath,
        }
        if (lock.tryAcquire(lockPath, meta)) {
          lock.registerIndex(cfg.lockRoot, meta)
          held.set(meta.id, meta)
          return meta
        }
        const moved = spec.force === true
          ? lock.forceTakeover(lockPath, createdAt, process.pid)
          : lock.tryTakeover(lockPath, createdAt, process.pid, (message) => log.warn(message))
        if (!moved) break
      }
    }
    return null
  }

  /**
   * Describe who is blocking a key, for the busy error.
   *
   * @param {string} key resource key.
   * @param {string} mode arbitration mode.
   * @param {number} slots slot count.
   * @returns {string} human-readable holder list.
   */
  function describeHolders(key, mode, slots) {
    const now = Date.now()
    const holders = []
    for (let slot = 0; slot < slots; slot += 1) {
      const meta = lock.readMeta(lock.lockPathFor(cfg.lockRoot, key, mode, slot))
      if (meta === null) continue
      const reason = meta.reason ? `, reason: ${meta.reason}` : ''
      holders.push(`${meta.owner ?? 'unknown'} (${describeLease(meta, now)}${reason})`)
    }
    return holders.length > 0 ? holders.join('; ') : 'an unidentified holder'
  }

  /**
   * Acquire a lease, waiting up to `waitMs` for a busy resource.
   *
   * @param {{ key?: string, mode?: string, slots?: number, ttlMs?: number | string, waitMs?: number | string, reason?: string, owner?: string }} [req] lease request.
   * @returns {Promise<Record<string, any>>} the acquired lease.
   */
  async function lease(req = {}) {
    const key = typeof req.key === 'string' ? req.key.trim() : ''
    if (key === '') throw new Error('resource lease: "key" is required, e.g. "browser:chromium"')

    // defineTool's argument-schema validation is not available to a
    // self-contained plugin, so the fields the caller can get wrong are
    // rejected here with a message the model can act on instead of being
    // silently coerced.
    if (req.mode !== undefined && req.mode !== null && !MODES.includes(req.mode)) {
      throw new Error(`resource lease: mode must be one of ${MODES.join(', ')} (got ${JSON.stringify(req.mode)})`)
    }
    if (req.slots !== undefined && req.slots !== null && (!Number.isFinite(Number(req.slots)) || Number(req.slots) < 1)) {
      throw new Error(`resource lease: slots must be a positive whole number (got ${JSON.stringify(req.slots)})`)
    }

    const mapped = cfg.resources[key]
    const mode = MODES.includes(req.mode) ? req.mode : mapped?.mode ?? 'exclusive'
    const slots = mode === 'pool'
      ? Math.max(1, Math.trunc(Number.isFinite(req.slots) ? req.slots : mapped?.slots ?? 1))
      : 1
    const ttlMs = Math.max(1000, lock.toMs(req.ttlMs, cfg.defaultTtlMs))
    const waitMs = Math.min(cfg.maxWaitMs, lock.toMs(req.waitMs, 0))
    const owner = typeof req.owner === 'string' && req.owner !== '' ? req.owner : processOwner()
    const reason = typeof req.reason === 'string' ? req.reason : ''
    const spec = { key, mode, slots, ttlMs, owner, reason }

    lock.ensureLockRoot(cfg.lockRoot)
    const deadline = Date.now() + waitMs

    for (;;) {
      const acquired = attempt(spec)
      if (acquired !== null) return acquired

      if (Date.now() >= deadline) {
        if (cfg.onTimeout === 'queue') {
          await sleep(150)
          continue
        }
        if (cfg.onTimeout === 'steal') {
          const stolen = attempt({ ...spec, force: true })
          if (stolen !== null) return stolen
        }
        const error = new Error(
          `Resource busy: ${key} - held by ${describeHolders(key, mode, slots)}. `
          + 'Wait for the holder to release it (or let its TTL expire), then acquire again.',
        )
        error.code = 'RESOURCE_BUSY'
        throw error
      }
      await sleep(150)
    }
  }

  // -------------------------------------------------------------- release

  /**
   * Release one lease held by this process.
   *
   * @param {string} id lease id.
   * @returns {boolean} true when it was released.
   */
  function release(id) {
    if (typeof id !== 'string' || id === '') return false
    return releaseOne(id)
  }

  /**
   * Release every lease held by one owner (or by this process when the owner
   * is omitted).
   *
   * @param {string} [owner] owner name.
   * @returns {number} number of leases released.
   */
  function releaseAll(owner) {
    const targets = []
    for (const [id, meta] of held) {
      if (owner === undefined || meta.owner === owner) targets.push(id)
    }
    // Also catch leases this process acquired before a plugin reload, which
    // are no longer in the in-memory map but are still recorded on disk.
    for (const record of lock.listIndex(cfg.lockRoot)) {
      if (typeof record.id !== 'string' || targets.includes(record.id)) continue
      const lockPath = typeof record.path === 'string' ? record.path : ''
      if (lockPath === '') continue
      const meta = lock.readMeta(lockPath)
      if (meta === null) continue
      if (Number(meta.pid) !== process.pid) continue
      if (owner !== undefined && meta.owner !== owner) continue
      targets.push(record.id)
    }
    let released = 0
    for (const id of targets) {
      if (releaseOne(id)) released += 1
    }
    return released
  }

  // ----------------------------------------------------------------- list

  /**
   * List every live lease in the lock root, oldest expiry last.
   *
   * @param {{ includeExpired?: boolean }} [options] listing options.
   * @returns {Array<Record<string, any>>} leases with derived fields.
   */
  function list(options = {}) {
    const now = Date.now()
    const rows = []
    for (const meta of lock.listLocks(cfg.lockRoot)) {
      const expired = lock.isExpired(meta, now)
      if (expired && options.includeExpired !== true) continue
      rows.push({
        id: meta.id,
        key: meta.key,
        mode: meta.mode,
        slot: meta.slot,
        slots: meta.slots,
        owner: meta.owner,
        reason: meta.reason,
        pid: meta.pid,
        host: meta.host,
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        lockPath: meta.lockPath,
        expired,
        remainingMs: Math.max(0, Number(meta.expiresAt) - now),
        mine: held.has(meta.id),
      })
    }
    rows.sort((a, b) => String(a.key).localeCompare(String(b.key)) || Number(a.slot) - Number(b.slot))
    return rows
  }

  // ---------------------------------------------------------- 1. service

  const service = {
    lease,
    release,
    releaseAll,
    list,
    /** The resolved lock root, so callers can point the CLI at the same place. */
    lockRoot: cfg.lockRoot,
    /** The resolved configuration (read-only). */
    config: cfg,
  }

  ctx.effect(() => {
    try {
      if (ctx.get('resources', false) === undefined) ctx.set('resources', service)
      else log.warn('a "resources" service already exists; the lease service is available through its tools only')
    } catch (error) {
      log.warn('could not register the "resources" service:', error instanceof Error ? error.message : error)
    }
    return () => {
      try {
        ctx.set('resources', undefined)
      } catch {
        /* the context may already be torn down */
      }
    }
  }, 'dsh-resource-lease: resources service')

  // ------------------------------------------------------------ 2. tools

  /** Owner used for the current tool call: the calling agent's session id. */
  function ownerOf(exec) {
    return agentKey(/** @type {any} */ (exec)?.agent) ?? processOwner()
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'resource_acquire',
    description: 'Take a lease on a machine resource BEFORE using it. Use this whenever the work touches something only one agent may touch at a time: a browser, Playwright/Chromium instance or its user-data-dir; a fixed port (dev server, debug port, WebSocket); screen or input focus (driving the real desktop, taking desktop screenshots, sending keystrokes); or a shared write target (a directory, repository, or output folder other agents also write to). Leases are files under a lock root shared with the resource-lease CLI, so agents using the CLI and agents using this plugin exclude each other. Acquire, do the work, then call resource_release; the lease also expires by TTL, so a crashed holder cannot block a resource forever. The owner is set to the calling agent automatically. If the resource is busy the error names the current holder, its reason, and the remaining time.',
    parameters: {
      key: {
        type: 'string',
        required: true,
        description: 'Resource key, category:specific. Examples: "browser:chromium", "browser:profile:main", "port:9222", "screen:focus", "dir:src/parser", "repo:root". Keys are sanitized to [A-Za-z0-9._-] for the lock filename, so "browser:chromium" and "browser_chromium" are the same resource.',
      },
      reason: {
        type: 'string',
        required: true,
        description: 'Short phrase telling other agents what you are about to do with the resource, e.g. "capture checkout screenshots". It is shown to them while you hold the lease, so keep it accurate and specific.',
      },
      mode: {
        type: 'string',
        description: 'Arbitration mode: "exclusive" (one holder, the default), "shared" (declares read-only intent; still one holder on disk, exactly like the CLI), or "pool" (one holder per slot). Omit to use the mode configured for this key.',
      },
      slots: {
        type: 'number',
        description: 'Concurrent holders for mode "pool" (default 1). Ignored by the other modes. All agents must agree on this number for a key: it decides how many slot files exist.',
      },
      ttlMs: {
        type: 'number',
        description: 'Lease lifetime in milliseconds (default from configuration, usually 30000). Also accepts "30s" / "2m" / "1h". A lease that is not released expires and becomes takeable, so this is your crash protection: keep it comfortably longer than the work.',
      },
      waitMs: {
        type: 'number',
        description: 'How long to wait for a busy resource before giving up, in milliseconds (default 0 = fail immediately). Also accepts "30s" / "2m".',
      },
    },
    output: {
      schema: outputSchema({
        id: { type: 'string', required: true, description: 'Lease id to pass to resource_release.' },
        key: { type: 'string', required: true, description: 'The resource key that was leased.' },
        mode: { type: 'string', required: true, description: 'Mode that was used.' },
        slot: { type: 'number', required: true, description: 'Zero-based slot index; meaningful for mode "pool".' },
        slots: { type: 'number', required: true, description: 'Total slots in the pool.' },
        owner: { type: 'string', required: true, description: 'Owner recorded on the lease (the calling agent).' },
        reason: { type: 'string', required: true, description: 'Reason recorded on the lease.' },
        expiresAt: { type: 'number', required: true, description: 'Epoch milliseconds at which the lease expires on its own.' },
        ttlMs: { type: 'number', required: true, description: 'Effective lease lifetime in milliseconds.' },
        waitedMs: { type: 'number', required: true, description: 'How long the acquire waited before succeeding.' },
        lockPath: { type: 'string', required: true, description: 'The lock file that holds this lease.' },
      }),
      render: textRender((v) => {
        const pool = v.mode === 'pool' ? ` slot ${Number(v.slot) + 1}/${Number(v.slots)}` : ''
        return `Lease ${v.id} acquired on "${v.key}" (${v.mode}${pool}), owner ${v.owner}, expires in ${Math.round(Number(v.ttlMs) / 1000)}s. Call resource_release with id="${v.id}" when the work is done.`
      }),
    },
    execute: async (args, exec) => {
      const started = Date.now()
      const meta = await lease({
        key: args.key,
        mode: args.mode,
        slots: args.slots,
        ttlMs: args.ttlMs,
        waitMs: args.waitMs,
        reason: args.reason,
        owner: ownerOf(exec),
      })
      return {
        id: String(meta.id),
        key: String(meta.key),
        mode: String(meta.mode),
        slot: Number(meta.slot),
        slots: Number(meta.slots),
        owner: String(meta.owner ?? ''),
        reason: String(meta.reason ?? ''),
        expiresAt: Number(meta.expiresAt),
        ttlMs: Number(meta.expiresAt) - Number(meta.createdAt),
        waitedMs: Date.now() - started,
        lockPath: String(meta.lockPath ?? ''),
      }
    },
  })), 'dsh-resource-lease: tool resource_acquire')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'resource_release',
    description: 'Release a resource lease you hold, so another agent can use the resource now instead of waiting for your TTL to expire. Call it as soon as the work that needed the resource is done, including on the failure path: a lease you leave behind blocks other agents until it expires. Pass "id" for one lease, "key" to release every lease you hold on that resource, or "all" to release everything you hold. Leases are also released automatically when your agent is disposed.',
    parameters: {
      id: {
        type: 'string',
        description: 'Lease id returned by resource_acquire. Releases exactly that lease.',
      },
      key: {
        type: 'string',
        description: 'Resource key. Releases every lease you hold on that resource.',
      },
      all: {
        type: 'boolean',
        description: 'Release every lease you hold, on every resource.',
      },
    },
    output: {
      schema: outputSchema({
        released: { type: 'number', required: true, description: 'Number of leases released.' },
        ids: { type: 'string', required: true, description: 'Comma-separated ids that were released (empty when none).' },
        text: { type: 'string', required: true, description: 'Human-readable summary.' },
      }),
      render: textRender((v) => v.text),
    },
    execute: async (args, exec) => {
      const owner = ownerOf(exec)
      const released = []
      if (args.all === true) {
        for (const meta of [...held.values()]) {
          if (meta.owner === owner && releaseOne(meta.id)) released.push(meta.id)
        }
      } else if (typeof args.id === 'string' && args.id !== '') {
        const meta = held.get(args.id)
        if (meta === undefined) {
          throw new Error(`No lease "${args.id}" is held by this agent. Call resource_status to see the leases that exist; a lease held by another agent cannot be released here.`)
        }
        if (meta.owner !== owner) {
          throw new Error(`Lease "${args.id}" belongs to owner "${meta.owner}", not to you. You can only release leases you hold.`)
        }
        if (releaseOne(args.id)) released.push(args.id)
      } else if (typeof args.key === 'string' && args.key !== '') {
        for (const meta of [...held.values()]) {
          if (meta.owner === owner && meta.key === args.key && releaseOne(meta.id)) released.push(meta.id)
        }
      } else {
        throw new Error('Nothing to release: pass "id", "key", or all=true.')
      }
      const text = released.length === 0
        ? 'No leases released: this agent holds no matching lease.'
        : `Released ${released.length} lease${released.length === 1 ? '' : 's'}: ${released.join(', ')}.`
      return { released: released.length, ids: released.join(','), text }
    },
  })), 'dsh-resource-lease: tool resource_release')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'resource_status',
    description: 'List the resource leases that are live right now, including the ones other agents and the resource-lease CLI hold. Use it before planning work that needs a scarce resource (to see whether a browser, port, or write target is free), and when an acquire reports the resource is busy (to see who holds it, why, and how long it will keep it). Leases held by you are marked; expired leases are hidden unless includeExpired is set.',
    parameters: {
      key: {
        type: 'string',
        description: 'Only show leases for this resource key.',
      },
      includeExpired: {
        type: 'boolean',
        description: 'Also show expired leases that are already takeable but whose lock file still exists.',
      },
    },
    output: {
      schema: outputSchema({
        count: { type: 'number', required: true, description: 'Number of leases listed.' },
        lockRoot: { type: 'string', required: true, description: 'Directory holding the lock files; the CLI must use the same one.' },
        text: { type: 'string', required: true, description: 'The formatted lease table.' },
      }),
      render: textRender((v) => v.text),
    },
    execute: async (args, exec) => {
      const me = agentKey(/** @type {any} */ (exec)?.agent)
      const filter = typeof args.key === 'string' && args.key !== '' ? args.key : undefined
      const rows = list({ includeExpired: args.includeExpired === true })
        .filter((row) => filter === undefined || row.key === filter)
      const now = Date.now()
      const lines = rows.map((row) => {
        const who = me !== undefined && row.owner === me ? 'you' : `owner ${row.owner ?? 'unknown'}`
        const reason = row.reason ? `, reason: ${row.reason}` : ''
        const id = row.mine ? `, id ${row.id}` : ''
        return `- ${row.key}: ${describeLease(row, now)}, ${who}${reason}${id}`
      })
      const text = rows.length === 0
        ? `No live leases${filter === undefined ? '' : ` for "${filter}"`}. Lock root: ${cfg.lockRoot}`
        : `Live resource leases (lock root ${cfg.lockRoot}):\n${lines.join('\n')}`
      return { count: rows.length, lockRoot: cfg.lockRoot, text }
    },
  })), 'dsh-resource-lease: tool resource_status')

  // ------------------------------------------------------- 3. visibility

  /**
   * Build the runtime context text for one prompt assembly.
   *
   * HARD REQUIREMENT: with no live lease this returns '' so ordinary agents
   * get no extra prompt text at all.
   *
   * @param {{ agent?: unknown, scope?: unknown }} assembly the assembly context.
   * @returns {string} context text, or ''.
   */
  function renderContext(assembly) {
    try {
      const leases = liveLeases()
      if (leases.length === 0) return ''
      const now = Date.now()
      const me = agentKey(assembly?.agent) ?? agentKey(assembly?.scope)
      const mine = me === undefined ? [] : leases.filter((meta) => meta.owner === me)
      const rest = me === undefined ? leases : leases.filter((meta) => meta.owner !== me)
      if (mine.length === 0 && rest.length === 0) return ''

      const lines = ['Resource leases in effect right now (file locks shared with other agents and with the resource-lease CLI):']
      if (mine.length > 0) {
        lines.push('Held by you:')
        for (const meta of mine) {
          lines.push(`- ${meta.key}: ${describeLease(meta, now)}, id ${meta.id}${meta.reason ? `, reason: ${meta.reason}` : ''}`)
        }
      }
      if (rest.length > 0) {
        lines.push(me === undefined ? 'Held:' : 'Held by other agents:')
        for (const meta of rest) {
          lines.push(`- ${meta.key}: ${describeLease(meta, now)}, owner ${meta.owner ?? 'unknown'}${meta.reason ? `, reason: ${meta.reason}` : ''}`)
        }
      }
      lines.push('Call resource_acquire before using a resource another agent holds, and resource_release what you hold as soon as the work is done.')
      return lines.join('\n')
    } catch {
      // A throwing context provider would break prompt assembly for every
      // agent, so failures degrade to "say nothing".
      return ''
    }
  }

  ctx.effect(() => ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: (assembly) => renderContext(assembly),
  }), 'dsh-resource-lease: runtime context')

  // ------------------------------------------------------------ 4. guard

  ctx.effect(() => ctx.tools.guard((exec) => {
    try {
      const needed = cfg.protectedTools[/** @type {any} */ (exec)?.name]
      if (needed === undefined) return undefined
      const owner = agentKey(/** @type {any} */ (exec)?.agent) ?? processOwner()
      if (holds(owner, needed)) return undefined
      return `Tool "${/** @type {any} */ (exec).name}" requires the resource "${needed}", which you do not hold. `
        + `Call resource_acquire with key="${needed}" and a reason describing what you are about to do, then retry "${/** @type {any} */ (exec).name}". `
        + `If "${needed}" is busy, resource_status shows the current holder and the remaining time.`
    } catch {
      // A guard that throws would deny or break the tool pipeline; an unknown
      // state is treated as "not protected" rather than blocking the agent.
      return undefined
    }
  }), 'dsh-resource-lease: protected tools guard')

  // ------------------------------------------------- 5. per-agent cleanup

  ctx.effect(() => () => {
    for (const dispose of [...agentCleanups]) {
      try {
        dispose()
      } catch {
        /* the agent context may already be disposed */
      }
    }
    agentCleanups.clear()
  }, 'dsh-resource-lease: per-agent cleanup')

  ctx.on('agent/created', (payload) => {
    try {
      const agent = /** @type {any} */ (payload)?.agent
      const agentCtx = agent?.ctx
      const owner = agentKey(agent)
      if (owner === undefined) return
      if (!agentCtx || typeof agentCtx.effect !== 'function') return
      const dispose = agentCtx.effect(() => () => {
        try {
          releaseAll(owner)
        } catch (error) {
          log.warn(`releasing leases for ${owner} failed:`, error instanceof Error ? error.message : error)
        }
      }, `dsh-resource-lease: release leases of ${owner}`)
      if (typeof dispose === 'function') agentCleanups.add(dispose)
    } catch (error) {
      // Never fail agent creation because of lease bookkeeping.
      log.warn('could not install per-agent lease cleanup:', error instanceof Error ? error.message : error)
    }
  })

  // ------------------------------------------------------- 6. unload path

  ctx.effect(() => () => {
    try {
      const released = releaseAll()
      if (released > 0) log.info(`released ${released} lease(s) on unload`)
    } catch (error) {
      log.warn('releasing leases on unload failed:', error instanceof Error ? error.message : error)
    }
  }, 'dsh-resource-lease: release all leases on unload')
}
