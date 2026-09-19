/**
 * Tests for the settings contract: the schema a fresh install resolves, and the
 * fold the interceptor reads on every request.
 *
 * @module llm-for-dsh/test/settings.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, NAMESPACE, normalizeSettings } from '../src/index.js'
import { DEFAULT_ENABLED } from '../src/fixes/index.js'

test('the namespace is the one the client half writes', () => {
  assert.equal(NAMESPACE, 'llm-compat')
})

test('an empty document resolves through the schema defaults', () => {
  const resolved = Config({})
  assert.deepEqual([...resolved.enabled], [...DEFAULT_ENABLED])
  assert.deepEqual([...resolved.hosts], [])
  assert.equal(resolved.diagnostics, false)
})

test('a stored document keeps the values it sets', () => {
  const resolved = Config({ enabled: ['responses-reasoning-echo'], hosts: ['Relay.Example'], diagnostics: true })
  assert.deepEqual([...resolved.enabled], ['responses-reasoning-echo'])
  assert.deepEqual([...resolved.hosts], ['Relay.Example'])
  assert.equal(resolved.diagnostics, true)
})

test('an id this build does not ship is dropped', () => {
  const settings = normalizeSettings({ enabled: ['responses-reasoning-echo', 'gone', 7] })
  assert.deepEqual([...settings.enabled], ['responses-reasoning-echo'])
})

test('a malformed section falls back instead of disabling the plugin', () => {
  assert.deepEqual([...normalizeSettings(undefined).enabled], [...DEFAULT_ENABLED])
  assert.deepEqual([...normalizeSettings(null).hosts], [])
  assert.equal(normalizeSettings({ diagnostics: 'yes' }).diagnostics, false)
  assert.deepEqual([...normalizeSettings({ enabled: 'nope' }).enabled], [...DEFAULT_ENABLED])
})

test('hosts are normalized and de-duplicated on read', () => {
  const settings = normalizeSettings({ hosts: ['HTTPS://Relay.Example/v1/', 'relay.example'] })
  assert.deepEqual(settings.hosts, ['relay.example'])
})
