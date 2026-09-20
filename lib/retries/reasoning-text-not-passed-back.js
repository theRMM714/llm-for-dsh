/**
 * Retry rule: the gateway refused a thinking-mode request because the reasoning
 * was not passed back.
 *
 * WHY A RETRY RATHER THAN ANOTHER FIX. Measured on a real relay: a request whose
 * rewrite reported `gaps 0` across 259 items and 80 tool turns was accepted three
 * times in a row and refused on the fourth with this exact message. Nothing in the
 * request differs between those attempts — same coverage, same shapes, same order —
 * so the only remaining lever is to ask again, and this rule asks again for this
 * one message only.
 *
 * A retry here is a MODEL-CALL retry: the refusal happens on the continuation
 * request that follows a tool result, so re-sending it never re-runs a tool and
 * cannot duplicate a side effect.
 *
 * @module llm-for-dsh/retries/reasoning-text-not-passed-back
 */

/** The field the gateway names. */
const REASONING_FIELD = /reasoning_text/i

/** The demand it makes. Both halves are required, so an unrelated 400 never matches. */
const PASSED_BACK = /must be passed back/i

/**
 * Whether one refused response is this rule's business.
 *
 * @param context - `{ status, bodyText, url }`.
 * @returns true when the response is the thinking-mode pass-back refusal.
 */
export function matches(context) {
  if (context?.status !== 400) return false
  const text = typeof context?.bodyText === 'string' ? context.bodyText : ''
  return REASONING_FIELD.test(text) && PASSED_BACK.test(text)
}

/** Metadata the retry catalog and the settings page read; the predicate lives above. */
export const metadata = {
  id: 'reasoning-text-not-passed-back',
  title: '思考内容未回传（Responses 思考模式）',
  hint: '网关返回 400 且正文同时含 reasoning_text 与 must be passed back 时重试。实测同一份请求会时而通过、时而失败，属于网关侧的间歇行为，报文结构本身没有问题。',
  defaultEnabled: false,
}
