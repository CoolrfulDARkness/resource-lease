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
import * as resources from './resources.js'

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

/** Placement of the operator-configured rules. Right after our lease context. */
const RULES_CONTEXT_ORDER = 126
/** Distinct name so the two providers shadow independently. */
const RULES_CONTEXT_NAME = 'resource-lease-rules'

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
    // An array node without `items` is an incomplete schema, and the registry
    // validates the finished schema, so `items` has to survive the shorthand.
    if (node.items !== undefined) value.items = node.items
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
 * Normalise ONE `protectedTools` entry (§9.1 strength tiers).
 *
 * Two shapes are accepted, and the difference is a SAFETY decision, not a syntax
 * preference:
 *
 *   - **string** (`tool: 'screen:focus'`) is v1's L-strict form and keeps its
 *     semantics byte-for-byte: the caller must hold the lease, or the guard
 *     refuses. Nothing is acquired on its behalf.
 *   - **object** (`{ key, autoAcquire, ttlMs, reason, mode }`) is the opt-in for
 *     the new tiers. `autoAcquire: true` means "take a short lease for me if the
 *     resource is free"; `mode: 'observe'` means "never take a lease, only refuse
 *     when someone else holds it".
 *
 * Unknown fields are ignored (the same lenient style as `resources`), but a
 * missing/unusable `key` is reported: silently dropping a protection rule is
 * exactly the kind of quiet hole this plugin exists to prevent.
 *
 * @param {string} tool tool name as registered with the runtime.
 * @param {unknown} value the raw config value for that tool.
 * @param {number} defaultTtlMs fallback TTL for an auto-acquired lease.
 * @param {(message: string) => void} warn logger for unusable entries.
 * @returns {{ key: string, mode: 'strict' | 'observe', autoAcquire: boolean, ttlMs: number, reason: string } | null} spec, or null when unusable.
 */
function normalizeProtectedTool(tool, value, defaultTtlMs, warn) {
  if (typeof value === 'string') {
    const key = value.trim()
    if (key === '') {
      warn(`protectedTools["${tool}"] is an empty key; the entry is ignored`)
      return null
    }
    // v1: L-strict, no automatic acquisition. The guard is the only judge.
    return { key, mode: 'strict', autoAcquire: false, ttlMs: defaultTtlMs, reason: `auto: ${tool}` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warn(`protectedTools["${tool}"] must be a key string or an object with a "key"; the entry is ignored`)
    return null
  }
  const key = typeof value.key === 'string' ? value.key.trim() : ''
  if (key === '') {
    warn(`protectedTools["${tool}"] has no usable "key"; the entry is ignored`)
    return null
  }
  // 'observe' is the explicit degraded tier. Anything else stays strict, so a
  // typo in `mode` can never silently LOWER the protection level.
  const mode = value.mode === 'observe' ? 'observe' : 'strict'
  // Auto-acquisition is opt-in: only a literal `true` turns it on. A missing or
  // misspelled flag must leave the v1 behaviour in place.
  const autoAcquire = value.autoAcquire === true
  const ttlRaw = Number(value.ttlMs)
  const ttlMs = Number.isFinite(ttlRaw) && ttlRaw >= 1000 ? Math.trunc(ttlRaw) : defaultTtlMs
  const reason = typeof value.reason === 'string' && value.reason.trim() !== ''
    ? value.reason.trim()
    : `auto: ${tool}`
  return { key, mode, autoAcquire, ttlMs, reason }
}

/**
 * Merge the row config with built-in defaults.
 *
 * Written independently of the Config schema on purpose: the schema is the
 * user-facing contract, this is what the code actually runs on.
 *
 * @param {unknown} raw the Loader row's config.
 * @param {(message: string) => void} [warn] logger for ignored entries.
 * @returns {{ enabled: boolean, lockRoot: string, defaultTtlMs: number, maxWaitMs: number, onTimeout: string, resources: Record<string, { mode: string, slots: number }>, protectedTools: Record<string, { key: string, mode: 'strict' | 'observe', autoAcquire: boolean, ttlMs: number, reason: string }>, aliases: Record<string, string>, promptRules: string[] }} resolved config.
 */
function normalizeConfig(raw, warn = () => {}) {
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

  // Resolved per-tool specs; the TTL default is only known after defaultTtlMs, so
  // this runs again at the bottom of this function.
  const protectedToolsRaw = {}
  if (c.protectedTools && typeof c.protectedTools === 'object' && !Array.isArray(c.protectedTools)) {
    for (const [tool, value] of Object.entries(c.protectedTools)) protectedToolsRaw[tool] = value
  }

  // §3.3.1: browser:profile:<name> can only expand to a directory facet when
  // the mapping is supplied. Without it the profile key stays a singleton and
  // the directory it actually owns is NOT protected -- which is why the plugin
  // has to be able to pass a table through, and why an unresolved alias is
  // surfaced rather than silently ignored.
  const aliases = {}
  if (c.aliases && typeof c.aliases === 'object' && !Array.isArray(c.aliases)) {
    for (const [key, target] of Object.entries(c.aliases)) {
      if (typeof key !== 'string' || key.trim() === '') continue
      if (typeof target !== 'string' || target.trim() === '') continue
      aliases[key.trim()] = target.trim()
    }
  }

  // Short rules this plugin injects into EVERY prompt assembly, verbatim.
  //
  // Why here: a document only changes behaviour if it is actually read, and the
  // only place guaranteed to be read every turn is the system prompt. Rules an
  // operator wants enforced unconditionally (not "consult this file") belong in
  // configuration, not in a markdown file nobody opens. Keeping it a plain list
  // of strings makes this a general mechanism rather than a computer-use hack.
  const promptRules = []
  if (Array.isArray(c.promptRules)) {
    for (const rule of c.promptRules) {
      if (typeof rule === 'string' && rule.trim() !== '') promptRules.push(rule.trim())
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

  const protectedTools = {}
  for (const [tool, value] of Object.entries(protectedToolsRaw)) {
    const spec = normalizeProtectedTool(tool, value, defaultTtlMs, warn)
    if (spec !== null) protectedTools[tool] = spec
  }

  return {
    // H3 kill switch. Default ON: the shared acquire mutex is what closes the
    // ancestor/range/cross-class scan+create window. Turning it off is an escape hatch
    // for a wedged deployment, never a supported mode -- the kernel reports it loudly.
    globalMutex: c.globalMutex !== false,
    enabled: c.enabled !== false,
    lockRoot: typeof c.lockRoot === 'string' && c.lockRoot.trim() !== '' ? c.lockRoot.trim() : lock.defaultLockRoot(),
    defaultTtlMs,
    maxWaitMs,
    onTimeout: ON_TIMEOUT.includes(c.onTimeout) ? c.onTimeout : 'fail',
    resources,
    protectedTools,
    aliases,
    promptRules,
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
  // The logger comes first so config problems (an unusable protectedTools entry)
  // are reported through the host's logger instead of vanishing.
  const log = makeLogger(ctx)
  const cfg = normalizeConfig(config, (message) => log.warn(message))
  // H3 kill switch: turning the shared acquire mutex OFF must be LOUD, never silent.
  // With it off, two agents can both win the ancestor/range/cross-class case (path:a and
  // path:a/sub touch different files), which is exactly the hole the mutex closes. This
  // is an escape hatch for a wedged deployment, not a supported mode.
  if (cfg.globalMutex === false) {
    log.warn('resource-lease: globalMutex is DISABLED. Acquire no longer takes the shared '
      + "'_global.lock' mutex, so the ancestor/range/cross-class scan+create window is OPEN: "
      + 'two agents can both win path:a and path:a/sub. resource_status reports this as '
      + 'degraded; this is not a supported mode.')
  }
  if (!cfg.enabled) return

  /** Leases this process holds: lease id -> metadata. */
  const held = new Map()
  /** Disposers registered on agent contexts, so plugin unload removes them. */
  const agentCleanups = new Set()

  /**
   * The lease backend (§6 of RESOURCE-MODEL-v2).
   *
   * localBackend wraps the SAME lock root the CLI uses, which is what makes a
   * CLI holder and a plugin holder exclude each other. Keeping every disk touch
   * behind this object is also what would let a broker backend be dropped in
   * without changing the call sites.
   */
  const backend = lock.localBackend(cfg.lockRoot, {
    warn: (message) => log.warn(message),
  })

  // Route the lock kernel's model warnings (degradation, invalid keys, and the
  // §11.7-① "acquired WITHOUT full protection" coverage gap) into this plugin's
  // own logger. Without this they fall back to process.emitWarning -> stderr,
  // which the MCP stdio path buries in host logs agents never read.
  try {
    lock.setModelWarningSink((message) => log.warn(message))
  } catch {
    /* warning routing is best effort */
  }

  // Install the alias table (§3.3.1) before anything can expand a key. The
  // resource model keeps it as module state, so the lock kernel's facetsOf()
  // picks it up without every call site having to thread it through.
  if (Object.keys(cfg.aliases).length > 0) {
    try {
      resources.setAliases(cfg.aliases)
    } catch (error) {
      log.warn('could not install the alias table:', error instanceof Error ? error.message : error)
    }
  }

  // An alias that cannot be resolved means a key the caller believes is
  // protected is not actually protected. Say so once at startup rather than
  // letting it fail silently later.
  for (const key of Object.keys(cfg.aliases)) {
    try {
      const report = resources.expandReport(key)
      const unresolved = Array.isArray(report?.unresolved) ? report.unresolved : []
      for (const row of unresolved) {
        if (row?.unresolved === 'required') {
          log.warn(`alias "${key}" could not be resolved (${row.id}); that resource is NOT protected until it is`)
        }
      }
    } catch {
      /* reporting is best effort; a broken key must not stop the plugin */
    }
  }

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
   * Whether `owner` currently holds something that covers `key`.
   *
   * Facet-aware on purpose: `holds(owner, "path:d:/out")` is true when the owner
   * leased `path:d:/out/sub`, because holding the subdirectory covers the parent
   * for the guard's purposes. A plain string comparison here would let the guard
   * wave through exactly the ancestor/descendant collisions v2 exists to catch.
   *
   * @param {string} owner owner name.
   * @param {string} key resource key.
   * @returns {boolean} true when a live lease of this owner covers `key`.
   */
  function holds(owner, key) {
    const now = Date.now()
    const wanted = lock.facetsOf(key)
    return lock.listLocks(cfg.lockRoot).some((meta) => {
      if (meta.owner !== owner) return false
      if (lock.isExpired(meta, now)) return false
      const mine = lock.facetsOfMeta(meta)
      const mode = typeof meta.mode === 'string' ? meta.mode : 'exclusive'
      for (const facet of wanted) {
        for (const heldFacet of mine) {
          if (facet === heldFacet) return true
          // Both sides are checked because the implication table is not
          // guaranteed to be symmetric for every class pair.
          if (lock.facetsClash(facet, 'exclusive', heldFacet, mode)) return true
          if (lock.facetsClash(heldFacet, mode, facet, 'exclusive')) return true
        }
      }
      return false
    })
  }

  /**
   * Every LIVE, OTHER OWNER's lease that conflicts with `key`.
   *
   * This is the "someone else is in the way" half of §9.1, and it is the whole
   * decision for `mode: 'observe'`: refuse only when another agent actually holds
   * a conflicting facet.
   *
   * Deliberate exclusions, all three of which prevent a permanent false denial:
   *   - our OWN leases never count (that is the self-blocking trap: a short-TTL
   *     auto lease we took on the previous call must not refuse the next one);
   *   - expired leases do not count (TTL ran out: takeable, not held);
   *   - leases whose owner is provably dead do not count (G3: the next acquire
   *     would collect them, so refusing would be a lie).
   *
   * @param {string} owner this caller's agent key.
   * @param {string} key resource key wanted.
   * @param {string} [wantMode] mode the caller would use; 'exclusive' by default.
   * @returns {Array<{ id: string | null, facet: string, agent: string, reason: string, expiresInMs: number | null, mode: string }>} one row per blocking lease.
   */
  function otherHolders(owner, key, wantMode = 'exclusive') {
    const now = Date.now()
    const wanted = lock.facetsOf(key)
    const rows = []
    /** @type {Set<string>} one row per lease, not one per conflicting facet pair */
    const seen = new Set()
    for (const meta of lock.listLocks(cfg.lockRoot)) {
      if (!meta || typeof meta !== 'object') continue
      if (lock.isExpired(meta, now)) continue
      const info = lock.ownerInfoOf(meta)
      if (info.agent !== undefined && info.agent === owner) continue // never our own
      if (lock.isOwnerAlive(meta, { now }) === false) continue // provably gone (G3)
      const theirFacets = lock.facetsOfMeta(meta)
      if (theirFacets.length === 0) continue
      const theirMode = typeof meta.mode === 'string' ? meta.mode : 'exclusive'
      for (const facet of wanted) {
        for (const theirFacet of theirFacets) {
          if (!lock.facetsClash(facet, wantMode, theirFacet, theirMode)
            && !lock.facetsClash(theirFacet, theirMode, facet, wantMode)) continue
          const id = typeof meta.id === 'string' ? meta.id : null
          const tag = id ?? `${theirFacet}|${info.agent ?? ''}`
          if (seen.has(tag)) continue
          seen.add(tag)
          const expiresAt = Number(meta.expiresAt)
          rows.push({
            id,
            facet: theirFacet,
            agent: info.agent ?? '(unknown)',
            reason: typeof meta.reason === 'string' ? meta.reason : '',
            expiresInMs: Number.isFinite(expiresAt) ? Math.max(0, Math.trunc(expiresAt - now)) : null,
            mode: theirMode,
          })
        }
      }
    }
    return rows
  }

  /**
   * A refusal reason a human (or a model) can act on: WHO holds it, for HOW LONG,
   * WHY, and what to do instead. Kept in one place so the observe tier and the
   * auto-acquire tier tell the same story.
   *
   * @param {string} key the resource wanted.
   * @param {ReadonlyArray<Record<string, any>>} rows blocking rows.
   * @returns {string} deny reason.
   */
  function busyReason(key, rows) {
    const list = Array.isArray(rows) ? rows : []
    if (list.length === 0) {
      return `"${key}" is held by another agent right now, so this call was refused. `
        + 'Wait for it to be released (resource_status shows the holder), then retry.'
    }
    const described = list.slice(0, 3).map((row) => {
      const heldBy = row.heldBy && typeof row.heldBy === 'object' ? row.heldBy : null
      const agent = row.agent ?? heldBy?.agent ?? '(unknown)'
      const rawLeft = row.expiresInMs ?? row.expiresIn
      const left = Number.isFinite(Number(rawLeft))
        ? `${Math.max(0, Math.ceil(Number(rawLeft) / 1000))}s left`
        : 'expiry unknown'
      const why = typeof row.reason === 'string' && row.reason !== '' ? `, reason: ${row.reason}` : ''
      const facet = typeof row.facet === 'string' && row.facet !== '' ? `${row.facet} ` : ''
      return `${facet}held by ${agent} (${left}${why})`
    })
    return `"${key}" is busy: ${described.join('; ')}. `
      + 'This call was refused instead of running without the resource. '
      + 'Wait for the holder to finish (resource_status shows the remaining time) and retry.'
  }

  /**
   * Whether the tool call was already cancelled. §9's pre-execute contract
   * requires an async gate to observe `exec.signal`.
   *
   * @param {unknown} exec tool execution.
   * @returns {boolean} true when the signal is aborted.
   */
  function isAborted(exec) {
    const signal = exec && typeof exec === 'object' ? /** @type {any} */ (exec).signal : undefined
    return Boolean(signal && signal.aborted === true)
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
   * Release one lease: every facet file it owns, plus its index records.
   *
   * A v2 lease covers a SET of facet files, so releasing means "remove each of
   * them, and only the ones still carrying this id". lock.releaseMany() does
   * that with an id check per file (removeIfOwned semantics): after a takeover
   * the same path holds the NEW holder's lease, so a delete by path alone would
   * destroy a live lock belonging to someone else. When the ids disagree nothing
   * is deleted, the stale local record is dropped, and the mismatch is logged.
   *
   * @param {string} id lease id.
   * @returns {boolean} true when at least one lock file was actually removed.
   */
  function releaseOne(id) {
    if (typeof id !== 'string' || id === '') return false

    const meta = held.get(id)
    if (meta !== undefined && Number(meta.pid) !== process.pid) {
      // A lease recorded in memory is still only releasable by the process
      // that created it.
      return false
    }

    let result
    try {
      result = lock.releaseMany(backend, id, { warn: (message) => log.warn(message) })
    } catch (error) {
      log.warn(`releasing lease ${id} failed:`, error instanceof Error ? error.message : error)
      return false
    }

    forget(id)
    const releasedFacets = Array.isArray(result?.releasedFacets) ? result.releasedFacets : []
    const kept = Array.isArray(result?.kept) ? result.kept : []
    const missing = Array.isArray(result?.missing) ? result.missing : []
    if (kept.length > 0) {
      log.warn(`lease ${id}: ${kept.length} facet(s) were taken over by another holder; left their lock files in place`)
    }
    // The lease was in our local record but every one of its lock files is
    // gone: someone removed them out from under us (or a takeover archived
    // them). That is not a successful release and it must not pass silently --
    // the v1 behaviour logged it, and a caller reading "released" would
    // otherwise believe the resource is free when it may not be.
    if (releasedFacets.length === 0 && missing.length > 0) {
      logNotOurs(id, null)
    }
    return releasedFacets.length > 0
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
   * Normalize the caller's request into the §7.1 request list.
   *
   * Accepts either a single `key` (v1 shape, kept so existing callers and the
   * protectedTools guard keep working) or a `resources` array (v2 shape, which
   * is what makes "this operation needs the output dir AND the port AND the
   * profile" expressible as one all-or-nothing lease).
   *
   * @param {{ key?: string, mode?: string, slots?: number, resources?: Array<Record<string, any>> }} req request.
   * @returns {Array<{ key: string, mode?: string, slots?: number }>} request list.
   */
  function normalizeRequests(req) {
    const list = []
    if (Array.isArray(req.resources)) {
      for (const entry of req.resources) {
        if (!entry || typeof entry !== 'object') continue
        const key = typeof entry.key === 'string' ? entry.key.trim() : ''
        if (key === '') continue
        list.push({ key, mode: entry.mode, slots: entry.slots })
      }
    }
    if (list.length === 0 && typeof req.key === 'string' && req.key.trim() !== '') {
      list.push({ key: req.key.trim(), mode: req.mode, slots: req.slots })
    }
    if (list.length === 0) {
      throw new Error(
        'resource lease: pass "key" (one resource) or "resources" (a list of {key, mode?, slots?}) - '
        + 'e.g. resources: [{key:"path:d:/out"}, {key:"port:9222"}]',
      )
    }
    for (const entry of list) {
      if (entry.mode !== undefined && entry.mode !== null && !MODES.includes(entry.mode)) {
        throw new Error(`resource lease: mode must be one of ${MODES.join(', ')} (got ${JSON.stringify(entry.mode)})`)
      }
      if (entry.slots !== undefined && entry.slots !== null
        && (!Number.isFinite(Number(entry.slots)) || Number(entry.slots) < 1)) {
        throw new Error(`resource lease: slots must be a positive whole number (got ${JSON.stringify(entry.slots)})`)
      }
    }
    return list
  }

  /**
   * Acquire one lease covering every requested resource, atomically.
   *
   * The lease is all-or-nothing: if any facet is busy the whole acquisition
   * rolls back and the error names the facet, its holder, their reason and the
   * remaining time. That is deliberate -- a half-acquired lease is a deadlock
   * waiting to happen, and a partial hold is worse than no hold because the
   * caller believes it owns more than it does.
   *
   * @param {{ key?: string, mode?: string, slots?: number, resources?: Array<Record<string, any>>, ttlMs?: number | string, waitMs?: number | string, reason?: string, owner?: string }} [req] lease request.
   * @returns {Record<string, any>} the acquired lease.
   */
  async function lease(req = {}) {
    const requests = normalizeRequests(req)

    const ttlMs = Math.max(1000, lock.toMs(req.ttlMs, cfg.defaultTtlMs))
    const waitMs = Math.min(cfg.maxWaitMs, lock.toMs(req.waitMs, 0))
    const ownerName = typeof req.owner === 'string' && req.owner !== '' ? req.owner : processOwner()
    const reason = typeof req.reason === 'string' ? req.reason : ''
    // cfg.onTimeout 'steal' is intentionally not forwarded: acquireMany has no
    // steal strategy, and a steal is only ever legitimate from a recovery path,
    // never from an ordinary acquire.
    const strategy = cfg.onTimeout === 'queue' ? 'queue' : 'fail'

    lock.ensureLockRoot(cfg.lockRoot)

    const result = lock.acquireMany(backend, requests, {
      ttlMs,
      reason,
      owner: lock.currentOwner(ownerName),
      strategy,
      waitMs,
      // Kill switch (H3): globalMutex: false in the plugin config turns the shared
      // acquire mutex off. The kernel reports mutex.enabled: false on every result, so a
      // caller can SEE the degraded mode instead of assuming the guarantee still holds.
      mutex: cfg.globalMutex,
    })

    if (result === null || typeof result !== 'object') {
      throw new Error('resource lease: the lock kernel returned no result')
    }

    if (result.ok !== true) {
      const conflicts = Array.isArray(result.conflicts) ? result.conflicts : []
      const detail = conflicts.length === 0
        ? 'no conflict detail was reported'
        : conflicts.map((row) => {
          const who = row.heldBy ?? {}
          const whoText = [who.agent ?? 'unknown', who.session, who.pid !== undefined ? `pid ${who.pid}` : '', who.host]
            .filter((part) => part !== undefined && part !== null && part !== '').join(' / ')
          const left = Number(row.expiresInMs)
          const leftText = Number.isFinite(left) ? `${Math.ceil(left / 1000)}s left` : 'expiry unknown'
          const why = row.reason ? `, reason: ${row.reason}` : ''
          return `${row.facet} held by ${whoText} (${leftText}${why})`
        }).join('; ')
      const rolled = Array.isArray(result.released) && result.released.length > 0
        ? ` Nothing was kept: ${result.released.length} already-acquired facet(s) were rolled back.`
        : ''
      const error = new Error(
        `Resource busy: ${detail}. Wait for the holder to release it (or let its TTL expire), then acquire again.${rolled}`,
      )
      error.code = 'RESOURCE_BUSY'
      error.conflicts = conflicts
      throw error
    }

    // Remember it locally so release-by-id works even for a multi-facet lease,
    // and so releaseAll can find this process's leases without a disk scan.
    const record = {
      id: String(result.id),
      key: String(result.key ?? requests[0].key),
      facets: Array.isArray(result.facets) ? result.facets : [],
      mode: String(result.mode ?? 'exclusive'),
      owner: ownerName,
      reason,
      pid: process.pid,
      host: os.hostname(),
      createdAt: Number(result.createdAt ?? Date.now()),
      expiresAt: Number(result.expiresAt ?? Date.now() + ttlMs),
      entries: Array.isArray(result.entries) ? result.entries : [],
      lockPath: Array.isArray(result.entries) && result.entries.length > 0
        ? String(result.entries[0].lockPath ?? '')
        : '',
    }
    held.set(record.id, record)
    return record
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
      resources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Resource key, category:subject.' },
            mode: { type: 'string', enum: ['exclusive', 'shared', 'pool'], description: 'Arbitration mode for this resource; omit to use the configured default.' },
            slots: { type: 'number', description: 'Concurrent holders for mode "pool".' },
          },
          required: ['key'],
        },
        description: 'Every resource this operation needs, acquired atomically: if any one is busy the whole request is rolled back and nothing is held. Prefer this over "key" whenever the work touches more than one thing (an output directory AND a port, a browser profile AND screen focus). Each item is {key, mode?, slots?}.',
      },
      key: {
        type: 'string',
        description: 'Single-resource shorthand, equivalent to resources:[{key}]. Resource key, category:subject. Examples: "path:D:/out", "port:9222", "screen:focus", "browser:profile:work", "browser:instance", "proc:npm-install". Conflicts are decided on canonical facets, not on string equality, so "path:D:/out" and "path:D:/out/sub" conflict while "path:D:/out" and "path:D:/out2" do not.',
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
        key: { type: 'string', required: true, description: 'The primary resource key that was leased.' },
        facets: { type: 'string', required: true, description: 'Comma-separated canonical facets this lease covers. These are what other agents actually conflict with, and there can be more of them than there were keys (a browser profile expands to its directory).' },
        mode: { type: 'string', required: true, description: 'Mode that was used.' },
        owner: { type: 'string', required: true, description: 'Owner recorded on the lease (the calling agent).' },
        reason: { type: 'string', required: true, description: 'Reason recorded on the lease.' },
        expiresAt: { type: 'number', required: true, description: 'Epoch milliseconds at which the lease expires on its own.' },
        ttlMs: { type: 'number', required: true, description: 'Effective lease lifetime in milliseconds.' },
        waitedMs: { type: 'number', required: true, description: 'How long the acquire waited before succeeding.' },
        lockPath: { type: 'string', required: true, description: 'The first lock file that holds this lease.' },
      }),
      render: textRender((v) => {
        const facets = String(v.facets ?? '')
        const extra = facets !== '' ? ` covering ${facets}` : ''
        return `Lease ${v.id} acquired on "${v.key}" (${v.mode})${extra}, owner ${v.owner}, expires in ${Math.round(Number(v.ttlMs) / 1000)}s. Call resource_release with id="${v.id}" when the work is done.`
      }),
    },
    execute: async (args, exec) => {
      const started = Date.now()
      const record = await lease({
        resources: args.resources,
        key: args.key,
        mode: args.mode,
        slots: args.slots,
        ttlMs: args.ttlMs,
        waitMs: args.waitMs,
        reason: args.reason,
        owner: ownerOf(exec),
      })
      return {
        id: String(record.id),
        key: String(record.key),
        facets: (Array.isArray(record.facets) ? record.facets : []).join(','),
        mode: String(record.mode),
        owner: String(record.owner ?? ''),
        reason: String(record.reason ?? ''),
        expiresAt: Number(record.expiresAt),
        ttlMs: Number(record.expiresAt) - Number(record.createdAt),
        waitedMs: Date.now() - started,
        lockPath: String(record.lockPath ?? ''),
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
        globalMutex: { type: 'object', required: true, description: 'Whether the shared acquire mutex is in use; enabled:false means DEGRADED (ancestor/range/cross-class window is open).' },
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
      // H3: the kill switch must be visible here, not only in the log. An operator who
      // reads status must be able to tell "the guarantee is on" from "degraded".
      const mutex = cfg.globalMutex === false
        ? { enabled: false, mode: 'degraded', warning: 'no acquire mutex: the ancestor/range/cross-class scan+create window is OPEN' }
        : { enabled: true, mode: 'enforced' }
      const degradedBanner = mutex.enabled === true
        ? ''
        : 'WARNING: DEGRADED MODE - the shared acquire mutex is DISABLED (' + mutex.warning + ').\n\n'
      const text = rows.length === 0
        ? `No live leases${filter === undefined ? '' : ` for "${filter}"`}. Lock root: ${cfg.lockRoot}`
        : `Live resource leases (lock root ${cfg.lockRoot}):\n${lines.join('\n')}`
      return { count: rows.length, lockRoot: cfg.lockRoot, globalMutex: mutex, text: degradedBanner + text }
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

  // Configured rules, emitted verbatim on every assembly. Emits '' when the
  // operator configured none, so an ordinary profile pays nothing.
  ctx.effect(() => ctx.systemPrompt.context({
    name: RULES_CONTEXT_NAME,
    order: RULES_CONTEXT_ORDER,
    text: () => (cfg.promptRules.length === 0 ? '' : cfg.promptRules.join('\n')),
  }), 'dsh-resource-lease: configured rules')

  // ------------------------------------------------------------ 4. guard

  // The guard is a SYNCHRONOUS, judgement-only gate ("monotonic denial" in the
  // Service's own words): it may add a refusal, and it may not do work with side
  // effects. Automatic acquisition therefore does NOT live here -- it lives in the
  // `tools/pre-execute` listener below, which is async, runs BEFORE this guard, and
  // has an explicit deny result. By the time the guard runs, either a lease exists
  // (this listener acquired it) and `holds()` is true, or the request was already
  // denied. Two gates, and the second one is a pure fallback that cannot fail open
  // into "tool ran without a lease".
  //
  // The `catch { return undefined }` below stays fail-OPEN on purpose, and it is
  // only safe because nothing in here has a side effect: a judgement that crashes
  // leaves the world exactly as it found it, so refusing a whole tool pipeline over
  // a broken status read would be worse. That argument does NOT extend to the
  // pre-execute listener -- see the deny-on-exception rule there.
  ctx.effect(() => ctx.tools.guard((exec) => {
    try {
      const spec = cfg.protectedTools[/** @type {any} */ (exec)?.name]
      if (spec === undefined) return undefined
      const owner = agentKey(/** @type {any} */ (exec)?.agent) ?? processOwner()
      if (spec.mode === 'observe') {
        // Declared-observe tier: holding nothing is legal, so the only refusal is a
        // real collision with another live holder. Pure read, no side effect.
        const others = otherHolders(owner, spec.key, 'exclusive')
        if (others.length === 0) return undefined
        return `Tool "${/** @type {any} */ (exec).name}" is blocked: ${busyReason(spec.key, others)}`
      }
      if (holds(owner, spec.key)) return undefined
      // v1 wording, unchanged: an operator grep for it must still find it.
      return `Tool "${/** @type {any} */ (exec).name}" requires the resource "${spec.key}", which you do not hold. `
        + `Call resource_acquire with key="${spec.key}" and a reason describing what you are about to do, then retry "${/** @type {any} */ (exec).name}". `
        + `If "${spec.key}" is busy, resource_status shows the current holder and the remaining time.`
    } catch {
      // A guard that throws would deny or break the tool pipeline; an unknown
      // state is treated as "not protected" rather than blocking the agent.
      return undefined
    }
  }), 'dsh-resource-lease: protected tools guard')

  // ------------------------------------------- 4b. zero-friction auto-acquire
  //
  // "If avoiding a collision means the user cannot work, that is not acceptable."
  // (§9.1 strength tiers, `autoAcquire`): for a tool explicitly configured with
  // `autoAcquire: true`, take a SHORT lease when the resource is free instead of
  // making the caller pay a manual `resource_acquire` tax first.
  //
  // Why here and not in the guard: this hook is async (acquisition is disk I/O),
  // it runs before the guard, and it can DENY. That last property is the whole
  // point -- see the exception rule below.
  //
  // Failure directions, which are the reason this is not written inside the guard's
  // `try` block:
  //   - resource free  -> acquire, then allow        (zero friction, lease visible)
  //   - someone holds  -> deny with holder + TTL     (real collision: refuse)
  //   - acquire throws -> DENY                        (fail-CLOSED; never allow)
  //   - next() throws  -> DENY, and release our lease (fail-closed, no ghost)
  ctx.on('tools/pre-execute', async (exec, next) => {
    /** Id of a lease this call created, so every failure path can release it. */
    let createdId = null
    try {
      if (!cfg.enabled) return await next()
      const spec = cfg.protectedTools[/** @type {any} */ (exec)?.name]
      // Not protected -> zero cost, straight through.
      if (spec === undefined) return await next()
      // v1 string config, and `autoAcquire: false`: the guard's L-strict semantics
      // decide, exactly as before this hook existed.
      if (spec.mode === 'observe' || spec.autoAcquire !== true) return await next()

      const owner = agentKey(/** @type {any} */ (exec)?.agent) ?? processOwner()

      // Already ours -> reuse, do NOT acquire again. This is the self-blocking
      // trap: an auto lease from the previous call is still live and belongs to
      // us, so a naive "is anyone holding it?" test would refuse our own lease.
      if (holds(owner, spec.key)) return await next()

      // A call cancelled before we start must not leave a lease behind.
      if (isAborted(exec)) return { kind: 'cancel' }

      try {
        createdId = (await lease({
          key: spec.key,
          mode: 'exclusive',
          ttlMs: spec.ttlMs,
          reason: spec.reason,
          owner,
        })).id
      } catch (error) {
        // CONCURRENCY: two calls from the SAME agent can race here (both saw "not
        // held"). The loser's conflict is with the winner's lease, which is ours,
        // so re-check before refusing -- otherwise a single agent would refuse
        // itself.
        if (holds(owner, spec.key)) return await next()
        if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'RESOURCE_BUSY') {
          const conflicts = /** @type {any} */ (error).conflicts
          return { kind: 'deny', reason: busyReason(spec.key, conflicts) }
        }
        // Anything else (unwritable lock root, disk full, a bug) must NOT run the
        // tool: an unrecorded action is the silent double-hold this plugin exists
        // to prevent. Fail CLOSED and say why.
        const why = error instanceof Error ? error.message : String(error)
        return {
          kind: 'deny',
          reason: `Cannot record a lease for "${spec.key}", so the call was refused: ${why}. `
            + 'Fix the lock root (or the lease backend) and retry.',
        }
      }

      // The gate let us through; the decision below belongs to the rest of the
      // pipeline. If it stops the tool, the lease we just took must go with it.
      const decision = await next()

      // Cancellation wins over everything: the tool will not run, so holding a
      // lease for it would be exactly the ghost we are trying to avoid.
      if (isAborted(exec)) {
        releaseOne(createdId)
        createdId = null
        return { kind: 'cancel' }
      }

      // deny/cancel mean the tool will NOT run, so release at once. `ask` is
      // deliberately NOT in this list: approval may still let the tool run, and
      // this hook never sees the approval outcome. Releasing here would then let
      // the L-strict guard refuse an APPROVED call. Keeping the lease is the safe
      // side of that ambiguity, and its cost is bounded: the lease is ours, the
      // next call reuses it, and the TTL (<= ttlMs) bounds the residue if the
      // approval is refused.
      const stops = decision && typeof decision === 'object'
        && (decision.kind === 'deny' || decision.kind === 'cancel')
      if (stops) {
        releaseOne(createdId)
        createdId = null
      }
      return decision
    } catch (error) {
      // Absolute rule for a gate that takes a lease: an exception must DENY.
      // Returning `next()`/allow here would be the fail-open channel the design
      // calls out -- the tool runs, no lease was ever recorded, and nobody can see
      // afterwards that a collision happened.
      if (createdId !== null) {
        try {
          releaseOne(createdId)
        } catch {
          /* the TTL still bounds the residue; never mask the original failure */
        }
      }
      const why = error instanceof Error ? error.message : String(error)
      return {
        kind: 'deny',
        reason: `The resource-lease gate failed closed, so this call was refused: ${why}. `
          + 'Retry; if it keeps failing, check resource_status and the plugin log.',
      }
    }
  })

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
