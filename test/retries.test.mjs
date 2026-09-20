/**
 * Unit tests for the retry catalog and its one rule.
 *
 * The rule is deliberately narrow: one status code plus two phrases that must
 * appear TOGETHER, so an unrelated 400 can never trigger a re-send.
 *
 * @module llm-for-dsh/test/retries.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_RETRY_RULES, describeRetries, RETRIES, retryById } from '../src/retries/index.js'
import { matches, metadata } from '../src/retries/reasoning-text-not-passed-back.js'

/** The refusal the relay actually returned. */
const RELAY_BODY = '{"error":{"message":"The `reasoning_text` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}}'

test('the rule claims exactly the pass-back refusal', () => {
  assert.equal(matches({ status: 400, bodyText: RELAY_BODY, url: 'https://relay.example/v1/responses' }), true)
  // Both phrases are required.
  assert.equal(matches({ status: 400, bodyText: 'reasoning_text' }), false)
  assert.equal(matches({ status: 400, bodyText: 'must be passed back' }), false)
  // Only a 400 counts.
  assert.equal(matches({ status: 500, bodyText: RELAY_BODY }), false)
  assert.equal(matches({ status: 200, bodyText: RELAY_BODY }), false)
  // Malformed contexts never match and never throw.
  assert.equal(matches(undefined), false)
  assert.equal(matches({ status: 400 }), false)
  assert.equal(matches({ status: 400, bodyText: 42 }), false)
})

test('the catalog is one rule, off by default and addressable by id', () => {
  assert.deepEqual(RETRIES.map((rule) => rule.id), ['reasoning-text-not-passed-back'])
  assert.deepEqual(DEFAULT_RETRY_RULES, [])
  assert.equal(metadata.defaultEnabled, false)
  assert.equal(retryById('reasoning-text-not-passed-back').matches({ status: 400, bodyText: RELAY_BODY }), true)
  assert.equal(retryById('gone'), undefined)
})

test('the embedded half carries the copy the settings page renders', () => {
  const described = describeRetries()
  assert.equal(described.length, 1)
  assert.equal(described[0].id, 'reasoning-text-not-passed-back')
  assert.equal(typeof described[0].title, 'string')
  assert.equal(typeof described[0].hint, 'string')
  assert.equal(described[0].defaultEnabled, false)
})
