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
import { dirname, join } from 'node:path'

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

/** Largest request body stored per rejection; the rest is dropped and the length is kept. */
export const MAX_REJECTED_BODY_CHARS = 262144

/**
 * Largest TAIL of a refused body stored beside the head.
 *
 * The head says how the history began; only the tail holds the newest turn, which
 * is the turn a thinking-mode gateway validates and the one whose shape has to be
 * compared against the head.
 */
export const MAX_REJECTED_TAIL_CHARS = 65536

/**
 * Create the log.
 *
 * @param options - optional path, initial state and clock, for tests.
 * @returns `setEnabled`, `enabled`, `write` and the resolved `path`.
 */
export function createDiagnosticLog(options = {}) {
  const path = typeof options.path === 'string' && options.path.length > 0 ? options.path : defaultLogPath()
  const rejectedPath = join(dirname(path), 'llm-compat-rejected.jsonl')
  const now = typeof options.now === 'function' ? options.now : Date.now
  let enabled = options.enabled === true

  return {
    path,
    /** Where a refused request body is recorded, beside the log. */
    rejectedPath,
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
    /**
     * Record one refused model request: the status, the provider's answer, and the
     * exact body this plugin sent.
     *
     * The summary line cannot say WHICH item a gateway objected to, and an
     * intermittent rejection is exactly the case where the body is the only
     * evidence. The body is the conversation, so it is written only while
     * diagnostics are on, into the operator's own harness home, and truncated past
     * {@link MAX_REJECTED_BODY_CHARS}.
     *
     * @param record - the refusal facts: url, status, changed, requestBody, responseBody.
     * @returns the path written to, or undefined when diagnostics are off.
     */
    dumpRejection(record) {
      if (!enabled) return undefined
      const body = typeof record?.requestBody === 'string' ? record.requestBody : ''
      const entry = {
        at: new Date(now()).toISOString(),
        url: record?.url,
        status: record?.status,
        changed: Array.isArray(record?.changed) ? record.changed : [],
        responseBody: String(record?.responseBody ?? '').slice(0, 4000),
        requestBodyLength: body.length,
        requestBodyTruncated: body.length > MAX_REJECTED_BODY_CHARS,
        requestBody: body.slice(0, MAX_REJECTED_BODY_CHARS),
        requestTailTruncated: body.length > MAX_REJECTED_TAIL_CHARS,
        requestTail: body.slice(-MAX_REJECTED_TAIL_CHARS),
        requestDigest: record?.digest,
      }
      try {
        appendFileSync(rejectedPath, JSON.stringify(entry) + '\n')
      } catch {
        // Diagnostics must never turn one failure into two.
      }
      return rejectedPath
    },
  }
}
