/**
 * Tests for the settings contract: the schema a fresh profile resolves, the
 * unfold from runtime references to plain values, and the fold the interceptor
 * reads on every request.
 *
 * @module llm-for-dsh/test/settings.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, NAMESPACE, normalizeSettings, readConfig } from '../src/index.js'
import { serializeCatalog } from '../scripts/build.mjs'
import { DEFAULT_ENABLED } from '../src/fixes/index.js'

test('the settings entry is the one the client half edits', () => {
  assert.equal(NAMESPACE, 'llm-compat')
})

test('every editable field resolves to a runtime reference', () => {
  const resolved = Config({})
  const fields = [
    'enabled',
    'hosts',
    'diagnostics',
    'recentTurns',
    'singleReasoningSlot',
    'placeholderReasoning',
    'reasoningTextOnly',
    'retries',
    'retryAttempts',
  ]
  for (const field of fields) {
    assert.equal(typeof resolved[field]?.get, 'function', field + ' must resolve to a reference')
  }
})

test('an empty entry resolves through the schema defaults', () => {
  const resolved = readConfig(Config({}))
  assert.deepEqual([...resolved.enabled], [...DEFAULT_ENABLED])
  assert.deepEqual([...resolved.hosts], [])
  assert.equal(resolved.diagnostics, false)
  assert.equal(resolved.recentTurns, 0)
  assert.equal(resolved.singleReasoningSlot, false)
  assert.equal(resolved.placeholderReasoning, false)
  assert.equal(resolved.reasoningTextOnly, false)
  assert.deepEqual([...resolved.retries], [])
  assert.equal(resolved.retryAttempts, 2)
})

test('an entry that sets a field keeps that value', () => {
  const resolved = readConfig(Config({ enabled: ['responses-reasoning-echo'], hosts: ['Relay.Example'], diagnostics: true }))
  assert.deepEqual([...resolved.enabled], ['responses-reasoning-echo'])
  assert.deepEqual([...resolved.hosts], ['Relay.Example'])
  assert.equal(resolved.diagnostics, true)
})

test('plain values and references read the same way', () => {
  const plain = readConfig({ diagnostics: true, retryAttempts: 3 })
  const referenced = readConfig({ diagnostics: { get: () => true }, retryAttempts: { get: () => 3 } })
  assert.equal(plain.diagnostics, true)
  assert.equal(referenced.diagnostics, true)
  assert.equal(plain.retryAttempts, 3)
  assert.equal(referenced.retryAttempts, 3)
  // A missing member and a non-object config both unfold to absent fields.
  assert.equal(readConfig(undefined).diagnostics, undefined)
  assert.equal(readConfig({}).recentTurns, undefined)
})

test('the retry options fold to safe values', () => {
  const enabled = normalizeSettings({ retries: ['reasoning-text-not-passed-back', 'gone'] })
  assert.deepEqual([...enabled.retries], ['reasoning-text-not-passed-back'])
  // A rule this build does not ship is dropped, exactly like a fix id.
  assert.equal(normalizeSettings({ retries: ['gone'] }).retries.size, 0)
  assert.equal(normalizeSettings({}).retryAttempts, 2)
  assert.equal(normalizeSettings({ retryAttempts: 0 }).retryAttempts, 0)
  assert.equal(normalizeSettings({ retryAttempts: 3 }).retryAttempts, 3)
  assert.equal(normalizeSettings({ retryAttempts: 99 }).retryAttempts, 5)
  assert.equal(normalizeSettings({ retryAttempts: 1.5 }).retryAttempts, 2)
})

test('the token-saving options fold to safe values', () => {
  assert.equal(normalizeSettings({ recentTurns: 3 }).recentTurns, 3)
  assert.equal(normalizeSettings({ recentTurns: 0 }).recentTurns, 0)
  assert.equal(normalizeSettings({ recentTurns: -2 }).recentTurns, 0)
  assert.equal(normalizeSettings({ recentTurns: 1.5 }).recentTurns, 0)
  assert.equal(normalizeSettings({ recentTurns: '3' }).recentTurns, 0)
  assert.equal(normalizeSettings({ singleReasoningSlot: true }).singleReasoningSlot, true)
  assert.equal(normalizeSettings({ singleReasoningSlot: 'yes' }).singleReasoningSlot, false)
  assert.equal(normalizeSettings({ placeholderReasoning: true }).placeholderReasoning, true)
  assert.equal(normalizeSettings({ placeholderReasoning: 'yes' }).placeholderReasoning, false)
  assert.equal(normalizeSettings({ reasoningTextOnly: true }).reasoningTextOnly, true)
  assert.equal(normalizeSettings({ reasoningTextOnly: 'yes' }).reasoningTextOnly, false)
  assert.equal(normalizeSettings({}).placeholderReasoning, false)
  // They are independent, so several may be on at once.
  const both = normalizeSettings({ recentTurns: 1, singleReasoningSlot: true })
  assert.equal(both.recentTurns, 1)
  assert.equal(both.singleReasoningSlot, true)
  assert.deepEqual([...both.enabled], [...DEFAULT_ENABLED])
})

test('an id this build does not ship is dropped', () => {
  const settings = normalizeSettings({ enabled: ['responses-reasoning-echo', 'gone', 7] })
  assert.deepEqual([...settings.enabled], ['responses-reasoning-echo'])
})

test('the embedded catalog defaults every editable field', () => {
  // The browser bundle carries its own copy of the defaults, restated in
  // scripts/build.mjs because the build must not import the Host entry. This is
  // the guard that keeps the two in step.
  const catalog = JSON.parse(serializeCatalog())
  const fields = Object.keys(Config.dict ?? {})
  assert.ok(fields.length > 0, 'the schema must expose its fields')
  for (const field of fields) {
    assert.ok(field in catalog.defaults, field + ' must have an embedded default')
  }
})

test('a malformed value falls back instead of disabling the plugin', () => {
  assert.deepEqual([...normalizeSettings(undefined).enabled], [...DEFAULT_ENABLED])
  assert.deepEqual([...normalizeSettings(null).hosts], [])
  assert.equal(normalizeSettings({ diagnostics: 'yes' }).diagnostics, false)
  assert.deepEqual([...normalizeSettings({ enabled: 'nope' }).enabled], [...DEFAULT_ENABLED])
})

test('hosts are normalized and de-duplicated on read', () => {
  const settings = normalizeSettings({ hosts: ['HTTPS://Relay.Example/v1/', 'relay.example'] })
  assert.deepEqual(settings.hosts, ['relay.example'])
})
