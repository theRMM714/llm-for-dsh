/**
 * The committed `lib/` is the artifact that installs, so a stale build is a
 * shipped bug. This test rebuilds into a scratch directory and compares bytes.
 *
 * @module llm-for-dsh/test/lib-current.test
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildInto, hostModules, PACKAGE_NAME, serializeCatalog, verifyCommitted } from '../scripts/build.mjs'

/** A throwaway directory, removed by the caller. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'llm-compat-test-'))
}

test('the package name the bundle registers under is the manifest name', () => {
  assert.equal(PACKAGE_NAME, 'llm-for-dsh')
})

test('the host modules the build copies include the fix catalog', () => {
  const modules = hostModules()
  assert.ok(modules.includes('index.js'))
  assert.ok(modules.includes('interceptor.js'))
  assert.ok(modules.includes('stash.js'))
  assert.ok(modules.includes('log.js'))
  assert.ok(modules.includes('fixes/index.js'))
  assert.ok(modules.includes('fixes/responses-reasoning-echo.js'))
  assert.ok(modules.includes('retries/index.js'))
  assert.ok(modules.includes('retries/reasoning-text-not-passed-back.js'))
  assert.ok(modules.includes('routes.js'))
  assert.ok(modules.includes('limits.js'))
  assert.ok(!modules.includes('client.js'))
})

test('the embedded catalog carries the enforced fix list', () => {
  const catalog = JSON.parse(serializeCatalog())
  assert.deepEqual(catalog.fixes.map((fix) => fix.id), ['responses-reasoning-echo'])
  assert.deepEqual(catalog.retries.map((rule) => rule.id), ['reasoning-text-not-passed-back'])
  assert.equal(catalog.defaults.diagnostics, false)
  assert.equal(catalog.defaults.retryAttempts, 2)
  assert.deepEqual(catalog.defaults.retries, [])
})

test('the committed lib/ matches a fresh build', () => {
  const { ok, differences } = verifyCommitted()
  assert.ok(ok, 'lib/ is not current; run "node scripts/build.mjs". Stale: ' + differences.join(', '))
})

test('a build is deterministic', () => {
  const first = scratch()
  const second = scratch()
  try {
    const a = buildInto(first)
    const b = buildInto(second)
    assert.equal(a.stamp, b.stamp)
    assert.deepEqual(a.files, b.files)
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})
