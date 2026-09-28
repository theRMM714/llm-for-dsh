/**
 * Host-half wiring tests: the settings policy is declared, the request observer
 * is attached to \`llm/stream\`, the interceptor is installed and removable, and a
 * profile without a settings service still activates.
 *
 * The point is the WIRING, not the fix logic — a settings entry that is never
 * offered to the form service leaves the page permanently inactive, which is
 * exactly the kind of half-initialised plugin these tests exist to catch.
 *
 * @module llm-for-dsh/test/host.test
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_ENABLED } from '../src/fixes/index.js'
import { setup } from '../src/index.js'

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
 * A resolved config whose members are runtime references, the way the loader
 * builds one: the plugin reads \`get()\` and the owner replaces the value.
 *
 * @param initial - starting values.
 * @returns the config plus a setter that replaces one referenced value.
 */
function referencedConfig(initial = {}) {
  const values = { ...initial }
  const config = {}
  for (const key of Object.keys(values)) config[key] = { get: () => values[key] }
  return {
    config,
    /** Replace one member's value, as a settings edit would. */
    set(key, value) {
      values[key] = value
      config[key] = { get: () => values[key] }
    },
  }
}

/**
 * A context that records everything the Host half does.
 * @param options - \`{ withSettings, withWebServer }\` to exercise a profile missing a service.
 * @returns the context plus the recorder.
 */
function fakeContext(options = {}) {
  const withSettings = options.withSettings !== false
  const fiber = { marker: 'fiber' }
  const calls = { fiber, configured: [], effects: [], listeners: [], routes: [] }

  const settings = withSettings
    ? {
        configure(presentation, owner) {
          calls.configured.push({ presentation, owner })
          return () => {}
        },
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
    fiber,
    get: (name) => {
      if (name === 'settings') return settings
      if (name === 'webServer') return webServer
      return undefined
    },
    /**
     * The optional child scopes the plugin reaches services through. Each one
     * runs only when its service exists, exactly like the loader's own gating.
     */
    inject(names, callback) {
      const child = (service) => ({
        ...service,
        effect(cb) {
          calls.effects.push(cb())
          return () => {}
        },
      })
      if (names.includes('settings') && settings !== undefined) callback(child({ settings }))
      if (names.includes('webServer') && webServer !== undefined) callback(child({ webServer }))
    },
    effect(callback) {
      calls.effects.push(callback())
      return () => {}
    },
    on(name, listener, options) {
      calls.listeners.push({ name, listener, options })
      return () => {}
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
  const plugin = setup(ctx, options.config ?? {})
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

test('activation declares the settings policy, the observer and the interceptor', async () => {
  await withPlugin({}, ({ calls }) => {
    assert.equal(calls.configured.length, 1, 'the plugin must ask the settings service for its policy')
    assert.deepEqual(calls.configured[0].presentation, { auto: false })
    assert.equal(calls.configured[0].owner, calls.fiber)
    assert.deepEqual(calls.listeners.map((entry) => entry.name), ['llm/stream'])
    assert.deepEqual(calls.listeners[0].options, { global: true })
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

test('a settings edit is visible on the next fold', () => {
  const live = referencedConfig({ diagnostics: false })
  const { ctx } = fakeContext()
  const plugin = setup(ctx, live.config)
  assert.deepEqual([...plugin.current().enabled], [...DEFAULT_ENABLED])
  assert.equal(plugin.current().diagnostics, false)

  live.set('enabled', ['responses-reasoning-echo'])
  live.set('hosts', ['Relay.Example'])
  live.set('diagnostics', true)

  assert.deepEqual([...plugin.current().enabled], ['responses-reasoning-echo'])
  assert.deepEqual(plugin.current().hosts, ['relay.example'])
  assert.equal(plugin.current().diagnostics, true)
})

test('a profile without a settings service still activates', async () => {
  await withPlugin({ withSettings: false, config: { enabled: ['responses-reasoning-echo'] } }, ({ plugin, calls }) => {
    assert.deepEqual(calls.configured, [])
    assert.deepEqual([...plugin.current().enabled], ['responses-reasoning-echo'])
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
