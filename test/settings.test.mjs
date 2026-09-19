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
  assert.equal(resolved.recentTurns, 0)
  assert.equal(resolved.singleReasoningSlot, false)
})

test('the two token-saving options fold to safe values', () => {
  assert.equal(normalizeSettings({ recentTurns: 3 }).recentTurns, 3)
  assert.equal(normalizeSettings({ recentTurns: 0 }).recentTurns, 0)
  assert.equal(normalizeSettings({ recentTurns: -2 }).recentTurns, 0)
  assert.equal(normalizeSettings({ recentTurns: 1.5 }).recentTurns, 0)
  assert.equal(normalizeSettings({ recentTurns: '3' }).recentTurns, 0)
  assert.equal(normalizeSettings({ singleReasoningSlot: true }).singleReasoningSlot, true)
  assert.equal(normalizeSettings({ singleReasoningSlot: 'yes' }).singleReasoningSlot, false)
  // Both are independent, so both may be on at once.
  const both = normalizeSettings({ recentTurns: 1, singleReasoningSlot: true })
  assert.equal(both.recentTurns, 1)
  assert.equal(both.singleReasoningSlot, true)
  assert.deepEqual([...both.enabled], [...DEFAULT_ENABLED])
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
