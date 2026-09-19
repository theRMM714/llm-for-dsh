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
