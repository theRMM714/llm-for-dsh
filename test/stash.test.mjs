/**
 * Unit tests for the turn-to-reasoning index and the two producers that feed it.
 *
 * @module llm-for-dsh/test/stash.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callIdOf, createStash, harnessReasoningByCallId, replayReasoningItems } from '../src/stash.js'

test('a compound tool-call id reduces to the wire call id', () => {
  assert.equal(callIdOf('call_1|fc_1'), 'call_1')
  assert.equal(callIdOf('call_1'), 'call_1')
  assert.equal(callIdOf('|fc_1'), undefined)
  assert.equal(callIdOf(''), undefined)
  assert.equal(callIdOf(42), undefined)
})

test('a turn recorded under a compound id is found by the wire id', () => {
  const stash = createStash()
  stash.record(['call_1|fc_1'], { text: 'thought' })
  assert.deepEqual(stash.lookup('call_1'), { text: 'thought' })
  assert.equal(stash.lookup('call_2'), undefined)
  assert.equal(stash.size(), 1)
})

test('an empty payload is not recorded', () => {
  const stash = createStash()
  stash.record(['call_1'], { text: '   ' })
  stash.record(['call_2'], { items: [] })
  stash.record(['call_3'], null)
  assert.equal(stash.size(), 0)
})

test('an entry expires after the ttl', () => {
  let clock = 0
  const stash = createStash({ ttlMs: 100, now: () => clock })
  stash.record(['call_1'], { text: 'thought' })
  clock = 50
  assert.notEqual(stash.lookup('call_1'), undefined)
  clock = 200
  assert.equal(stash.lookup('call_1'), undefined)
  assert.equal(stash.size(), 0)
})

test('the oldest entries are evicted past the bound', () => {
  const stash = createStash({ maxEntries: 2 })
  stash.record(['call_1'], { text: 'a' })
  stash.record(['call_2'], { text: 'b' })
  stash.record(['call_3'], { text: 'c' })
  assert.equal(stash.size(), 2)
  assert.equal(stash.lookup('call_1'), undefined)
  assert.notEqual(stash.lookup('call_3'), undefined)
})

test('the harness request contributes reasoning text and tool-call ids', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先想一下' },
        { type: 'text', text: 'reading' },
        { type: 'tool-call', id: 'call_1|fc_1', name: 'read', arguments: {} },
      ],
      source: {
        kind: 'model',
        provider: 'sa4',
        model: 'deepseek-v4.1-flash',
        replayState: {
          response: { kind: 'pi-ai', version: 2, api: 'openai-responses', provider: 'sa4', model: 'deepseek-v4.1-flash', stopReason: 'toolUse' },
          blocks: [
            { type: 'reasoning', thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '先想一下' }] }) },
            { type: 'text' },
            { type: 'tool-call' },
          ],
        },
      },
    },
    { role: 'assistant', content: [{ type: 'text', text: 'no tools here' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_2', name: 'write', arguments: {} }] },
  ]
  const found = harnessReasoningByCallId(messages)
  assert.equal(found.length, 2)
  assert.deepEqual(found[0].callIds, ['call_1|fc_1'])
  assert.equal(found[0].payload.text, '先想一下')
  assert.equal(found[0].payload.items.length, 1)
  assert.equal(found[1].callIds[0], 'call_2')
  assert.equal(found[1].payload.items, undefined)
  assert.equal(found[1].payload.text, '')
})

test('a message with nothing usable still contributes its call ids', () => {
  const found = harnessReasoningByCallId([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1' }] },
  ])
  assert.equal(found.length, 1)
  assert.deepEqual(found[0].payload, { items: undefined, text: '' })
})

test('a malformed harness request yields nothing instead of throwing', () => {
  assert.deepEqual(harnessReasoningByCallId(undefined), [])
  assert.deepEqual(harnessReasoningByCallId([null, 'x', { role: 'assistant' }]), [])
})

test('only a parseable signature from a reasoning block becomes an item', () => {
  assert.equal(replayReasoningItems(undefined), undefined)
  assert.equal(replayReasoningItems({ blocks: 'nope' }), undefined)
  assert.equal(replayReasoningItems({ blocks: [{ type: 'reasoning' }] }), undefined)
  assert.equal(replayReasoningItems({ blocks: [{ type: 'reasoning', thinkingSignature: '{oops' }] }), undefined)
  assert.equal(replayReasoningItems({ blocks: [{ type: 'reasoning', thinkingSignature: '{"type":"text"}' }] }), undefined)
  const item = { type: 'reasoning', id: 'rs_1' }
  assert.deepEqual(replayReasoningItems({ blocks: [{ type: 'reasoning', thinkingSignature: JSON.stringify(item) }] }), [item])
})
