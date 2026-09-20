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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const calls = { registered: null, effects: [], listeners: [], watchListeners: new Set(), routes: [] }
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

  const webServer = options.withWebServer === false
    ? undefined
    : {
        register(spec) {
          calls.routes.push(spec)
          return () => {}
        },
      }

  const ctx = {
    settings,
    get: (name) => {
      if (name === 'settings') return settings
      if (name === 'webServer') return webServer
      return undefined
    },
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

/** Drive one registered route with a minimal req/res pair. */
async function callRoute(route, url) {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(text) {
      this.body = text
    },
  }
  await route.handler({ url }, res)
  return { status: res.statusCode, headers: res.headers, body: res.body.length === 0 ? undefined : JSON.parse(res.body) }
}

/**
 * Activate the plugin, dispose every effect afterwards, and prove the process
 * was left as it was found.
 * @param options - activation options plus the fake-context options.
 * @param run - the assertions to make while the plugin is active.
 */
async function withPlugin(options, run) {
  const originalFetch = globalThis.fetch
  const originalHome = process.env.DSH_HOME
  // The Host half writes into the harness home; a test must not touch the real one.
  const home = mkdtempSync(join(tmpdir(), 'llm-compat-host-'))
  process.env.DSH_HOME = home
  const { ctx, calls } = fakeContext(options)
  const plugin = setup(ctx, options.entry ?? {})
  try {
    await run({ plugin, ctx, calls })
  } finally {
    for (const dispose of calls.effects) if (typeof dispose === 'function') dispose()
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  }
}

test('activation registers the namespace, the observer and the interceptor', async () => {
  await withPlugin({}, ({ plugin, calls }) => {
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

test('the request observer indexes a step and returns the downstream stream untouched', async () => {
  await withPlugin({}, ({ plugin, calls }) => {
    const downstream = { marker: 'stream' }
    const returned = calls.listeners[0].listener({ messages: MESSAGES }, () => downstream)
    assert.equal(returned, downstream)
    assert.equal(plugin.stash.size(), 1)
    assert.deepEqual(plugin.stash.lookup('call_1'), { items: undefined, text: '先想一下' })
  })
})

test('an observation failure never breaks the model call', async () => {
  await withPlugin({}, ({ calls, plugin }) => {
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

test('the settings document is adopted live', async () => {
  await withPlugin({}, ({ plugin, ctx }) => {
    assert.deepEqual([...plugin.state.current.enabled], [...DEFAULT_ENABLED])
    ctx.publish({ enabled: ['responses-reasoning-echo'], hosts: ['Relay.Example'], diagnostics: true })
    assert.deepEqual([...plugin.state.current.enabled], ['responses-reasoning-echo'])
    assert.deepEqual(plugin.state.current.hosts, ['relay.example'])
    assert.equal(plugin.state.current.diagnostics, true)
  })
})

test('a profile without a settings service still activates', async () => {
  await withPlugin({ withSettings: false, entry: { enabled: ['responses-reasoning-echo'] } }, ({ plugin, calls }) => {
    assert.equal(calls.registered, null)
    assert.deepEqual([...plugin.state.current.enabled], ['responses-reasoning-echo'])
  })
})

test('the log route answers with the paths and empties both files on request', async () => {
  await withPlugin({ withSettings: false }, async ({ calls }) => {
    const route = calls.routes.find((entry) => entry.path === '/llm-compat/log')
    assert.notEqual(route, undefined)
    assert.equal(route.kind, 'exact')

    const answer = await callRoute(route, '/llm-compat/log')
    assert.equal(answer.status, 200)
    assert.match(answer.body.log, /llm-compat\.log$/)
    assert.match(answer.body.rejected, /llm-compat-rejected\.jsonl$/)

    const cleared = await callRoute(route, '/llm-compat/log?action=clear')
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.body.cleared.length, 2)
    assert.equal(cleared.body.ok, true)
  })
})

test('a profile without a webserver service registers no route', async () => {
  await withPlugin({ withWebServer: false }, ({ calls }) => {
    assert.deepEqual(calls.routes, [])
  })
})

test('the fold ignores an id this build no longer ships', () => {
  const settings = normalizeSettings({ enabled: ['responses-reasoning-echo', 'retired'] })
  assert.deepEqual([...settings.enabled], ['responses-reasoning-echo'])
})
