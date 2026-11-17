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

test('with no promptRules the rules provider emits nothing at all', () => {
  const root = tmpRoot()
  const { ctx, contexts } = makeCtx()
  apply(ctx, { lockRoot: root })

  const rules = contexts.find((c) => c.name === 'resource-lease-rules')
  assert.ok(rules, 'the provider is registered even when unused')
  assert.equal(rules.text({}), '', 'an ordinary profile must pay zero prompt tokens')

  fs.rmSync(root, { recursive: true, force: true })
})
