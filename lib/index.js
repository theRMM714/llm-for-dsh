/**
 * Host half of the LLM compatibility plugin.
 *
 * WHAT IT REGISTERS
 *
 *  1. The `llm-compat` settings namespace — the checkbox document the settings
 *     page writes and this half reads live.
 *  2. A READ-ONLY observer on the `llm/stream` waterfall, which indexes the
 *     durable thinking text of every request by the tool-call ids it carries.
 *     The request there is deep-frozen and must not be rewritten; observing it is
 *     the documented use of the seam.
 *  3. The outbound interceptor, which is the only writer. It is installed once
 *     for the whole process and consults the same settings document on every
 *     request, so a checkbox takes effect on the next model call with no restart.
 *
 * Every fix lives in `src/fixes/`; this module names none of them, so a fix can be
 * added or deleted without touching the framework.
 *
 * @module llm-for-dsh
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_ENABLED, fixById } from './fixes/index.js'
import { installFetchInterceptor, normalizeHosts } from './interceptor.js'
import { createDiagnosticLog, defaultLogPath } from './log.js'
import { createStash, harnessReasoningByCallId } from './stash.js'

/** Loader entry name; also the settings namespace. */
export const name = 'llm-compat'

/**
 * Hard dependencies.
 *
 * `settings` belongs here: an undeclared read of it answers undefined, which
 * would skip the namespace registration and leave the settings page read-only
 * with nothing logged anywhere. `llm` is declared because the request observer is
 * an `llm/stream` listener, and activation should wait for a runtime that can
 * dispatch it.
 */
export const inject = ['settings', 'llm']

/** The settings namespace holding the fix switches. */
export const NAMESPACE = 'llm-compat'

/**
 * Schema of the durable fix document.
 *
 * The defaults live HERE and not only in the composition `base`: a namespace with
 * no stored user section resolves an absent field through this schema, so a
 * default supplied elsewhere would be missing on a fresh install.
 */
export const Config = z.object({
  enabled: z.array(z.string()).default([...DEFAULT_ENABLED]).description('已启用的兼容修复项 id。'),
  hosts: z.array(z.string()).default([]).description('只对这些主机生效；留空表示所有主机。'),
  diagnostics: z.boolean().default(false).description('把每次改写写入诊断日志。'),
})

/**
 * Fold whatever the settings document holds into the shape the interceptor reads.
 *
 * Tolerant on purpose: an id this build no longer ships is dropped rather than
 * kept as a switch nobody can enforce, and a malformed subsection falls back to
 * the defaults instead of disabling the plugin.
 *
 * @param value - a resolved settings section or the composition entry.
 * @returns `{ enabled: Set<string>, hosts: string[], diagnostics: boolean }`.
 */
export function normalizeSettings(value) {
  const input = value !== null && typeof value === 'object' ? value : {}
  const configured = Array.isArray(input.enabled) ? input.enabled : DEFAULT_ENABLED
  const enabled = new Set()
  for (const id of configured) {
    if (typeof id === 'string' && fixById(id) !== undefined) enabled.add(id)
  }
  return {
    enabled,
    hosts: normalizeHosts(input.hosts),
    diagnostics: input.diagnostics === true,
  }
}

/**
 * Activation, contained.
 *
 * A throw out of the loader can cost the whole profile its boot, which a plugin
 * bug must not be able to do. The failure is logged loudly and the profile keeps
 * running with the stock (unfixed) request path.
 *
 * @param ctx - the plugin context.
 * @param entry - composition entry config, used as the settings base layer.
 */
export function apply(ctx, entry = {}) {
  try {
    setup(ctx, entry)
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(
      'llm-compat: activation failed, so no compatibility fix is applied and model requests go out unchanged. ' +
        'Fix this plugin or disable its row (set "disabled: !!js process.env.DSH_LLM_COMPAT_DISABLED === \'1\'" on the ' +
        'llm-compat row) and restart dsh. Cause: ' + detail,
    )
  }
}

/**
 * Activation without the containment wrapper, so a broken fixture fails a test
 * instead of being swallowed by {@link apply}'s catch.
 *
 * @param ctx - the plugin context.
 * @param entry - composition entry config, used as the settings base layer.
 * @returns the live state holder, for tests.
 */
export function setup(ctx, entry = {}) {
  const state = { current: normalizeSettings(entry), update: undefined }
  const stash = createStash()
  const log = createDiagnosticLog({ path: defaultLogPath(), enabled: state.current.diagnostics })

  const settings = ctx.settings ?? (typeof ctx.get === 'function' ? ctx.get('settings') : undefined)
  if (settings !== undefined) {
    const scope = settings.register(NAMESPACE, Config, { base: entry, applies: 'live' })
    ctx.effect(() => {
      const adopt = (value) => {
        state.current = normalizeSettings(value)
        log.setEnabled(state.current.diagnostics)
      }
      adopt(scope.get())
      const off = typeof scope.watch === 'function' ? scope.watch(adopt) : undefined
      return () => {
        if (typeof off === 'function') off()
      }
    }, 'llm-compat: settings scope')
    if (typeof settings.update === 'function') state.update = (patch) => settings.update(NAMESPACE, patch)
  }

  ctx.effect(() => {
    // `global: true` matches how the shipped `llm/stream` observers register
    // (`dsh-session-title`, the agent-loop invariant): the listener must receive
    // the event regardless of the dispatching context, while disposal stays owned
    // by this fiber.
    const off = ctx.on(
      'llm/stream',
      (options, next) => {
        try {
          for (const entry of harnessReasoningByCallId(options?.messages)) stash.record(entry.callIds, entry.payload)
        } catch (error) {
          log.write('llm/stream observation failed: ' + describe(error))
        }
        return next()
      },
      { global: true },
    )
    return () => {
      if (typeof off === 'function') off()
    }
  }, 'llm-compat: request observation')

  ctx.effect(
    () =>
      installFetchInterceptor({
        resolveSettings: () => state.current,
        stash,
        log: (line) => log.write(line),
      }),
    'llm-compat: outbound interceptor',
  )

  return { state, stash, log }
}

/** The message of an unknown thrown value. */
function describe(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
