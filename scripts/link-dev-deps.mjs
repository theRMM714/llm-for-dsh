/**
 * Development-only: make the harness packages the test suite imports resolvable
 * from this repository.
 *
 * This plugin depends on packages that ship nested inside `@deepseek-ai/dsh` and
 * are NOT on the public registry, so they cannot be installed from a manifest.
 * At runtime the loader supplies them; under `node --test` the same names have to
 * resolve from a `node_modules` beside this package, which is why one junction per
 * package is created here. `node_modules/` is ignored, so nothing about a
 * particular machine's layout is committed.
 *
 *   node scripts/link-dev-deps.mjs                 # locate dsh from PATH and PREFIX
 *   node scripts/link-dev-deps.mjs <harness-root>  # an @deepseek-ai/dsh directory
 *   DSH_HARNESS=<harness-root> node scripts/link-dev-deps.mjs
 *
 * @module llm-for-dsh/scripts/link-dev-deps
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The nested packages a test file imports by name. */
const PACKAGES = ['schemastery']

/**
 * Every plausible location of the installed `@deepseek-ai/dsh` package, most
 * specific first. The search does not shell out to npm: on Windows a `.cmd` shim
 * cannot be spawned without a shell, and a test helper should not need one.
 *
 * @returns candidate harness package roots.
 */
function candidates() {
  const explicit = process.argv[2] ?? process.env.DSH_HARNESS
  const found = []
  if (typeof explicit === 'string' && explicit.length > 0) found.push(explicit)
  for (const prefix of [process.env.npm_config_prefix, process.env.PREFIX]) {
    if (typeof prefix === 'string' && prefix.length > 0) {
      found.push(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'))
      found.push(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
    }
  }
  for (const entry of String(process.env.PATH ?? '').split(delimiter)) {
    if (entry.length === 0) continue
    // A PATH entry is either the global root itself, a bin directory beside it,
    // or the directory holding the npm prefix.
    found.push(join(entry, 'node_modules', '@deepseek-ai', 'dsh'))
    found.push(join(entry, '..', 'node_modules', '@deepseek-ai', 'dsh'))
    found.push(join(entry, '@deepseek-ai', 'dsh'))
  }
  const execDir = dirname(process.execPath)
  found.push(join(execDir, 'node_modules', '@deepseek-ai', 'dsh'))
  found.push(join(execDir, '..', 'node_modules', '@deepseek-ai', 'dsh'))
  found.push(join(execDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  return found
}

/** Whether one candidate carries the nested packages this repository imports. */
function usable(harness) {
  return typeof harness === 'string' && existsSync(join(harness, 'node_modules', '@deepseek-ai', 'schemastery'))
}

const harness = candidates().find(usable)
if (harness === undefined) {
  console.error(
    'llm-compat: cannot locate the installed @deepseek-ai/dsh package, so the tests cannot import the harness.\n' +
      'Point this script at it once:\n' +
      '  node scripts/link-dev-deps.mjs <path-to>/@deepseek-ai/dsh\n' +
      'or set DSH_HARNESS to the same path.',
  )
  process.exit(1)
}

const nested = join(harness, 'node_modules', '@deepseek-ai')
const target = join(root, 'node_modules', '@deepseek-ai')
mkdirSync(target, { recursive: true })
for (const name of PACKAGES) {
  const source = join(nested, name)
  const link = join(target, name)
  if (!existsSync(source)) {
    console.error('llm-compat: ' + source + ' does not exist; is this a complete dsh install?')
    process.exit(1)
  }
  if (existsSync(link)) continue
  symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
  console.log('linked ' + name + ' -> ' + source)
}
console.log('llm-compat: dev dependencies are resolvable (harness at ' + harness + ')')
