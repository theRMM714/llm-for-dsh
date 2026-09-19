/**
 * Diagnostic log for the compatibility fixes.
 *
 * The only file this plugin writes, and only when the operator turns diagnostics
 * on: a rewrite that silently changes a model request is exactly the kind of
 * thing that has to be inspectable after the fact, especially while the shape a
 * gateway accepts is still being determined. Failures here are swallowed
 * entirely — a diagnostic must never be able to break a model call.
 *
 * @module llm-for-dsh/log
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the diagnostic log lives: beside the harness home, like every other
 * plugin log in this ecosystem, so it survives a profile rebuild.
 *
 * @param env - the environment to read DSH_HOME from.
 * @returns the absolute log path.
 */
export function defaultLogPath(env = process.env) {
  const home =
    typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0
      ? env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(home, 'llm-compat.log')
}

/**
 * Create the log.
 *
 * @param options - optional path, initial state and clock, for tests.
 * @returns `setEnabled`, `enabled`, `write` and the resolved `path`.
 */
export function createDiagnosticLog(options = {}) {
  const path = typeof options.path === 'string' && options.path.length > 0 ? options.path : defaultLogPath()
  const now = typeof options.now === 'function' ? options.now : Date.now
  let enabled = options.enabled === true

  return {
    path,
    /** Whether writes currently reach the file. */
    enabled() {
      return enabled
    },
    /**
     * Turn diagnostics on or off; takes effect on the next write.
     * @param value - the new state.
     */
    setEnabled(value) {
      enabled = value === true
    },
    /**
     * Append one line. Never throws.
     * @param line - the message; stored with a timestamp.
     */
    write(line) {
      if (!enabled) return
      try {
        appendFileSync(path, JSON.stringify({ at: new Date(now()).toISOString(), line: String(line) }) + '\n')
      } catch {
        // A log that cannot be written must not fail the request it describes.
      }
    },
  }
}
