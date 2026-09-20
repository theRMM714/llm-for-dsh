/**
 * Tests for the diagnostic log: the summary line, and the refused-request record
 * that makes an intermittent rejection diagnosable.
 *
 * @module llm-for-dsh/test/log.test
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDiagnosticLog, defaultLogPath, MAX_REJECTED_BODY_CHARS } from '../src/log.js'

/** A throwaway home, removed by the caller. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'llm-compat-log-'))
}

test('the default path lives in the harness home', () => {
  assert.equal(defaultLogPath({ DSH_HOME: 'X:/home' }), join('X:/home', 'llm-compat.log'))
})

test('nothing is written while diagnostics are off', () => {
  const home = scratch()
  try {
    const log = createDiagnosticLog({ path: join(home, 'llm-compat.log'), enabled: false })
    log.write('quiet')
    assert.equal(log.dumpRejection({ url: 'u', status: 400, requestBody: '{}' }), undefined)
    assert.throws(() => readFileSync(join(home, 'llm-compat.log'), 'utf8'))
    assert.throws(() => readFileSync(join(home, 'llm-compat-rejected.jsonl'), 'utf8'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a rejection record keeps the status, the answer and the exact sent body', () => {
  const home = scratch()
  try {
    const log = createDiagnosticLog({ path: join(home, 'llm-compat.log'), enabled: true, now: () => 0 })
    log.write('rewrote https://relay.example/v1/responses via responses-reasoning-echo(86)')
    const path = log.dumpRejection({
      url: 'https://relay.example/v1/responses',
      status: 400,
      changed: ['responses-reasoning-echo(86)'],
      requestBody: '{"input":[]}',
      responseBody: '{"message":"The reasoning_text in the thinking mode must be passed back to the API."}',
    })
    assert.equal(path, join(home, 'llm-compat-rejected.jsonl'))
    const line = readFileSync(join(home, 'llm-compat.log'), 'utf8').trim()
    assert.match(JSON.parse(line).line, /rewrote/)
    const record = JSON.parse(readFileSync(join(home, 'llm-compat-rejected.jsonl'), 'utf8').trim())
    assert.equal(record.status, 400)
    assert.equal(record.url, 'https://relay.example/v1/responses')
    assert.equal(record.requestBody, '{"input":[]}')
    assert.equal(record.requestBodyTruncated, false)
    assert.match(record.responseBody, /reasoning_text/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a rejection keeps the tail and the structural digest of the newest turns', () => {
  const home = scratch()
  try {
    const log = createDiagnosticLog({ path: join(home, 'llm-compat.log'), enabled: true })
    const body = 'H'.repeat(200) + 'TAIL-MARKER'
    log.dumpRejection({
      url: 'u',
      status: 400,
      requestBody: body,
      digest: { items: 2, tail: [{ t: 'reasoning', text: 5 }, { t: 'function_call', call_id: 'c' }] },
    })
    const record = JSON.parse(readFileSync(join(home, 'llm-compat-rejected.jsonl'), 'utf8').trim())
    assert.match(record.requestTail, /TAIL-MARKER$/)
    assert.equal(record.requestTailTruncated, false)
    assert.deepEqual(record.requestDigest.tail[1], { t: 'function_call', call_id: 'c' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the paths are exposed and both files can be emptied', () => {
  const home = scratch()
  try {
    const logPath = join(home, 'llm-compat.log')
    const log = createDiagnosticLog({ path: logPath, enabled: true })
    log.write('one line')
    log.dumpRejection({ url: 'u', status: 400, requestBody: '{}' })
    assert.equal(readFileSync(logPath, 'utf8').trim().length > 0, true)
    assert.deepEqual(log.paths(), { log: logPath, rejected: join(home, 'llm-compat-rejected.jsonl') })
    const cleared = log.clear()
    assert.deepEqual(cleared.sort(), [join(home, 'llm-compat-rejected.jsonl'), logPath].sort())
    assert.equal(readFileSync(logPath, 'utf8'), '')
    assert.equal(readFileSync(join(home, 'llm-compat-rejected.jsonl'), 'utf8'), '')
    // Clearing a file that was never written is not a failure: it is created empty.
    assert.equal(log.clear().length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an oversized body is truncated and says so', () => {
  const home = scratch()
  try {
    const log = createDiagnosticLog({ path: join(home, 'llm-compat.log'), enabled: true })
    const body = 'x'.repeat(MAX_REJECTED_BODY_CHARS + 10)
    log.dumpRejection({ url: 'u', status: 400, requestBody: body })
    const record = JSON.parse(readFileSync(join(home, 'llm-compat-rejected.jsonl'), 'utf8').trim())
    assert.equal(record.requestBody.length, MAX_REJECTED_BODY_CHARS)
    assert.equal(record.requestBodyLength, body.length)
    assert.equal(record.requestBodyTruncated, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
