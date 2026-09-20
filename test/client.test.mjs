/**
 * Tests for the browser half.
 *
 * The bundle is loaded through the page's own module mechanism (a
 * `window.__ModuleLoader__.load` call) so the two declarations that have to agree
 * — the service list this module injects and the package list in `package.json` —
 * are exercised rather than assumed.
 *
 * @module llm-for-dsh/test/client.test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** A React stand-in: enough for the element tree and the hooks the page calls. */
function fakeReact() {
  class Component {
    constructor(props) {
      this.props = props
    }

    render() {
      return null
    }
  }
  return {
    Component,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
}

/**
 * Load one bundle source the way the page does.
 * @param source - the bundle text.
 * @returns the registered module id plus its exports.
 */
function loadBundle(source) {
  const captured = { id: undefined, factory: undefined }
  const window = {
    __ModuleLoader__: {
      load: (spec) => {
        captured.id = spec.id
        captured.factory = spec.factory
      },
    },
  }
  const require = (name) => {
    if (name === 'react') return fakeReact()
    if (name === '@deepseek-ai/dsh-client-ui-settings') return {}
    throw new Error('unexpected require: ' + name)
  }
  const styles = { insert: () => () => {} }
  new Function('window', 'require', 'styles', source)(window, require, styles)
  return { id: captured.id, exports: captured.factory(require) }
}

/**
 * A context that behaves like the page's.
 * @param provided - the service names this page exposes.
 * @returns the context plus a recorder.
 */
function fakeContext(provided = ['slots', 'settingsScope']) {
  const calls = { slots: [], registered: null, effects: 0, bound: null }
  const services = {
    slots: {
      inject(key, callback) {
        calls.slots.push(key)
        callback()
      },
      register(spec, component) {
        calls.registered = { spec, component }
      },
    },
    settingsScope: {
      bind(spec) {
        calls.bound = spec
        return {
          getSnapshot: () => ({ status: 'ready', value: {}, revision: 1, writable: true, mode: 'host' }),
          subscribe: () => () => {},
          set: () => Promise.resolve(),
          unset: () => Promise.resolve(),
          mutate: () => Promise.resolve(),
        }
      },
    },
  }
  const ctx = new Proxy(
    {
      get(name) {
        return provided.includes(name) ? services[name] : undefined
      },
      effect(callback) {
        calls.effects += 1
        callback()
        return () => {}
      },
    },
    {
      // Ported from cordis: a service read through a property that is not part of
      // the context object is precisely what "without inject" means.
      get(target, prop) {
        if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop)
        throw new Error('cannot get property "' + prop + '" without inject')
      },
    },
  )
  return { ctx, calls }
}

test('the bundle registers under the package name with both service declarations', () => {
  const loaded = loadBundle(SOURCE)
  assert.equal(loaded.id, 'llm-for-dsh')
  assert.deepEqual(loaded.exports.inject, ['slots', 'settingsScope'])
  assert.equal(typeof loaded.exports.apply, 'function')
})

test('the embedded catalog drives decoding, and unknown ids are dropped', () => {
  const loaded = loadBundle(SOURCE)
  const defaults = loaded.exports.decodeSection(undefined)
  assert.deepEqual(defaults.enabled, [])
  assert.deepEqual(defaults.hosts, [])
  assert.equal(defaults.diagnostics, false)
  const decoded = loaded.exports.decodeSection({
    enabled: ['responses-reasoning-echo', 'gone'],
    hosts: ['Relay.Example', ''],
    diagnostics: true,
  })
  assert.deepEqual(decoded.enabled, ['responses-reasoning-echo'])
  assert.deepEqual(decoded.hosts, ['Relay.Example'])
  assert.equal(decoded.diagnostics, true)
  assert.equal(decoded.recentTurns, 0)
  assert.equal(decoded.singleReasoningSlot, false)
  assert.equal(decoded.placeholderReasoning, false)
  const options = loaded.exports.decodeSection({ recentTurns: 2, singleReasoningSlot: true, placeholderReasoning: true })
  assert.equal(options.recentTurns, 2)
  assert.equal(options.singleReasoningSlot, true)
  assert.equal(options.placeholderReasoning, true)
})

test('each declared fix option renders one control', () => {
  const loaded = loadBundle(SOURCE)
  const { ctx, calls } = fakeContext()
  loaded.exports.apply(ctx)
  const tree = calls.registered.component()
  const rendered = tree.children[0].type({
    scope: { getSnapshot: () => ({ mode: 'host', value: {} }), subscribe: () => () => {} },
  })
  const classes = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node.props?.className === 'string') classes.push(node.props.className)
    walk(node.children)
  }
  walk(rendered)
  assert.equal(classes.filter((name) => name.includes('llm-compat-subrow')).length, 3)
  assert.equal(classes.filter((name) => name.includes('llm-compat-number')).length, 1)
})

test('activation binds the shared namespace and registers the settings page', () => {
  const loaded = loadBundle(SOURCE)
  const { ctx, calls } = fakeContext()
  loaded.exports.apply(ctx)
  assert.equal(calls.bound.namespace, 'llm-compat')
  assert.deepEqual(calls.slots, ['settings.section'])
  assert.equal(calls.registered.spec.id, 'llm-compat')
  assert.equal(calls.registered.spec.name, 'settings.section')
  assert.equal(calls.effects, 1)
})

test('the registered page renders one checkbox row per fix', () => {
  const loaded = loadBundle(SOURCE)
  const { ctx, calls } = fakeContext()
  loaded.exports.apply(ctx)
  const tree = calls.registered.component()
  // The boundary wraps the page; invoking the page directly exercises the render
  // path without a DOM.
  const page = tree.children[0]
  const rendered = page.type({ scope: { getSnapshot: () => ({ mode: 'host', value: {} }), subscribe: () => () => {} } })
  assert.equal(rendered.type, 'div')
  assert.ok(rendered.children.length >= 3)
})

test('a page without the settings domain still registers, showing current state', () => {
  const loaded = loadBundle(SOURCE)
  const { ctx, calls } = fakeContext(['slots'])
  loaded.exports.apply(ctx)
  assert.deepEqual(calls.slots, ['settings.section'])
})

test('a page without a slot ledger does not fail the plugin load', () => {
  const loaded = loadBundle(SOURCE)
  const { ctx, calls } = fakeContext([])
  loaded.exports.apply(ctx)
  assert.deepEqual(calls.slots, [])
})

test('a throw while the bundle is evaluated degrades to a no-op plugin', () => {
  const broken = SOURCE.replace("const React = require('react')", "throw new Error('bundle broke')")
  assert.notEqual(broken, SOURCE)
  const loaded = loadBundle(broken)
  assert.equal(typeof loaded.exports.apply, 'function')
  assert.deepEqual(loaded.exports.inject, [])
  assert.equal(loaded.exports.loadError, 'bundle broke')
})
