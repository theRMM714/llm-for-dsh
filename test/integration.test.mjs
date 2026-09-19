/**
 * End-to-end test against a local gateway that reproduces the observed failure:
 * a Responses request carrying a tool call with no reasoning item is refused with
 * 400, and the same request passes once the fix is enabled — either from the
 * durable harness history or from the item captured out of the previous stream.
 *
 * The gateway checks presence exactly like the relay does; the rest of the SSE
 * payload is trimmed to the events this plugin reads.
 *
 * @module llm-for-dsh/test/integration.test
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { installFetchInterceptor } from '../src/interceptor.js'
import { createStash, harnessReasoningByCallId } from '../src/stash.js'

const USER_TURN = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
const FIRST_TURN = { model: 'm', stream: true, input: [USER_TURN] }
const SECOND_TURN = {
  model: 'm',
  stream: true,
  input: [
    USER_TURN,
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
  ],
}

/** Write one SSE response. */
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) res.write('data: ' + JSON.stringify(event) + '\n\n')
  res.end()
}

/** Poll until a condition holds, so a clone's drain never races the assertion. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

test('the fix repairs the tool-call continuation the gateway refuses', async () => {
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        body = undefined
      }
      seen.push(body)
      const input = Array.isArray(body?.input) ? body.input : []
      const toolCalls = input.filter((item) => item?.type === 'function_call')
      const reasoning = input.filter((item) => item?.type === 'reasoning')
      if (toolCalls.length > 0 && reasoning.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          message: 'The `reasoning_text` in the thinking mode must be passed back to the API.',
          type: 'invalid_request_error',
          param: '',
          code: 'invalid_request_error',
        }))
        return
      }
      if (toolCalls.length === 0) {
        sse(res, [
          { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '先想一下' }] } },
          { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{}' } },
          { type: 'response.completed', response: { id: 'resp_1', output: [] } },
        ])
        return
      }
      sse(res, [
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant' } },
        { type: 'response.completed', response: { id: 'resp_2', output: [] } },
      ])
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = 'http://127.0.0.1:' + String(port) + '/v1/responses'
  const post = (body) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  let dispose
  try {
    // 1. Without any interceptor the fixture answers exactly what the relay did.
    const refused = await post(SECOND_TURN)
    assert.equal(refused.status, 400)
    assert.match(await refused.text(), /reasoning_text/)

    // 2. Durable harness history alone is enough to repair the follow-up.
    const stash = createStash()
    for (const entry of harnessReasoningByCallId([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '历史里的思考' },
          { type: 'tool-call', id: 'call_1|fc_1', name: 'read', arguments: {} },
        ],
      },
    ])) {
      stash.record(entry.callIds, entry.payload)
    }
    dispose = installFetchInterceptor({
      resolveSettings: () => ({ enabled: new Set(['responses-reasoning-echo']), hosts: ['127.0.0.1'], diagnostics: false }),
      stash,
      log: () => {},
    })
    const repaired = await post(SECOND_TURN)
    assert.equal(repaired.status, 200)
    await repaired.text()
    const injected = seen.at(-1).input.filter((item) => item?.type === 'reasoning')
    assert.equal(injected.length, 1)
    assert.equal(injected[0].content[0].type, 'reasoning_text')
    assert.equal(injected[0].content[0].text, '历史里的思考')
    const types = seen.at(-1).input.map((item) => item.type)
    assert.ok(types.indexOf('reasoning') < types.indexOf('function_call'), 'the reasoning item must precede the tool call')
    dispose()
    dispose = undefined

    // 3. An item captured from the previous stream is replayed verbatim.
    const captured = createStash()
    dispose = installFetchInterceptor({
      resolveSettings: () => ({ enabled: new Set(['responses-reasoning-echo']), hosts: ['127.0.0.1'], diagnostics: false }),
      stash: captured,
      log: () => {},
    })
    const first = await post(FIRST_TURN)
    assert.equal(first.status, 200)
    await first.text()
    assert.ok(await waitFor(() => captured.size() > 0), 'the streamed reasoning item should have been captured')
    const second = await post(SECOND_TURN)
    assert.equal(second.status, 200)
    await second.text()
    const replayed = seen.at(-1).input.filter((item) => item?.type === 'reasoning')
    assert.equal(replayed.length, 1)
    assert.equal(replayed[0].id, 'rs_1')
  } finally {
    if (dispose !== undefined) dispose()
    await new Promise((resolve) => server.close(resolve))
  }
})
