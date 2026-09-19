/**
 * Build step: emit `lib/` from `src/`.
 *
 * No bundler and no TypeScript: the Host half is plain ESM and is copied
 * verbatim (including its `fixes/` subdirectory), while the client half is a
 * hand-written client-module bundle that receives three substitutions:
 *
 *   `__LLM_COMPAT_PACKAGE__`  the package name, read from `package.json`;
 *   `__LLM_COMPAT_CATALOG__`  the fix catalog serialized from `src/fixes/`;
 *   `__LLM_COMPAT_BUILD__`    a content stamp over every build input.
 *
 * The catalog substitution is what lets the browser half draw the enforced list
 * with no runtime channel to the Host, and it is generated FROM the catalog
 * rather than hand-copied, so the page cannot offer a switch the Host would
 * ignore. `lib/` is committed: installing this package from git then needs no
 * build step, because pnpm gates build scripts behind a per-commit allowlist.
 *
 *   node scripts/build.mjs            # write lib/
 *   node scripts/build.mjs --check    # fail when lib/ is not current
 *   node scripts/build.mjs --out DIR  # write somewhere else (used by tests)
 *
 * @module llm-for-dsh/scripts/build
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_ENABLED, describeFixes } from '../src/fixes/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Substitution tokens carried by `src/client.js`. */
const TOKEN_PACKAGE = '__LLM_COMPAT_PACKAGE__'
const TOKEN_CATALOG = '__LLM_COMPAT_CATALOG__'
const TOKEN_BUILD = '__LLM_COMPAT_BUILD__'

/** The manifest, read rather than restated: the bundle's module id must be the package name. */
export const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

/** `src/client.js` is substituted, never copied, so it is excluded from the verbatim set. */
const CLIENT_SOURCE = 'client.js'

/**
 * Every Host module under `src/`, relative to it.
 *
 * Discovered rather than listed: a module the entry point imports but the build
 * forgot would make `lib/index.js` fail at activation, which is exactly the kind
 * of omission a list invites.
 *
 * Paths are returned with `/` separators on every platform, so the build's file
 * list — and anything derived from it — is identical everywhere.
 *
 * @param dir - the directory to walk.
 * @param base - the tree root, for relative paths.
 * @returns source-relative paths of every Host module.
 */
export function hostModules(dir = join(root, 'src'), base = dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...hostModules(full, base))
    else if (entry.name.endsWith('.js') && entry.name !== CLIENT_SOURCE) found.push(relative(base, full).split(sep).join('/'))
  }
  return found.sort()
}

/**
 * Serialize the catalog for the browser half.
 *
 * It carries exactly what the settings page renders plus the defaults a namespace
 * with no stored section resolves to, so the page needs no other source.
 *
 * @returns the JSON text to embed.
 */
export function serializeCatalog() {
  return JSON.stringify({
    fixes: describeFixes(),
    defaults: { enabled: [...DEFAULT_ENABLED], hosts: [], diagnostics: false },
  })
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

/**
 * The build stamp: content, not time, so a rebuild of unchanged sources is
 * byte-identical and "is the committed bundle current?" stays answerable.
 *
 * @param parts - every build input, hashed in order.
 * @returns a short build id.
 */
function buildStamp(parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 12)
}

/**
 * Emit the build into one directory.
 *
 * @param outDir - the destination directory, created when absent.
 * @returns `{ stamp, files }` naming every file written.
 */
export function buildInto(outDir) {
  const modules = hostModules()
  const sources = modules.map((file) => [file, readFileSync(join(root, 'src', file), 'utf8')])
  const clientSource = readFileSync(join(root, 'src', CLIENT_SOURCE), 'utf8')
  for (const token of [TOKEN_PACKAGE, TOKEN_CATALOG, TOKEN_BUILD]) {
    if (!clientSource.includes(token)) throw new Error('src/client.js does not carry the ' + token + ' token')
  }
  const catalog = serializeCatalog()
  const stamp = buildStamp([...sources.map(([, text]) => text), clientSource, catalog])

  const written = []
  for (const [file, text] of sources) {
    const target = join(outDir, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    written.push(file)
  }
  const client = clientSource
    .replaceAll(TOKEN_CATALOG, catalog)
    .replaceAll(TOKEN_BUILD, JSON.stringify(stamp))
    .replaceAll(TOKEN_PACKAGE, JSON.stringify(PACKAGE_NAME))
  writeFileSync(join(outDir, CLIENT_SOURCE), client)
  written.push(CLIENT_SOURCE)
  return { stamp, files: written }
}

/**
 * Compare the committed `lib/` with a fresh build.
 *
 * @returns `{ ok, differences }`; a difference names each stale or missing file.
 */
export function verifyCommitted() {
  const expected = join(root, 'lib')
  const scratch = mkdtempSync(join(tmpdir(), 'llm-compat-build-'))
  try {
    buildInto(scratch)
    const differences = []
    const modules = [...hostModules(), CLIENT_SOURCE]
    for (const file of modules) {
      let built
      let committed
      try {
        built = readFileSync(join(scratch, file), 'utf8')
      } catch {
        differences.push(file + ' (not built)')
        continue
      }
      try {
        committed = readFileSync(join(expected, file), 'utf8')
      } catch {
        differences.push(file + ' (missing from lib/)')
        continue
      }
      if (built !== committed) differences.push(file + ' (stale)')
    }
    return { ok: differences.length === 0, differences }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Run the CLI. */
function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--check')) {
    const { ok, differences } = verifyCommitted()
    if (!ok) {
      console.error('lib/ is not current; run "node scripts/build.mjs":\n  ' + differences.join('\n  '))
      process.exit(1)
    }
    console.log('lib/ is current')
    return
  }
  const outIndex = argv.indexOf('--out')
  const outDir = outIndex === -1 ? join(root, 'lib') : join(process.cwd(), argv[outIndex + 1])
  const { stamp, files } = buildInto(outDir)
  console.log('built ' + files.length + ' file(s) into ' + outDir + ' (build ' + stamp + ')')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
