/**
 * Host-half wiring tests: the settings namespace is registered, the request
 * observer is attached to `llm/stream`, the interceptor is installed and
 * removable, and a profile without a settings service still activates.
 *
 * The point is the WIRING, not the fix logic — a namespace that is never
 * registered leaves the settings page silently read-only, which is exactly the
 * kind of half-initialised plugin these tests exist to catch.
 *
 * @module llm-for-dsh/test/host.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, NAMESPACE, normalizeSettings, setup } from '../src/index.js'
import { DEFAULT_ENABLED } from '../src/fixes/index.js'

/** The harness request one observed step carries. */
const MESSAGES = [
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '先想一下' },
      { type: 'tool-call', id: 'call_1|fc_1', name: 'read', arguments: {} },
    ],
  },
]

/**
 * A context that records everything the Host half does.
 * @param options - `{ withSettings }` to exercise a profile without a settings service.
 * @returns the context plus the recorder.
 */
function fakeContext(options = {}) {
  const withSettings = options.withSettings !== false
  const calls = { registered: null, effects: [], listeners: [], watchListeners: new Set() }
  let value = options.settings ?? {}

  const scope = {
    get: () => value,
    watch(listener) {
      calls.watchListeners.add(listener)
      return () => calls.watchListeners.delete(listener)
    },
  }
  const settings = withSettings
    ? {
        register(namespace, schema, spec) {
          calls.registered = { namespace, schema, spec }
          return scope
        },
        update() {},
      }
    : undefined

  const ctx = {
    settings,
    get: (name) => (name === 'settings' ? settings : undefined),
    effect(callback) {
      calls.effects.push(callback())
      return () => {}
    },
    on(name, listener, options) {
      calls.listeners.push({ name, listener, options })
      return () => {}
    },
    /** Drive the settings document the way the service would. */
    publish(next) {
      value = next
      for (const listener of calls.watchListeners) listener(next)
    },
  }
  return { ctx, calls }
}

/**
 * Activate the plugin, dispose every effect afterwards, and prove the process
 * was left as it was found.
 * @param options - activation options plus the fake-context options.
 * @param run - the assertions to make while the plugin is active.
 */
function withPlugin(options, run) {
  const originalFetch = globalThis.fetch
  const { ctx, calls } = fakeContext(options)
  const plugin = setup(ctx, options.entry ?? {})
  try {
    run({ plugin, ctx, calls })
  } finally {
    for (const dispose of calls.effects) if (typeof dispose === 'function') dispose()
    globalThis.fetch = originalFetch
  }
}

test('activation registers the namespace, the observer and the interceptor', () => {
  withPlugin({}, ({ plugin, calls }) => {
    assert.equal(calls.registered.namespace, NAMESPACE)
    assert.equal(calls.registered.schema, Config)
    assert.equal(calls.registered.spec.applies, 'live')
    assert.deepEqual(calls.listeners.map((entry) => entry.name), ['llm/stream'])
    assert.deepEqual(calls.listeners[0].options, { global: true })
    assert.equal(calls.watchListeners.size, 1, 'the settings scope must be watched')
  })
})

test('the interceptor is installed, and disposal restores the original fetch', () => {
  const originalFetch = globalThis.fetch
  const { ctx, calls } = fakeContext()
  const plugin = setup(ctx, {})
  assert.notEqual(globalThis.fetch, originalFetch, 'the interceptor must be installed')
  for (const dispose of calls.effects) if (typeof dispose === 'function') dispose()
  assert.equal(globalThis.fetch, originalFetch, 'disposal must restore the original fetch')
  assert.equal(plugin.stash.size(), 0)
})

test('the request observer indexes a step and returns the downstream stream untouched', () => {
  withPlugin({}, ({ plugin, calls }) => {
    const downstream = { marker: 'stream' }
    const returned = calls.listeners[0].listener({ messages: MESSAGES }, () => downstream)
    assert.equal(returned, downstream)
    assert.equal(plugin.stash.size(), 1)
    assert.deepEqual(plugin.stash.lookup('call_1'), { items: undefined, text: '先想一下' })
  })
})

test('an observation failure never breaks the model call', () => {
  withPlugin({}, ({ calls, plugin }) => {
    const downstream = { marker: 'stream' }
    // An array whose first index throws while it is iterated: the observer has to
    // contain that, because the request it is reading belongs to a live call.
    const explosive = []
    Object.defineProperty(explosive, 0, {
      get() {
        throw new Error('observation exploded')
      },
    })
    explosive.length = 1
    const returned = calls.listeners[0].listener({ messages: explosive }, () => downstream)
    assert.equal(returned, downstream)
    assert.equal(plugin.stash.size(), 0)
  })
})

test('the settings document is adopted live', () => {
  withPlugin({}, ({ plugin, ctx }) => {
    assert.deepEqual([...plugin.state.current.enabled], [...DEFAULT_ENABLED])
    ctx.publish({ enabled: ['responses-reasoning-echo'], hosts: ['Relay.Example'], diagnostics: true })
    assert.deepEqual([...plugin.state.current.enabled], ['responses-reasoning-echo'])
    assert.deepEqual(plugin.state.current.hosts, ['relay.example'])
    assert.equal(plugin.state.current.diagnostics, true)
  })
})

test('a profile without a settings service still activates', () => {
  withPlugin({ withSettings: false, entry: { enabled: ['responses-reasoning-echo'] } }, ({ plugin, calls }) => {
    assert.equal(calls.registered, null)
    assert.deepEqual([...plugin.state.current.enabled], ['responses-reasoning-echo'])
  })
})

test('the fold ignores an id this build no longer ships', () => {
  const settings = normalizeSettings({ enabled: ['responses-reasoning-echo', 'retired'] })
  assert.deepEqual([...settings.enabled], ['responses-reasoning-echo'])
})
