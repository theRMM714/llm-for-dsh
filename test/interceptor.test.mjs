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
function settingsOf(enabled, hosts = []) {
  return { enabled: new Set(enabled), hosts, diagnostics: false }
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

test('the digest describes a chat-completions body too', () => {
  assert.deepEqual(describeRequestBody({ messages: [{ role: 'user' }] }), {
    items: 1,
    tail: [{ t: 'user' }],
  })
  assert.equal(describeRequestBody({ nothing: true }), undefined)
  assert.equal(describeRequestBody(null), undefined)
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
