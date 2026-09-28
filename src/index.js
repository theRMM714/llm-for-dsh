/**
 * Host half of the LLM compatibility plugin.
 *
 * WHAT IT REGISTERS
 *
 *  1. The \`llm-compat\` settings entry: this plugin's own profile entry, whose
 *     editable fields are the \`Config\` members marked \`.volatile()\`. The settings
 *     page edits them through the configuration-form service, and the plugin
 *     reads the same references on demand — so a change reaches the next model
 *     call with no restart.
 *  2. A READ-ONLY observer on the \`llm/stream\` waterfall, which indexes the
 *     durable thinking text of every request by the tool-call ids it carries.
 *     The request there is deep-frozen and must not be rewritten; observing it is
 *     the documented use of the seam.
 *  3. The outbound interceptor, which is the only writer. It is installed once
 *     for the whole process and folds the config on every request, so a checkbox
 *     takes effect on the next model call with no restart.
 *
 * The plugin draws its own settings page, so it asks the settings service not to
 * generate one from the schema. That request is made through an optional child
 * scope: a profile without a settings service keeps running without a page.
 *
 * Every fix lives in \`src/fixes/\`; this module names none of them, so a fix can be
 * added or deleted without touching the framework.
 *
 * @module llm-for-dsh
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_ENABLED, fixById } from './fixes/index.js'
import { DEFAULT_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS } from './limits.js'
import { DEFAULT_RETRY_RULES, retryById } from './retries/index.js'
import { installFetchInterceptor, normalizeHosts } from './interceptor.js'
import { createDiagnosticLog, defaultLogPath } from './log.js'
import { LOG_ROUTE } from './routes.js'
import { createStash, harnessReasoningByCallId } from './stash.js'

/** Loader entry name; also the settings entry the page edits. */
export const name = 'llm-compat'

/**
 * Hard dependencies.
 *
 * \`llm\` is declared because the request observer is an \`llm/stream\` listener, and
 * activation should wait for a runtime that can dispatch it. \`settings\` is NOT
 * declared: it is reached through an optional child scope inside {@link setup}, so
 * a profile without it still activates.
 */
export const inject = ['llm']

/** The settings entry holding the fix switches. */
export const NAMESPACE = 'llm-compat'

/**
 * The same-origin route the settings page clears the diagnostics through.
 *
 * The page has no other channel to the Host — the fix catalog is embedded at build
 * time and the settings form only carries the fields — so the two log files are
 * reachable from the browser through here, exactly as the settings shell expects.
 * The path itself lives in \`routes.js\` because the client bundle embeds it too.
 */
export { LOG_ROUTE }

/**
 * Schema of the plugin's own profile entry.
 *
 * Every editable member is marked \`.volatile()\`: that is what the settings form
 * projects, and what the loader resolves into a reference the plugin can read at
 * any time. The defaults live HERE rather than only in the composition entry, so a
 * profile that never sets the field still resolves one.
 */
export const Config = z.object({
  enabled: z.array(z.string()).default([...DEFAULT_ENABLED]).description('已启用的兼容修复项 id。').volatile(),
  hosts: z.array(z.string()).default([]).description('只对这些主机生效；留空表示所有主机。').volatile(),
  diagnostics: z.boolean().default(false).description('把每次改写写入诊断日志。').volatile(),
  /** 只回放最近 N 轮思考；0 表示不限。长会话里注入量按降级轮数增长并每步重发。 */
  recentTurns: z.number().default(0).description('只回放最近 N 轮思考；0 表示不限。').volatile(),
  /** 思考项只写一个文本槽；关闭时同时写 summary 与 reasoning_text（保险但翻倍）。 */
  singleReasoningSlot: z.boolean().default(false).description('思考项只写一个文本槽。').volatile(),
  /** 某轮完全没有思考可回传时，补一个文本为单个空格的占位项。 */
  placeholderReasoning: z.boolean().default(false).description('没有思考可回传时补一个占位项。').volatile(),
  /** 把请求里所有思考项统一成只带 reasoning_text 内容槽的形状（去掉 summary）。 */
  reasoningTextOnly: z.boolean().default(false).description('思考项统一成只带 reasoning_text 的形状。').volatile(),
  /** 命中这些重试规则时，把同一个请求原样再发一次。 */
  retries: z.array(z.string()).default([...DEFAULT_RETRY_RULES]).description('启用的重试规则 id。').volatile(),
  /** 每个请求最多重试次数。 */
  retryAttempts: z.number().default(DEFAULT_RETRY_ATTEMPTS).description('每个请求最多重试次数。').volatile(),
})

/** The config members {@link readConfig} unfolds, in schema order. */
const CONFIG_FIELDS = [
  'enabled',
  'hosts',
  'diagnostics',
  'recentTurns',
  'singleReasoningSlot',
  'placeholderReasoning',
  'reasoningTextOnly',
  'retries',
  'retryAttempts',
]

/**
 * Whether one config member is a runtime reference.
 *
 * The loader resolves a \`.volatile()\` field into a frozen \`{ get() }\` reference whose
 * value only its owning runtime replaces. Duck-typed because that reference
 * protocol is the whole contract this module needs from it.
 *
 * @param value - one member of a resolved config.
 * @returns true when the member must be read through \`get()\`.
 */
function isReference(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

/**
 * Unfold a resolved config into plain values.
 *
 * A member is a reference under the loader; a plain value is accepted too, so a
 * composition entry, a test fixture and a live profile all read the same way.
 *
 * @param config - the resolved plugin config.
 * @returns plain values for every known field.
 */
export function readConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const values = {}
  for (const field of CONFIG_FIELDS) {
    const value = source[field]
    values[field] = isReference(value) ? value.get() : value
  }
  return values
}

/**
 * Fold a set of plain config values into the shape the interceptor reads.
 *
 * Tolerant on purpose: an id this build no longer ships is dropped rather than
 * kept as a switch nobody can enforce, and a malformed field falls back to the
 * defaults instead of disabling the plugin.
 *
 * @param value - a plain config value set.
 * @returns \`{ enabled: Set<string>, hosts: string[], diagnostics: boolean, ... }\`.
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
    recentTurns: Number.isInteger(input.recentTurns) && input.recentTurns > 0 ? input.recentTurns : 0,
    singleReasoningSlot: input.singleReasoningSlot === true,
    placeholderReasoning: input.placeholderReasoning === true,
    reasoningTextOnly: input.reasoningTextOnly === true,
    retries: new Set(
      (Array.isArray(input.retries) ? input.retries : DEFAULT_RETRY_RULES).filter(
        (id) => typeof id === 'string' && retryById(id) !== undefined,
      ),
    ),
    retryAttempts: (() => {
      const chosen = Number.isInteger(input.retryAttempts) ? input.retryAttempts : DEFAULT_RETRY_ATTEMPTS
      if (chosen <= 0) return 0
      return Math.min(chosen, MAX_RETRY_ATTEMPTS)
    })(),
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
 * @param config - the resolved plugin config.
 */
export function apply(ctx, config = {}) {
  try {
    setup(ctx, config)
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
 * @param config - the resolved plugin config.
 * @returns the live handles, for tests.
 */
export function setup(ctx, config = {}) {
  const stash = createStash()
  const log = createDiagnosticLog({ path: defaultLogPath(), enabled: readConfig(config).diagnostics === true })

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  }

  /**
   * Fold the config as it stands right now.
   *
   * Called per request rather than cached, because a settings edit replaces the
   * reference's value and the interceptor must see it on the next call.
   *
   * @returns the folded settings the interceptor reads.
   */
  const current = () => {
    const folded = normalizeSettings(readConfig(config))
    log.setEnabled(folded.diagnostics)
    return folded
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

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
          kind: 'exact',
          path: LOG_ROUTE,
          handler: async (req, res) => {
            /** One JSON response, with the headers a fetch from the page needs. */
            const respond = (payload, status = 200) => {
              res.statusCode = status
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.end(JSON.stringify(payload))
            }
            try {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              if (url.searchParams.get('action') === 'clear') {
                const cleared = log.clear()
                // Written AFTER clearing, so the file the operator opens next
                // starts with the record of who emptied it.
                log.write('log.cleared')
                const paths = log.paths()
                respond({ ...paths, cleared, ok: cleared.length > 0 })
                return
              }
              respond(log.paths())
            } catch (error) {
              respond({ error: describe(error) }, 500)
            }
          },
          }),
        'llm-compat: log route',
      )
    })
  }

  ctx.effect(
    () =>
      installFetchInterceptor({
        resolveSettings: current,
        stash,
        log: (line) => log.write(line),
        onRejection: (record) => {
          const path = log.dumpRejection(record)
          if (path !== undefined) {
            log.write('refused ' + String(record.status) + ' ' + String(record.url) + ' -> ' + path)
          }
        },
      }),
    'llm-compat: outbound interceptor',
  )

  return { config, current, stash, log }
}

/** The message of an unknown thrown value. */
function describe(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
