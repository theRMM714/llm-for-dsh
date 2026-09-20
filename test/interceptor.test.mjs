/**
 * Unit tests for the outbound interceptor: host gating, shape gating, the
 * contained-failure rule, and the guarantee that a disabled fix cannot change a
 * byte of the request.
 *
 * @module llm-for-dsh/test/interceptor.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FIXES } from '../src/fixes/index.js'
import { createWriter, describeRequestBody, hostAllowed, installFetchInterceptor, normalizeHosts } from '../src/interceptor.js'
import { createStash } from '../src/stash.js'

const RESPONSES = 'https://relay.example/v1/responses'

/** Settings resolve once, as the Host half does per request. */
function settingsOf(enabled, hosts = [], extra = {}) {
  return { enabled: new Set(enabled), hosts, diagnostics: false, retries: new Set(), retryAttempts: 0, ...extra }
}

/** The refusal the relay returns for a thinking-mode request that lost its reasoning. */
const REFUSAL = JSON.stringify({
  error: { message: 'The `reasoning_text` in the thinking mode must be passed back to the API.', type: 'invalid_request_error' },
})

/** A downstream stub that answers with the given responses, repeating the last one. */
function stubFetch(answers) {
  const calls = []
  const stub = async (url, init) => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } })
  }
  return { stub, calls }
}

/** A writer over the shipped catalog, plus the stash it consults. */
function writerFor(enabled, options = {}) {
  const stash = options.stash ?? createStash()
  const writer = createWriter({
    resolveSettings: () => settingsOf(enabled, options.hosts ?? []),
    stash,
    log: options.log,
    fixes: options.fixes,
  })
  return { writer, stash }
}

/** One body whose only tool call has reasoning recorded for it. */
function bodyFor(callId) {
  return {
    model: 'm',
    input: [{ type: 'function_call', call_id: callId, name: 'read', arguments: '{}' }],
  }
}

test('a disabled catalog leaves the request byte-identical', () => {
  const { writer } = writerFor([])
  assert.equal(writer.rewriteRequest(RESPONSES, 'POST', JSON.stringify(bodyFor('call_1'))), undefined)
})

test('only POST requests with a JSON object body are considered', () => {
  const { writer } = writerFor(['responses-reasoning-echo'])
  assert.equal(writer.rewriteRequest(RESPONSES, 'GET', '{"input":[]}'), undefined)
  assert.equal(writer.rewriteRequest(RESPONSES, 'POST', 'not json'), undefined)
  assert.equal(writer.rewriteRequest(RESPONSES, 'POST', '[1,2]'), undefined)
  assert.equal(writer.rewriteRequest(RESPONSES, 'POST', ''), undefined)
})

test('a host outside the allowlist is never inspected', () => {
  const stash = createStash()
  stash.record(['call_1'], { text: 'thought' })
  const { writer } = writerFor(['responses-reasoning-echo'], { hosts: ['other.example'], stash })
  assert.equal(writer.rewriteRequest(RESPONSES, 'POST', JSON.stringify(bodyFor('call_1'))), undefined)
})

test('an enabled fix rewrites the matching request', () => {
  const stash = createStash()
  stash.record(['call_1'], { text: 'thought' })
  const { writer } = writerFor(['responses-reasoning-echo'], { stash })
  const result = writer.rewriteRequest(RESPONSES, 'POST', JSON.stringify(bodyFor('call_1')))
  assert.notEqual(result, undefined)
  assert.deepEqual(result.changed, ['responses-reasoning-echo(1)'])
  const parsed = JSON.parse(result.body)
  assert.deepEqual(parsed.input.map((item) => item.type), ['reasoning', 'function_call'])
})

test('a rewrite reports a digest of the turns it sent', () => {
  const stash = createStash()
  stash.record(['call_1'], { text: 'thought' })
  const { writer } = writerFor(['responses-reasoning-echo'], { stash })
  const result = writer.rewriteRequest(RESPONSES, 'POST', JSON.stringify(bodyFor('call_1')))
  assert.equal(result.digest.items, 2)
  assert.deepEqual(result.digest.tail.map((entry) => entry.t), ['reasoning', 'function_call'])
  assert.equal(result.digest.tail[0].id, 'none')
  // The synthesized item carries the text in both schema slots, so the digest
  // sums summary and content: 7 + 7.
  assert.equal(result.digest.tail[0].text, 14)
})

test('an inspected request keeps its digest even when nothing was rewritten', async () => {
  const stash = createStash()
  const { writer } = writerFor(['responses-reasoning-echo'], { stash })
  const body = {
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [] },
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'already here' }] },
      { type: 'function_call', call_id: 'call_x', name: 'read', arguments: '{}' },
    ],
  }
  // The turn already carries an item, so the fix changes nothing...
  assert.equal(writer.rewriteRequest(RESPONSES, 'POST', JSON.stringify(body)), undefined)
  // ...yet the shape is remembered, which is what makes an unrewritten refusal diagnosable.
  const digest = writer.digestFor(RESPONSES)
  assert.equal(digest.items, 3)
  assert.deepEqual(digest.tail.map((entry) => entry.t), ['message', 'reasoning', 'function_call'])

  const rejections = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } })
  const dispose = installFetchInterceptor({
    resolveSettings: () => settingsOf(['responses-reasoning-echo']),
    stash,
    log: () => {},
    onRejection: (record) => rejections.push(record),
  })
  try {
    await globalThis.fetch(RESPONSES, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    dispose()
    globalThis.fetch = realFetch
  }
  assert.equal(rejections.length, 1)
  assert.deepEqual(rejections[0].changed, [])
  assert.equal(rejections[0].digest.items, 3)
})

test('the digest describes a chat-completions body too', () => {
  assert.deepEqual(describeRequestBody({ messages: [{ role: 'user' }] }), {
    items: 1,
    toolTurns: 0,
    gaps: 0,
    tail: [{ t: 'user' }],
  })
  assert.equal(describeRequestBody({ nothing: true }), undefined)
  assert.equal(describeRequestBody(null), undefined)
})

test('the digest counts tool turns and the gaps left AFTER the rewrite', () => {
  const covered = {
    input: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'x' }] },
      { type: 'function_call', call_id: 'a' },
      { type: 'function_call_output', call_id: 'a' },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'y' }] },
      { type: 'function_call', call_id: 'b' },
      { type: 'function_call_output', call_id: 'b' },
    ],
  }
  assert.deepEqual(
    { toolTurns: describeRequestBody(covered).toolTurns, gaps: describeRequestBody(covered).gaps },
    { toolTurns: 2, gaps: 0 },
  )
  const hole = {
    input: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'x' }] },
      { type: 'function_call', call_id: 'a' },
      { type: 'function_call_output', call_id: 'a' },
      { type: 'function_call', call_id: 'b' },
      { type: 'function_call_output', call_id: 'b' },
    ],
  }
  assert.deepEqual(
    { toolTurns: describeRequestBody(hole).toolTurns, gaps: describeRequestBody(hole).gaps },
    { toolTurns: 2, gaps: 1 },
  )
  // An assistant message keeps its turn's reasoning in scope, so it is not a gap.
  const withText = {
    input: [
      { type: 'reasoning', content: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      { type: 'function_call', call_id: 'a' },
    ],
  }
  assert.equal(describeRequestBody(withText).gaps, 0)
})

test('an unknown enabled id is ignored rather than fatal', () => {
  const { writer } = writerFor(['not-a-fix'])
  assert.equal(writer.rewriteRequest(RESPONSES, 'POST', JSON.stringify(bodyFor('call_1'))), undefined)
})

test('a throwing fix is contained and its request goes out untouched', () => {
  const lines = []
  const { writer } = writerFor(['boom'], {
    log: (line) => lines.push(line),
    fixes: [
      {
        id: 'boom',
        requestMatcher: () => true,
        rewrite: () => {
          throw new Error('fix exploded')
        },
      },
    ],
  })
  assert.equal(writer.rewriteRequest(RESPONSES, 'POST', JSON.stringify(bodyFor('call_1'))), undefined)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /fix exploded/)
})

test('a stream that ends without a blank line still yields its last event', async () => {
  const stash = createStash()
  const { writer } = writerFor(['responses-reasoning-echo'], { stash })
  const text =
    // Two separate events: each needs its own blank line, and the stream ends
    // without the one that would close the LAST event.
    'data: ' + JSON.stringify({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } }) + '\n\n' +
    'data: ' + JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9' } })
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
  const capturing = writer.startCapture(RESPONSES, response)
  assert.notEqual(capturing, undefined)
  await capturing
  const recorded = stash.lookup('call_9')
  assert.notEqual(recorded, undefined)
  assert.equal(recorded.items[0].id, 'rs_1')
})

test('nothing is captured when no fix is enabled or the body is not a stream', () => {
  const disabled = writerFor([]).writer
  const stream = new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  assert.equal(disabled.startCapture(RESPONSES, stream), undefined)
  const { writer } = writerFor(['responses-reasoning-echo'])
  const plain = new Response('{}', { headers: { 'content-type': 'application/json' } })
  assert.equal(writer.startCapture(RESPONSES, plain), undefined)
})

test('a refused request reports its status and the exact body that was sent', async () => {
  // The interceptor captures the downstream fetch when it installs, so the stub
  // goes in first; disposal then puts the stub back and this test restores the
  // real one itself.
  const realFetch = globalThis.fetch
  const stash = createStash()
  stash.record(['call_1'], { text: 'thought' })
  const rejections = []
  const lines = []
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: 'The reasoning_text in the thinking mode must be passed back to the API.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  const dispose = installFetchInterceptor({
    resolveSettings: () => settingsOf(['responses-reasoning-echo']),
    stash,
    log: (line) => lines.push(line),
    onRejection: (record) => rejections.push(record),
  })
  try {
    await globalThis.fetch(RESPONSES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyFor('call_1')),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    dispose()
    globalThis.fetch = realFetch
  }
  assert.equal(rejections.length, 1)
  assert.equal(rejections[0].status, 400)
  assert.deepEqual(rejections[0].changed, ['responses-reasoning-echo(1)'])
  assert.match(rejections[0].responseBody, /reasoning_text/)
  const rewritten = JSON.parse(rejections[0].requestBody)
  assert.deepEqual(rewritten.input.map((item) => item.type), ['reasoning', 'function_call'])
  assert.ok(lines.some((line) => /resp 400/.test(line)), 'the outcome is logged: ' + lines.join(' | '))
})

test('an enabled retry rule re-sends the same bytes and returns the second answer', async () => {
  const realFetch = globalThis.fetch
  const { stub, calls } = stubFetch([{ status: 400, body: REFUSAL }, { status: 200, body: '{"ok":true}' }])
  globalThis.fetch = stub
  const dispose = installFetchInterceptor({
    resolveSettings: () => settingsOf([], [], { retries: new Set(['reasoning-text-not-passed-back']), retryAttempts: 2 }),
    stash: createStash(),
    log: () => {},
    retryDelayMs: 0,
  })
  try {
    const response = await globalThis.fetch(RESPONSES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyFor('call_1')),
    })
    assert.equal(response.status, 200)
  } finally {
    dispose()
    globalThis.fetch = realFetch
  }
  assert.equal(calls.length, 2)
  // The retry is the SAME request, not a rebuilt one.
  assert.equal(calls[0].body, calls[1].body)
})

test('a retry only happens for an enabled rule, a matching refusal, and a spare attempt', async () => {
  const cases = [
    { label: 'rule disabled', settings: settingsOf([], [], { retryAttempts: 2 }), expected: 1 },
    { label: 'attempts exhausted', settings: settingsOf([], [], { retries: new Set(['reasoning-text-not-passed-back']), retryAttempts: 0 }), expected: 1 },
    { label: 'two attempts granted', settings: settingsOf([], [], { retries: new Set(['reasoning-text-not-passed-back']), retryAttempts: 2 }), expected: 3 },
  ]
  for (const scenario of cases) {
    const realFetch = globalThis.fetch
    const { stub, calls } = stubFetch([{ status: 400, body: REFUSAL }])
    globalThis.fetch = stub
    const dispose = installFetchInterceptor({ resolveSettings: () => scenario.settings, stash: createStash(), log: () => {}, retryDelayMs: 0 })
    try {
      const response = await globalThis.fetch(RESPONSES, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyFor('call_1')),
      })
      assert.equal(response.status, 400, scenario.label)
    } finally {
      dispose()
      globalThis.fetch = realFetch
    }
    assert.equal(calls.length, scenario.expected, scenario.label)
  }
})

test('an unrelated 400 is never retried', async () => {
  const realFetch = globalThis.fetch
  const { stub, calls } = stubFetch([{ status: 400, body: '{"error":{"message":"Invalid token"}}' }])
  globalThis.fetch = stub
  const dispose = installFetchInterceptor({
    resolveSettings: () => settingsOf([], [], { retries: new Set(['reasoning-text-not-passed-back']), retryAttempts: 2 }),
    stash: createStash(),
    log: () => {},
    retryDelayMs: 0,
  })
  try {
    const response = await globalThis.fetch(RESPONSES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyFor('call_1')),
    })
    assert.equal(response.status, 400)
  } finally {
    dispose()
    globalThis.fetch = realFetch
  }
  assert.equal(calls.length, 1)
})

test('the shipped catalog keeps the fix off by default', () => {
  assert.deepEqual(FIXES.map((fix) => fix.id), ['responses-reasoning-echo'])
  assert.equal(FIXES[0].defaultEnabled, false)
})

test('host names normalize to lowercase bare hostnames', () => {
  assert.deepEqual(normalizeHosts([' HTTPS://Relay.Example/v1/ ', 'relay.example', 'other.example:8443', '', 7]), [
    'relay.example',
    'other.example',
  ])
  assert.deepEqual(normalizeHosts('not an array'), [])
})

test('the host gate matches the exact host and its subdomains', () => {
  assert.equal(hostAllowed(RESPONSES, []), true)
  assert.equal(hostAllowed(RESPONSES, ['relay.example']), true)
  assert.equal(hostAllowed('https://api.relay.example/v1/responses', ['relay.example']), true)
  assert.equal(hostAllowed('https://evil-relay.example/v1/responses', ['relay.example']), false)
  assert.equal(hostAllowed('not a url', ['relay.example']), false)
})
