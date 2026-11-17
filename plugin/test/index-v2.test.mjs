// Integration test for the v2 plugin surface.
//
// index.js is a Cordis plugin: apply(ctx, config) registers tools, a guard, a
// system-prompt context provider and lifecycle hooks. There is no Cordis
// runtime in a plain `node --test` process, so this file supplies a minimal
// ctx that records what the plugin registers, then exercises the registered
// tool `execute` functions the way the runtime would.
//
// What this catches that unit tests cannot: schema compilation (an array
// parameter without `items` is rejected by the registry), the acquire/release
// round trip across multiple facets, the guard's facet-aware decision, and the
// "no lease => no prompt text" rule.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'

function makeCtx() {
  const tools = new Map()
  const guards = []
  const contexts = []
  const hooks = new Map()
  const disposers = []
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => {}
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
    systemPrompt: {
      context(spec) {
        contexts.push(spec)
        return () => {}
      },
    },
    on(event, handler) {
      hooks.set(event, handler)
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  }
  return { ctx, tools, guards, contexts, hooks, disposers }
}

function tmpRoot() {
  const dir = path.join(os.tmpdir(), `lease-plugin-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Run one registered tool's execute and return its value. */
async function run(tools, name, args, exec = {}) {
  const def = tools.get(name)
  assert.ok(def, `tool ${name} was not registered`)
  return def.execute(args, exec)
}

test('registers the three tools with registry-valid schemas', () => {
  const root = tmpRoot()
  const { ctx, tools, guards, contexts } = makeCtx()
  apply(ctx, { lockRoot: root, defaultTtlMs: 5000 })

  assert.deepEqual([...tools.keys()].sort(), ['resource_acquire', 'resource_release', 'resource_status'])
  for (const [name, def] of tools) {
    assert.equal(def.parameters.type, 'object', `${name} parameters must be an object schema`)
    assert.ok(def.output && typeof def.output.render === 'function', `${name} needs an output render`)
    assert.equal(def.output.schema.additionalProperties, false, `${name} output must be closed`)
  }

  // An array parameter without items is an incomplete schema; the registry
  // validates what we hand it, so this is a real guard against that mistake.
  const resources = tools.get('resource_acquire').parameters.properties.resources
  assert.equal(resources.type, 'array')
  assert.ok(resources.items, 'resources must carry items')
  assert.equal(resources.items.type, 'object')
  assert.deepEqual(resources.items.required, ['key'])

  assert.equal(guards.length, 1, 'exactly one guard must be installed')
  assert.equal(contexts.length, 2, 'two providers: the lease context and the configured-rules context')

  fs.rmSync(root, { recursive: true, force: true })
})

test('acquire with several resources holds every facet, release frees all of them', async () => {
  const root = tmpRoot()
  const { ctx, tools } = makeCtx()
  apply(ctx, { lockRoot: root, defaultTtlMs: 5000 })

  const out = path.join(os.tmpdir(), 'lease-plugin-out')
  const value = await run(tools, 'resource_acquire', {
    resources: [{ key: `path:${out}` }, { key: 'port:9231' }],
    reason: 'integration test',
  })

  assert.ok(value.id)
  assert.ok(value.facets.includes('port:9231'), `facets should include the port, got ${value.facets}`)
  assert.ok(value.facets.toLowerCase().includes('path:'), `facets should include the path, got ${value.facets}`)
  assert.equal(value.mode, 'exclusive')

  // Both facet lock files must exist on disk.
  const locks = fs.readdirSync(root).filter((n) => n.endsWith('.lock'))
  assert.equal(locks.length, 2, `expected 2 lock files, saw ${locks.join(',')}`)

  const released = await run(tools, 'resource_release', { id: value.id })
  assert.equal(released.released, 1)
  const left = fs.readdirSync(root).filter((n) => n.endsWith('.lock'))
  assert.deepEqual(left, [], `every lock file should be gone, left: ${left.join(',')}`)

  fs.rmSync(root, { recursive: true, force: true })
})

test('a busy facet rejects the whole request and rolls back what it took', async () => {
  const root = tmpRoot()
  const { ctx, tools } = makeCtx()
  apply(ctx, { lockRoot: root, defaultTtlMs: 5000 })

  // First agent takes the port.
  const first = await run(tools, 'resource_acquire', { key: 'port:9232', reason: 'holder' }, {
    agent: { session: { id: 'session-holder' } },
  })
  assert.ok(first.id)

  // Second agent wants a free path AND the busy port. All-or-nothing means the
  // path must not stay held after the failure.
  const out = path.join(os.tmpdir(), 'lease-plugin-rollback')
  await assert.rejects(
    () => run(tools, 'resource_acquire', {
      resources: [{ key: `path:${out}` }, { key: 'port:9232' }],
      reason: 'should fail',
    }, { agent: { session: { id: 'session-other' } } }),
    (error) => {
      assert.equal(error.code, 'RESOURCE_BUSY')
      assert.match(error.message, /port:9232/)
      assert.match(error.message, /holder/)
      return true
    },
  )

  // Exactly one lock file may remain: the holder's port.
  const locks = fs.readdirSync(root).filter((n) => n.endsWith('.lock'))
  assert.equal(locks.length, 1, `rollback left ${locks.join(',')} behind`)
  assert.match(locks[0], /port_9232/)

  fs.rmSync(root, { recursive: true, force: true })
})

test('the guard denies a protected tool until the covering resource is held', async () => {
  const root = tmpRoot()
  const { ctx, guards } = makeCtx()
  apply(ctx, {
    lockRoot: root,
    defaultTtlMs: 5000,
    protectedTools: { type_text: 'screen:focus' },
  })

  const guard = guards[0]
  const exec = { name: 'type_text', agent: { session: { id: 'session-guarded' } } }

  const denied = guard(exec)
  assert.equal(typeof denied, 'string', 'an unprotected call must be denied with a message')
  assert.match(denied, /screen:focus/)

  // A tool that is not protected passes straight through.
  assert.equal(guard({ name: 'read_file', agent: { session: { id: 'session-guarded' } } }), undefined)

  fs.rmSync(root, { recursive: true, force: true })
})

test('the context provider emits nothing when no lease is live', () => {
  const root = tmpRoot()
  const { ctx, contexts } = makeCtx()
  apply(ctx, { lockRoot: root, defaultTtlMs: 5000 })

  const provider = contexts[0]
  assert.equal(provider.text({ agent: { session: { id: 'nobody' } } }), '',
    'a prompt must not be polluted when nothing is leased')

  fs.rmSync(root, { recursive: true, force: true })
})

test('the context provider reports a live lease to a different agent', async () => {
  const root = tmpRoot()
  const { ctx, tools, contexts } = makeCtx()
  apply(ctx, { lockRoot: root, defaultTtlMs: 5000 })

  await run(tools, 'resource_acquire', { key: 'port:9233', reason: 'someone is using it' }, {
    agent: { session: { id: 'session-owner' } },
  })

  const text = contexts[0].text({ agent: { session: { id: 'session-bystander' } } })
  assert.match(text, /port:9233/)
  assert.match(text, /someone is using it/)

  fs.rmSync(root, { recursive: true, force: true })
})

test('status lists a lease held by another process, and filtering by key works', async () => {
  const root = tmpRoot()
  const a = makeCtx()
  apply(a.ctx, { lockRoot: root, defaultTtlMs: 5000 })
  const b = makeCtx()
  apply(b.ctx, { lockRoot: root, defaultTtlMs: 5000 })

  await run(a.tools, 'resource_acquire', { key: 'port:9234', reason: 'held by A' }, {
    agent: { session: { id: 'session-a' } },
  })

  const seen = await run(b.tools, 'resource_status', {})
  assert.match(seen.text, /port:9234/, 'a lease from another plugin instance must be visible')
  assert.equal(seen.lockRoot, root)

  const filtered = await run(b.tools, 'resource_status', { key: 'port:9234' })
  assert.equal(filtered.count, 1)

  const none = await run(b.tools, 'resource_status', { key: 'port:9999' })
  assert.equal(none.count, 0)

  fs.rmSync(root, { recursive: true, force: true })
})

test('path conflicts respect segment boundaries, not string prefixes', async () => {
  const root = tmpRoot()
  const { ctx, tools } = makeCtx()
  apply(ctx, { lockRoot: root, defaultTtlMs: 5000 })

  const base = path.join(os.tmpdir(), 'lease-seg')
  await run(tools, 'resource_acquire', { key: `path:${base}` }, { agent: { session: { id: 'session-seg-a' } } })

  // Sibling with a shared string prefix must be free.
  await run(tools, 'resource_acquire', { key: `path:${base}2` }, { agent: { session: { id: 'session-seg-b' } } })

  // A descendant must be refused.
  await assert.rejects(
    () => run(tools, 'resource_acquire', { key: `path:${base}${path.sep}sub` }, {
      agent: { session: { id: 'session-seg-c' } },
    }),
    (error) => error.code === 'RESOURCE_BUSY',
  )

  fs.rmSync(root, { recursive: true, force: true })
})

test('configured promptRules are emitted verbatim on every assembly', () => {
  const root = tmpRoot()
  const { ctx, contexts } = makeCtx()
  apply(ctx, {
    lockRoot: root,
    promptRules: ['RULE ONE: re-read before concluding.', 'RULE TWO: reload once.'],
  })

  const rules = contexts.find((c) => c.name === 'resource-lease-rules')
  assert.ok(rules, 'a dedicated rules provider must be registered')
  assert.equal(rules.text({}), 'RULE ONE: re-read before concluding.\nRULE TWO: reload once.')

  fs.rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// §9.1 strength tiers: zero friction when there is no conflict
// (review task-8/9: "如果为了避免撞车反而让使用者受限 这也是完全不能接受的")
// ---------------------------------------------------------------------------

/**
 * Drive the registered `tools/pre-execute` gate the way the runtime would.
 *
 * `next` stands for the rest of the pipeline: it records that it was reached and
 * returns the decision that pipeline chose (allow by default).
 *
 * @param {Map<string, Function>} hooks listeners registered through ctx.on().
 * @param {Record<string, any>} exec the tool execution being authorized.
 * @param {{ kind: string, [key: string]: any }} [decision] what the rest of the pipeline decides.
 * @returns {Promise<{ result: any, nextCalls: number }>} the decision and whether next() ran.
 */
async function runGate(hooks, exec, decision = { kind: 'allow' }) {
  const handler = hooks.get('tools/pre-execute')
  assert.ok(handler, 'a tools/pre-execute listener must be registered')
  let nextCalls = 0
  const result = await handler(exec, async () => {
    nextCalls += 1
    return decision
  })
  return { result, nextCalls }
}

/** @param {string} root lock root. @returns {string[]} lock file names. */
function lockFiles(root) {
  try {
    return fs.readdirSync(root).filter((name) => name.endsWith('.lock'))
  } catch {
    return []
  }
}

/** @param {string} root lock root. @param {string} facetName sanitized facet. @returns {Record<string, any> | null} body. */
function readLock(root, facetName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, `${facetName}.lock`), 'utf8'))
  } catch {
    return null
  }
}

/** Config for the "desktop automation" case the user reported. */
function autoConfig(root, extra = {}) {
  return {
    lockRoot: root,
    defaultTtlMs: 5000,
    protectedTools: {
      click: { key: 'screen:focus', autoAcquire: true, ttlMs: 15000, ...extra },
    },
  }
}

test('with no promptRules the rules provider emits nothing at all', () => {
  const root = tmpRoot()
  const { ctx, contexts } = makeCtx()
  apply(ctx, { lockRoot: root })

  const rules = contexts.find((c) => c.name === 'resource-lease-rules')
  assert.ok(rules, 'the provider is registered even when unused')
  assert.equal(rules.text({}), '', 'an ordinary profile must pay zero prompt tokens')

  fs.rmSync(root, { recursive: true, force: true })
})

test('an unusable protectedTools entry is reported, not silently turned into a hole', async () => {
  const root = tmpRoot()
  const warnings = []
  const { ctx, guards, hooks } = makeCtx()
  // Capture the logger: a protection rule that cannot be parsed must be visible.
  // (The host passes a logger FACTORY, which is what makeLogger() calls.)
  ctx.logger = () => ({
    info() {},
    debug() {},
    error() {},
    warn: (message) => warnings.push(String(message)),
  })
  apply(ctx, {
    lockRoot: root,
    defaultTtlMs: 5000,
    protectedTools: {
      // No key at all -> cannot protect anything -> ignored, with a warning.
      broken: { autoAcquire: true, ttlMs: 15000 },
      blanks: { key: '   ' },
      // Unknown fields are ignored on purpose (lenient like `resources`), and the
      // documented fields still apply.
      click: { key: 'screen:focus', autoAcquire: true, ttlMs: 15000, holdThrough: true, mystery: 42 },
    },
  })

  // Only the config warnings matter here; the fake ctx also logs unrelated
  // registration notices (it has no `ctx.get`), so filter by the prefix under test.
  const configWarnings = warnings.filter((message) => /protectedTools\[/.test(message))
  assert.equal(configWarnings.length, 2, `both unusable entries must be reported: ${JSON.stringify(configWarnings)}`)
  assert.match(configWarnings.join('\n'), /"broken"/)
  assert.match(configWarnings.join('\n'), /"blanks"/)

  // The broken entries protect nothing: those tools are not gated at all.
  assert.equal(guards[0]({ name: 'broken', agent: { session: { id: 's1' } } }), undefined)
  assert.equal(guards[0]({ name: 'blanks', agent: { session: { id: 's1' } } }), undefined)
  // The usable entry works exactly as configured, unknown field and all.
  const ok = await runGate(hooks, { name: 'click', agent: { session: { id: 's1' } } })
  assert.equal(ok.result.kind, 'allow')
  assert.equal(lockFiles(root).length, 1)

  fs.rmSync(root, { recursive: true, force: true })
})

test('[9.1 auto] a FREE resource is acquired for the caller, so the tool runs', async () => {
  const root = tmpRoot()
  const { ctx, guards, hooks } = makeCtx()
  apply(ctx, autoConfig(root))
  const exec = { name: 'click', agent: { session: { id: 'session-solo' } } }

  // THE core assertion of this task: nobody holds screen:focus, one agent calls a
  // protected tool, and it goes through -- instead of being refused for not having
  // paid a manual resource_acquire first.
  const { result, nextCalls } = await runGate(hooks, exec)
  assert.equal(result.kind, 'allow', `a free protected resource must allow the call, got ${JSON.stringify(result)}`)
  assert.equal(nextCalls, 1, 'the rest of the pipeline must be reached')

  // ...and the lease really exists, so the action is VISIBLE to other agents
  // (resource_status, prompt context) instead of being an invisible free pass.
  const locks = lockFiles(root)
  assert.deepEqual(locks, ['screen_focus.lock'], `exactly one lease must be recorded, saw ${locks.join(',')}`)
  const meta = readLock(root, 'screen_focus')
  assert.equal(meta.owner, 'session-solo', 'the lease must belong to the calling agent')
  assert.equal(meta.key, 'screen:focus')
  assert.equal(meta.reason, 'auto: click', 'the recorded reason must say where the lease came from')
  assert.equal(meta.mode, 'exclusive')
  // Long-lived plugin process: pid-gated by default (no pidGated:false), so a DSH
  // restart reclaims this lease immediately instead of waiting out the TTL.
  assert.equal(meta.ownerInfo.pidGated, undefined, 'an auto lease must stay pid-gated (no ghost after a restart)')

  // The L-strict guard, untouched, now agrees because a lease exists.
  assert.equal(guards[0](exec), undefined, 'the guard must pass once the lease exists')

  fs.rmSync(root, { recursive: true, force: true })
})

test('[9.1 auto] consecutive calls REUSE the lease: never blocked by itself, never stacked', async () => {
  const root = tmpRoot()
  const { ctx, hooks } = makeCtx()
  apply(ctx, autoConfig(root))
  const exec = { name: 'click', agent: { session: { id: 'session-repeat' } } }

  const first = await runGate(hooks, exec)
  assert.equal(first.result.kind, 'allow')
  const afterFirst = readLock(root, 'screen_focus')
  assert.ok(afterFirst)

  // Second call inside the TTL: the previous lease is still live AND still ours.
  // A naive "is anyone holding it?" test would refuse this -- the self-blocking bug.
  const second = await runGate(hooks, exec)
  assert.equal(second.result.kind, 'allow', `the second call must not be blocked by our own lease: ${JSON.stringify(second.result)}`)
  assert.equal(second.nextCalls, 1)

  const locks = lockFiles(root)
  assert.equal(locks.length, 1, `reuse must not stack leases, saw ${locks.join(',')}`)
  const afterSecond = readLock(root, 'screen_focus')
  assert.equal(afterSecond.id, afterFirst.id, 'the SAME lease must be reused, not replaced')

  fs.rmSync(root, { recursive: true, force: true })
})

test('[9.1 auto] another agent holding the resource is a REAL collision: deny with holder and time', async () => {
  const root = tmpRoot()
  const { ctx, tools, hooks } = makeCtx()
  apply(ctx, autoConfig(root))

  await run(tools, 'resource_acquire', { key: 'screen:focus', reason: 'rendering charts' }, {
    agent: { session: { id: 'session-holder' } },
  })

  const { result, nextCalls } = await runGate(hooks, { name: 'click', agent: { session: { id: 'session-late' } } })
  assert.equal(result.kind, 'deny', 'a held resource must still be refused: that is the whole point of the lease')
  assert.equal(nextCalls, 0, 'a denied call must never reach the tool')
  assert.match(result.reason, /screen:focus/)
  assert.match(result.reason, /session-holder/, 'the reason must name the holder')
  assert.match(result.reason, /rendering charts/, 'the reason must quote what they are doing')
  assert.match(result.reason, /\d+s left/, 'the reason must carry the remaining time')
  // The other agent's lease is untouched.
  assert.equal(readLock(root, 'screen_focus').owner, 'session-holder')

  fs.rmSync(root, { recursive: true, force: true })
})

test('[9.1 auto] an acquire FAILURE denies the call (fail-closed), it never allows it', async () => {
  // The one thing this task must not get wrong (review §10, Lead's rule): the old
  // guard's `catch { return undefined }` turns a crash into a silent allow. With a
  // lease on the line that would mean "tool ran, no lease, no trace".
  const blocker = path.join(os.tmpdir(), `lease-not-a-dir-${process.pid}-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(blocker, 'a file where a lock root should be')
  const { ctx, hooks } = makeCtx()
  apply(ctx, autoConfig(blocker))

  const { result, nextCalls } = await runGate(hooks, { name: 'click', agent: { session: { id: 'session-broken' } } })
  assert.equal(result.kind, 'deny', `an unreachable lock root must DENY, got ${JSON.stringify(result)}`)
  assert.equal(nextCalls, 0, 'fail-closed means the tool must NOT run')
  assert.match(result.reason, /refused/i)
  assert.match(result.reason, /screen:focus/)

  fs.rmSync(blocker, { force: true })
})

test('[9.1 observe] the degraded tier refuses only a real collision and records nothing', async () => {
  const root = tmpRoot()
  const { ctx, tools, guards, hooks } = makeCtx()
  apply(ctx, {
    lockRoot: root,
    defaultTtlMs: 5000,
    protectedTools: { type_text: { key: 'screen:focus', mode: 'observe' } },
  })
  const exec = { name: 'type_text', agent: { session: { id: 'session-observer' } } }

  const free = await runGate(hooks, exec)
  assert.equal(free.result.kind, 'allow')
  assert.equal(free.nextCalls, 1)
  assert.deepEqual(lockFiles(root), [], 'observe must NOT take a lease')
  assert.equal(guards[0](exec), undefined, 'the guard must allow observe-tier tools that hold nothing')

  // Someone else takes it: the same call is now refused, with the holder named.
  await run(tools, 'resource_acquire', { key: 'screen:focus', reason: 'taking the mouse' }, {
    agent: { session: { id: 'session-holder' } },
  })
  const blocked = guards[0](exec)
  assert.equal(typeof blocked, 'string', 'a conflicting holder must be refused in observe mode')
  assert.match(blocked, /session-holder/)
  assert.match(blocked, /\d+s left/)

  fs.rmSync(root, { recursive: true, force: true })
})

test('[v1 regression] the string form keeps L-STRICT semantics: no lease is taken for the caller', async () => {
  const root = tmpRoot()
  const { ctx, guards, hooks } = makeCtx()
  apply(ctx, { lockRoot: root, defaultTtlMs: 5000, protectedTools: { type_text: 'screen:focus' } })
  const exec = { name: 'type_text', agent: { session: { id: 'session-v1' } } }

  // The new hook must not quietly start acquiring leases for v1 config.
  const { result, nextCalls } = await runGate(hooks, exec)
  assert.equal(result.kind, 'allow', 'the hook itself does not decide for v1 config')
  assert.equal(nextCalls, 1)
  assert.deepEqual(lockFiles(root), [], 'a v1 string entry must not create a lease on its own')

  // ...and the guard still refuses, byte-for-byte as before.
  const denied = guards[0](exec)
  assert.equal(typeof denied, 'string', 'v1 L-strict must still deny an unheld protected tool')
  assert.match(denied, /screen:focus/)
  assert.match(denied, /requires the resource "screen:focus", which you do not hold\./)

  fs.rmSync(root, { recursive: true, force: true })
})

test('a tool that is not in protectedTools always passes, with zero side effects', async () => {
  const root = tmpRoot()
  const { ctx, hooks } = makeCtx()
  apply(ctx, autoConfig(root))
  const { result, nextCalls } = await runGate(hooks, { name: 'read_file', agent: { session: { id: 's-any' } } })
  assert.equal(result.kind, 'allow')
  assert.equal(nextCalls, 1)
  assert.deepEqual(lockFiles(root), [])

  fs.rmSync(root, { recursive: true, force: true })
})

test('an EXPIRED foreign lease does not turn into a permanent denial', async () => {
  const root = tmpRoot()
  fs.mkdirSync(root, { recursive: true })
  // A lease from a process that died: expired, still on disk.
  fs.writeFileSync(path.join(root, 'screen_focus.lock'), JSON.stringify({
    id: 'lz_expired00001',
    key: 'screen:focus',
    facet: 'screen:focus',
    facets: ['screen:focus'],
    mode: 'exclusive',
    owner: 'session-dead',
    reason: 'crashed mid-click',
    pid: 999999,
    host: os.hostname(),
    createdAt: Date.now() - 60000,
    expiresAt: Date.now() - 30000,
  }))
  const { ctx, hooks } = makeCtx()
  apply(ctx, autoConfig(root))

  const { result } = await runGate(hooks, { name: 'click', agent: { session: { id: 'session-next' } } })
  assert.equal(result.kind, 'allow', 'an expired lease is takeable, so it must not refuse the call for ever')
  const meta = readLock(root, 'screen_focus')
  assert.equal(meta.owner, 'session-next', 'the expired lease must be replaced by ours')

  fs.rmSync(root, { recursive: true, force: true })
})

test('an auto lease is RELEASED when the call does not run (deny, throw, or cancel)', async () => {
  const root = tmpRoot()

  // (a) the rest of the pipeline denies -> our lease must not survive
  {
    const { ctx, hooks } = makeCtx()
    apply(ctx, autoConfig(root))
    const { result } = await runGate(hooks, { name: 'click', agent: { session: { id: 's-a' } } }, { kind: 'deny', reason: 'policy' })
    assert.equal(result.kind, 'deny')
    assert.deepEqual(lockFiles(root), [], 'a denied call must not leave a lease behind')
  }

  // (b) the rest of the pipeline throws -> deny, and no ghost lease
  {
    const { ctx, hooks } = makeCtx()
    apply(ctx, autoConfig(root))
    const handler = hooks.get('tools/pre-execute')
    const result = await handler({ name: 'click', agent: { session: { id: 's-b' } } }, async () => {
      throw new Error('downstream gate exploded')
    })
    assert.equal(result.kind, 'deny', 'an exception must fail CLOSED and deny the call')
    assert.match(result.reason, /failed closed|refused/i)
    assert.deepEqual(lockFiles(root), [], 'a crashed pipeline must not leave a ghost lease')
  }

  // (c) an already-aborted call is cancelled before anything is acquired
  {
    const { ctx, hooks } = makeCtx()
    apply(ctx, autoConfig(root))
    const controller = new AbortController()
    controller.abort()
    const { result, nextCalls } = await runGate(hooks, { name: 'click', agent: { session: { id: 's-c' } }, signal: controller.signal })
    assert.equal(result.kind, 'cancel')
    assert.equal(nextCalls, 0)
    assert.deepEqual(lockFiles(root), [], 'a cancelled call must not acquire anything')
  }

  // (d) `ask` KEEPS the lease on purpose. The hook cannot see how approval turns
  // out; releasing before the answer would make the L-strict guard refuse an
  // APPROVED call. The residue is bounded by ttlMs and is reused by the next call.
  {
    const { ctx, guards, hooks } = makeCtx()
    apply(ctx, autoConfig(root))
    const exec = { name: 'click', agent: { session: { id: 's-d' } } }
    const { result } = await runGate(hooks, exec, { kind: 'ask', reason: 'needs approval' })
    assert.equal(result.kind, 'ask', 'the ask decision must be passed through unchanged')
    assert.equal(lockFiles(root).length, 1, 'ask keeps the lease so an approved call still passes the guard')
    assert.equal(guards[0](exec), undefined, 'the guard must let the approved call through')
  }

  fs.rmSync(root, { recursive: true, force: true })
})

test('[safety baseline] two agents both relying on auto-acquire: exactly one wins', async () => {
  // This is the case that a naive "free means allow" design gets wrong: with both
  // agents undeclared, one must win the lease and the other must be refused.
  const root = tmpRoot()
  const { ctx, hooks } = makeCtx()
  apply(ctx, autoConfig(root))

  const a = await runGate(hooks, { name: 'click', agent: { session: { id: 'session-A' } } })
  const b = await runGate(hooks, { name: 'click', agent: { session: { id: 'session-B' } } })

  assert.equal(a.result.kind, 'allow')
  assert.equal(b.result.kind, 'deny', 'the second agent must NOT also be allowed in')
  assert.match(b.result.reason, /session-A/)
  assert.equal(lockFiles(root).length, 1, 'exactly one lease may exist')
  assert.equal(readLock(root, 'screen_focus').owner, 'session-A')

  fs.rmSync(root, { recursive: true, force: true })
})
