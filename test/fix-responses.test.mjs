/**
 * Unit tests for the Responses reasoning-echo fix: the wire-body rewrite that
 * inserts the missing reasoning item, and the response observer that records the
 * original item for the next request.
 *
 * @module llm-for-dsh/test/fix-responses.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createResponseObserver,
  metadata,
  observes,
  requestMatcher,
  rewrite,
  synthesizeReasoningItem,
} from '../src/fixes/responses-reasoning-echo.js'
import { createStash } from '../src/stash.js'

const RESPONSES = 'https://relay.example/v1/responses'

/** A stash already holding one turn's reasoning text. */
function stashWithText(callIds, text) {
  const stash = createStash()
  stash.record(callIds, { text })
  return stash
}

/** One assistant turn as the wire body carries it: a tool call with no reasoning item. */
function turn(callId, extra) {
  return [
    { type: 'function_call', id: 'fc_' + callId, call_id: callId, name: 'read', arguments: '{}' },
    ...(extra ?? []),
    { type: 'function_call_output', call_id: callId, output: 'ok' },
  ]
}

test('the matcher owns only the Responses endpoint', () => {
  assert.equal(requestMatcher(RESPONSES, { input: [] }), true)
  assert.equal(requestMatcher(RESPONSES + '?x=1', { input: [] }), true)
  assert.equal(requestMatcher('https://relay.example/v1/chat/completions', { input: [] }), false)
  assert.equal(requestMatcher(RESPONSES, { messages: [] }), false)
  assert.equal(requestMatcher('not a url', { input: [] }), false)
  assert.equal(observes(RESPONSES), true)
  assert.equal(observes('https://relay.example/v1/chat/completions'), false)
})

test('the reasoning item lands at the start of the turn, before the assistant text', () => {
  // Wire order for one turn: reasoning, assistant message, function_call. A fix
  // that inserted immediately before the tool call would produce message,
  // reasoning, function_call — the order a gateway rejects.
  const body = {
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working on it' }] },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  }
  const stash = stashWithText(['call_1'], 'thought')
  assert.equal(rewrite(body, { stash }), 1)
  assert.deepEqual(body.input.map((item) => item.type), ['reasoning', 'function_call', 'message', 'function_call_output'])
})

test('an assistant message that opens a turn keeps the reasoning item before it', () => {
  const body = {
    input: [
      { type: 'message', role: 'user', content: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'text first' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
    ],
  }
  const stash = stashWithText(['call_1'], 'thought')
  assert.equal(rewrite(body, { stash }), 1)
  assert.deepEqual(body.input.map((item) => item.type), ['message', 'reasoning', 'message', 'function_call'])
  assert.equal(body.input[1].type, 'reasoning')
})

test('injects the recovered reasoning text before the tool call', () => {
  const body = { model: 'm', input: [{ type: 'message', role: 'user', content: [] }, ...turn('call_1')] }
  const inserted = rewrite(body, { stash: stashWithText(['call_1'], '先想一下') })
  assert.equal(inserted, 1)
  assert.deepEqual(body.input.map((item) => item.type), ['message', 'reasoning', 'function_call', 'function_call_output'])
  const reasoning = body.input[1]
  assert.deepEqual(reasoning, synthesizeReasoningItem('先想一下'))
  assert.equal(reasoning.content[0].type, 'reasoning_text')
})

test('leaves the request untouched when nothing was recorded', () => {
  const input = [{ type: 'message', role: 'user', content: [] }, ...turn('call_missing')]
  const body = { input }
  assert.equal(rewrite(body, { stash: createStash() }), 0)
  assert.equal(body.input, input)
})

test('a reasoning item already in the turn suppresses the injection', () => {
  const body = {
    input: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
    ],
  }
  assert.equal(rewrite(body, { stash: stashWithText(['call_1'], 'text') }), 0)
  assert.equal(body.input.length, 2)
})

test('one reasoning item covers every parallel tool call of the turn', () => {
  const body = {
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' },
      { type: 'function_call', call_id: 'call_2', name: 'b', arguments: '{}' },
    ],
  }
  const stash = stashWithText(['call_1', 'call_2'], 'one thought')
  assert.equal(rewrite(body, { stash }), 1)
  assert.deepEqual(body.input.map((item) => item.type), ['reasoning', 'function_call', 'function_call'])
})

test('a new turn after a tool result gets its own reasoning item', () => {
  const stash = stashWithText(['call_1'], 'first')
  stash.record(['call_2'], { text: 'second' })
  const body = { input: [...turn('call_1'), ...turn('call_2')] }
  assert.equal(rewrite(body, { stash }), 2)
  assert.deepEqual(body.input.map((item) => item.type), [
    'reasoning',
    'function_call',
    'function_call_output',
    'reasoning',
    'function_call',
    'function_call_output',
  ])
})

test('the rewrite is idempotent', () => {
  const stash = stashWithText(['call_1'], 'text')
  const body = { input: [...turn('call_1')] }
  assert.equal(rewrite(body, { stash }), 1)
  assert.equal(rewrite(body, { stash }), 0)
})

test('a captured item keeps its identity and gains the thinking text the gateway asks for', () => {
  const item = { type: 'reasoning', id: 'rs_9', summary: [{ type: 'summary_text', text: 'original' }] }
  const stash = createStash()
  stash.record(['call_1'], { items: [item], text: 'recovered text' })
  const body = { input: [...turn('call_1')] }
  assert.equal(rewrite(body, { stash }), 1)
  const injected = body.input[0]
  assert.notEqual(injected, item)
  assert.equal(injected.id, 'rs_9')
  assert.deepEqual(injected.summary, item.summary)
  assert.deepEqual(injected.content, [{ type: 'reasoning_text', text: 'recovered text' }])
  // The recorded item is never aliased into a request.
  assert.equal('content' in item, false)
})

test('a captured item that already carries thinking text is left as the gateway sent it', () => {
  const item = {
    type: 'reasoning',
    id: 'rs_10',
    summary: [{ type: 'summary_text', text: 'short' }],
    content: [{ type: 'reasoning_text', text: 'the full thinking' }],
  }
  const stash = createStash()
  stash.record(['call_1'], { items: [item], text: 'recovered text' })
  const body = { input: [...turn('call_1')] }
  rewrite(body, { stash })
  assert.deepEqual(body.input[0], item)
})

test('a captured item with no recoverable text is still injected unchanged', () => {
  const item = { type: 'reasoning', id: 'rs_11', summary: [{ type: 'summary_text', text: 'only summary' }] }
  const stash = createStash()
  stash.record(['call_1'], { items: [item] })
  const body = { input: [...turn('call_1')] }
  assert.equal(rewrite(body, { stash }), 1)
  assert.deepEqual(body.input[0], item)
})

test('the synthesized item carries both schema slots and invents no id', () => {
  const item = synthesizeReasoningItem('thought')
  assert.deepEqual(item, {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'thought' }],
    content: [{ type: 'reasoning_text', text: 'thought' }],
  })
  assert.equal('id' in item, false)
})

test('recentTurns bounds the work to the newest turns', () => {
  const stash = createStash()
  stash.record(['call_1'], { text: 'first' })
  stash.record(['call_2'], { text: 'second' })
  stash.record(['call_3'], { text: 'third' })
  const build = () => ({ input: [...turn('call_1'), ...turn('call_2'), ...turn('call_3')] })

  const all = build()
  assert.equal(rewrite(all, { stash }), 3)
  const bounded = build()
  assert.equal(rewrite(bounded, { stash, recentTurns: 1 }), 1)
  const injected = bounded.input.filter((item) => item.type === 'reasoning')
  assert.equal(injected.length, 1)
  assert.equal(injected[0].content[0].text, 'third')
  // 0 means every turn, which is the behaviour with no bound at all.
  const zero = build()
  assert.equal(rewrite(zero, { stash, recentTurns: 0 }), 3)
})

test('every gap is covered; only the newest N turns carry recovered text', () => {
  const stash = createStash()
  stash.record(['call_1'], { text: 'first' })
  stash.record(['call_2'], { text: 'second' })
  stash.record(['call_3'], { text: 'third' })
  const build = () => ({ input: [...turn('call_1'), ...turn('call_2'), ...turn('call_3')] })

  // With no placeholder allowed, nothing older than the window can be filled.
  const off = build()
  assert.equal(rewrite(off, { stash, recentTurns: 1 }), 1)

  // With it on, the two older gaps still get an item — a single-space placeholder —
  // so coverage does not depend on how long the session has grown.
  const on = build()
  assert.equal(rewrite(on, { stash, recentTurns: 1, placeholderReasoning: true }), 3)
  const texts = on.input.filter((item) => item.type === 'reasoning').map((item) => item.content[0].text)
  assert.deepEqual(texts, [' ', ' ', 'third'])

  // N = 0 keeps the original meaning: every turn uses its recovered text.
  const all = build()
  assert.equal(rewrite(all, { stash, placeholderReasoning: true }), 3)
  assert.deepEqual(all.input.filter((item) => item.type === 'reasoning').map((item) => item.content[0].text), [
    'first',
    'second',
    'third',
  ])
})

test('a turn outside the window never replays a captured item either', () => {
  const item = { type: 'reasoning', id: 'rs_9', summary: [{ type: 'summary_text', text: 'original' }] }
  const stash = createStash()
  stash.record(['call_1'], { items: [item], text: 'recovered' })
  stash.record(['call_2'], { text: 'newest' })
  const body = { input: [...turn('call_1'), ...turn('call_2')] }
  assert.equal(rewrite(body, { stash, recentTurns: 1, placeholderReasoning: true }), 2)
  const items = body.input.filter((entry) => entry.type === 'reasoning')
  assert.equal(items[0].content[0].text, ' ')
  assert.equal('id' in items[0], false)
  assert.equal(items[1].content[0].text, 'newest')
})

test('singleReasoningSlot halves the synthesized text and replays captured items as sent', () => {
  const stash = createStash()
  stash.record(['call_1'], { text: 'thought' })
  const body = { input: [...turn('call_1')] }
  assert.equal(rewrite(body, { stash, singleReasoningSlot: true }), 1)
  assert.deepEqual(body.input[0], { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thought' }] })
  assert.equal('summary' in body.input[0], false)

  const item = { type: 'reasoning', id: 'rs_9', summary: [{ type: 'summary_text', text: 'original' }] }
  const captured = createStash()
  captured.record(['call_1'], { items: [item], text: 'recovered' })
  const second = { input: [...turn('call_1')] }
  rewrite(second, { stash: captured, singleReasoningSlot: true })
  assert.deepEqual(second.input[0], item)
})

test('placeholderReasoning fills a turn that produced no thinking anywhere', () => {
  // Nothing recorded for this call id, and nothing recovered from history: the
  // turn is exactly the one a presence check refuses.
  const empty = createStash()
  const untouched = { input: [...turn('call_none')] }
  assert.equal(rewrite(untouched, { stash: empty }), 0)

  const filled = { input: [...turn('call_none')] }
  assert.equal(rewrite(filled, { stash: createStash(), placeholderReasoning: true }), 1)
  const item = filled.input[0]
  assert.equal(item.type, 'reasoning')
  assert.equal(item.summary[0].text, ' ')
  assert.equal(item.content[0].text, ' ')
  assert.equal('id' in item, false)

  // The slot option still decides how many slots the placeholder fills.
  const single = { input: [...turn('call_none')] }
  rewrite(single, { stash: createStash(), placeholderReasoning: true, singleReasoningSlot: true })
  assert.deepEqual(single.input[0], { type: 'reasoning', content: [{ type: 'reasoning_text', text: ' ' }] })
})

test('placeholderReasoning never overrides recovered thinking', () => {
  const stash = createStash()
  stash.record(['call_1'], { text: 'real thought' })
  const body = { input: [...turn('call_1')] }
  rewrite(body, { stash, placeholderReasoning: true })
  assert.equal(body.input[0].content[0].text, 'real thought')
})

test('reasoningTextOnly moves a summary-only item to the reasoning_text shape', () => {
  const body = {
    input: [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'the thinking' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
    ],
  }
  // Off by default: the gateway's own shape is replayed untouched.
  rewrite({ input: body.input.map((item) => ({ ...item })) }, { stash: createStash() })
  const kept = body.input[0]
  assert.equal('summary' in kept, true)

  assert.equal(rewrite(body, { stash: createStash(), reasoningTextOnly: true }), 1)
  const item = body.input[0]
  assert.equal('summary' in item, false)
  assert.equal(item.id, 'rs_1')
  assert.deepEqual(item.content, [{ type: 'reasoning_text', text: 'the thinking' }])
})

test('a reshaped item never loses text, and an item that already has content keeps it', () => {
  const withContent = {
    type: 'reasoning',
    id: 'rs_2',
    summary: [{ type: 'summary_text', text: 'summary copy' }],
    content: [{ type: 'reasoning_text', text: 'full thinking' }],
  }
  const body = { input: [withContent, { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' }] }
  rewrite(body, { stash: createStash(), reasoningTextOnly: true })
  assert.equal('summary' in body.input[0], false)
  assert.deepEqual(body.input[0].content, [{ type: 'reasoning_text', text: 'full thinking' }])

  // A summary with no text still yields a content part, so the item stays valid.
  const empty = { type: 'reasoning', id: 'rs_3', summary: [] }
  const second = { input: [empty, { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' }] }
  rewrite(second, { stash: createStash(), reasoningTextOnly: true })
  assert.deepEqual(second.input[0].content, [{ type: 'reasoning_text', text: '' }])
})

test('reasoningTextOnly also drops the summary the request asks the provider for', () => {
  // The strict upstream rejects the PARAMETER, which the item-level pass cannot reach.
  const build = () => ({
    model: 'm',
    reasoning: { effort: 'high', summary: 'auto' },
    input: [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' }],
  })

  const untouched = build()
  assert.equal(rewrite(untouched, { stash: createStash() }), 0)
  assert.deepEqual(untouched.reasoning, { effort: 'high', summary: 'auto' })

  const stripped = build()
  assert.equal(rewrite(stripped, { stash: createStash(), reasoningTextOnly: true }), 1)
  assert.deepEqual(stripped.reasoning, { effort: 'high' })

  // Only the reasoning parameter is touched: an unrelated summary stays.
  const unrelated = { summary: 'keep me', reasoning: { effort: 'low' } }
  assert.equal(rewrite(unrelated, { stash: createStash(), reasoningTextOnly: true }), 0)
  assert.deepEqual(unrelated, { summary: 'keep me', reasoning: { effort: 'low' } })
})

test('the observer records the reasoning item and the call ids of one response', () => {
  const observer = createResponseObserver()
  observer.feed({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '想' }] } })
  observer.feed({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_7' } })
  const result = observer.result()
  assert.deepEqual(result.callIds, ['call_7'])
  assert.equal(result.items.length, 1)
  assert.equal(result.text, '想')
})

test('the observer falls back to the terminal response when no item events arrive', () => {
  const observer = createResponseObserver()
  observer.feed({
    type: 'response.completed',
    response: {
      output: [
        { type: 'reasoning', id: 'rs_2', content: [{ type: 'reasoning_text', text: '终' }] },
        { type: 'function_call', call_id: 'call_8' },
      ],
    },
  })
  const result = observer.result()
  assert.deepEqual(result.callIds, ['call_8'])
  assert.equal(result.text, '终')
})

test('the observer tolerates unrelated and malformed events', () => {
  const observer = createResponseObserver()
  observer.feed(null)
  observer.feed('nope')
  observer.feed({ type: 'response.output_item.done', item: null })
  observer.feed({ type: 'response.completed', response: {} })
  assert.deepEqual(observer.result(), { callIds: [], items: [], text: '' })
})

test('the catalog metadata names this fix and keeps it off by default', () => {
  assert.equal(metadata.id, 'responses-reasoning-echo')
  assert.equal(metadata.defaultEnabled, false)
  assert.equal(typeof metadata.title, 'string')
  assert.equal(typeof metadata.detail, 'string')
})
