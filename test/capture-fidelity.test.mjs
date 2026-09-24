/**
 * Does the capture path steal or delay anything from the caller's stream?
 *
 * The suspicion under test: a tool call that the model announced never arrives,
 * which would look exactly like this plugin's SSE tee dropping bytes. The tee
 * reads `response.clone()` and never the caller's branch, so the caller must see
 * the stream byte-for-byte, including a tool-call delta that follows a long text
 * delta and a terminal event split across chunk boundaries.
 *
 * @module llm-for-dsh/test/capture-fidelity.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installFetchInterceptor } from '../src/interceptor.js'
import { createStash } from '../src/stash.js'

const RESPONSES = 'https://relay.example/v1/responses'

/** The SSE frames a gateway sends for "text, then a tool call, then done". */
const FRAMES = [
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"恢复修复、跑全量入口："}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_x","name":"run_code"}}\n\n',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"code\\":\\"1\\"}"}\n\n',
  // The finalized item is where the observer collects the call id.
  'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_x","name":"run_code"}}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
]

/** A stream that hands the frames over in awkward chunk boundaries. */
function streamOf(text, size) {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.subarray(at, at + size))
      controller.close()
    },
  })
}

test('the capture tee never changes what the caller receives', async () => {
  const original = globalThis.fetch
  const text = FRAMES.join('')
  const sent = []
  globalThis.fetch = async () =>
    new Response(streamOf(text, 17), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const dispose = installFetchInterceptor({
    resolveSettings: () => ({ enabled: new Set(['responses-reasoning-echo']), hosts: [], diagnostics: false, retries: new Set(), retryAttempts: 0 }),
    stash: createStash(),
    log: (line) => sent.push(line),
  })
  try {
    const response = await globalThis.fetch(RESPONSES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' }] }),
    })
    // Byte-for-byte, including the tool call that follows the text.
    assert.equal(await response.text(), text)
    assert.equal(response.status, 200)
  } finally {
    dispose()
    globalThis.fetch = original
  }
  // The capture really did run — it is asynchronous by design, so give it a tick —
  // and it announced the call id it observed without touching the caller's bytes.
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sent.some((line) => line.includes('captured 1 call id')), true)
})

test('the caller still sees every frame when the tee is slow to drain', async () => {
  const original = globalThis.fetch
  const text = FRAMES.join('')
  globalThis.fetch = async () =>
    new Response(streamOf(text, 5), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const dispose = installFetchInterceptor({
    resolveSettings: () => ({ enabled: new Set(['responses-reasoning-echo']), hosts: [], diagnostics: false, retries: new Set(), retryAttempts: 0 }),
    stash: createStash(),
    log: () => {},
  })
  try {
    const response = await globalThis.fetch(RESPONSES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' }] }),
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      seen += decoder.decode(value, { stream: true })
    }
    assert.equal(seen, text)
  } finally {
    dispose()
    globalThis.fetch = original
  }
})
