/**
 * Fix: echo the thinking block back on an OpenAI-Responses request.
 *
 * WHY THIS EXISTS
 *
 * A relay speaking the Responses protocol in thinking mode demands that the
 * previous turn's reasoning be passed back with the history. pi-ai's Responses
 * builder only replays a reasoning item that still carries its
 * `thinkingSignature`:
 *
 *     if (block.thinkingSignature) output.push(JSON.parse(block.thinkingSignature))
 *
 * and the signature is exactly what DSH drops when the durable replay state
 * stops being usable — a model or adapter switch, or a compaction that
 * re-indexes assistant content. `dsh-llm-pi-ai` then degrades the message
 * through `foreignAssistant()`, which rebuilds the thinking block WITHOUT a
 * signature, so the wire body carries the assistant's tool call with no
 * reasoning item before it and the gateway answers 400
 * ("The `reasoning_text` in the thinking mode must be passed back to the API").
 *
 * WHAT THIS DOES
 *
 * Immediately before each assistant turn's `function_call` / `custom_tool_call`
 * item, insert the reasoning items that turn produced. Two sources, in order:
 *
 *  1. the original reasoning item captured verbatim from the streamed response
 *     of that same turn (highest fidelity: it keeps the provider's `id` and
 *     whatever encrypted/summary payload it shipped), then
 *  2. the reasoning text that is still durable in the harness history, wrapped
 *     in a minimal reasoning item.
 *
 * If neither exists the request is left untouched — this fix never invents an
 * empty reasoning item, because a gateway that validates pairing is more likely
 * to reject a fabricated one than to accept a missing one.
 *
 * The function is pure: it mutates the parsed body it is handed and returns how
 * many items it inserted. All wiring lives in the interceptor.
 *
 * @module llm-for-dsh/fixes/responses-reasoning-echo
 */

/** The Responses path this fix owns; a gateway base URL carries a version prefix. */
const RESPONSES_SUFFIX = '/responses'

/** Content-part type the Responses schema uses for plain thinking text. */
const REASONING_TEXT_PART = 'reasoning_text'

/** Summary-part type the Responses schema uses for a reasoning summary. */
const SUMMARY_TEXT_PART = 'summary_text'

/** Item types that end one assistant turn at the wire level. */
const TOOL_CALL_ITEM_TYPES = new Set(['function_call', 'custom_tool_call'])

/**
 * The parsed gateway URL when it addresses the Responses endpoint, otherwise
 * `undefined`. A URL this module cannot parse is simply not ours.
 *
 * @param url - the absolute request URL.
 * @returns the parsed URL, or undefined.
 */
export function responsesUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return undefined
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  return path.endsWith(RESPONSES_SUFFIX) ? parsed : undefined
}

/**
 * Whether this fix can rewrite one parsed request body.
 *
 * The protocol is identified by the endpoint plus the array the Responses API
 * always sends, so an unrelated JSON POST to a path that merely ends the same
 * way is not touched.
 *
 * @param url - the absolute request URL.
 * @param body - the parsed JSON request body.
 * @returns true when {@link rewrite} should run.
 */
export function requestMatcher(url, body) {
  if (responsesUrl(url) === undefined) return false
  return body !== null && typeof body === 'object' && Array.isArray(body.input)
}

/**
 * Whether this fix wants to observe the streamed response of one URL.
 *
 * @param url - the absolute request URL.
 * @returns true when {@link createResponseObserver} should be attached.
 */
export function observes(url) {
  return responsesUrl(url) !== undefined
}

/** The model-facing strings of one reasoning item, in wire order. */
function reasoningTextOf(item) {
  const parts = []
  if (Array.isArray(item.summary)) {
    for (const part of item.summary) if (typeof part?.text === 'string') parts.push(part.text)
  }
  if (Array.isArray(item.content)) {
    for (const part of item.content) if (typeof part?.text === 'string') parts.push(part.text)
  }
  return parts.join('\n\n')
}

/**
 * A minimal reasoning item carrying recovered thinking text.
 *
 * No `id` is invented: ids are provider-minted, and a wrong one is rejected
 * where a missing one is often tolerated. Both the summary and the plain content
 * part are filled, because a gateway that names `reasoning_text` in its error
 * reads the content part while the UI-facing schema reads the summary.
 *
 * @param text - non-empty thinking text.
 * @returns one reasoning item.
 */
export function synthesizeReasoningItem(text) {
  return {
    type: 'reasoning',
    summary: [{ type: SUMMARY_TEXT_PART, text }],
    content: [{ type: REASONING_TEXT_PART, text }],
  }
}

/** A structured clone of one JSON value, so the stash is never aliased into a request. */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * The reasoning items to inject for one stash payload, or an empty list.
 *
 * @param payload - `{ items?, text? }` recorded for this turn.
 * @returns reasoning items, freshly cloned and text-complete.
 */
export function reasoningItemsFor(payload) {
  if (payload === null || typeof payload !== 'object') return []
  if (Array.isArray(payload.items) && payload.items.length > 0) {
    const items = payload.items.map(cloneItem).filter((item) => item !== undefined)
    if (items.length > 0) return items.map((item) => withReasoningText(item, payload.text))
  }
  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return [synthesizeReasoningItem(payload.text)]
  }
  return []
}

/** Whether an item already carries the schema's plain thinking-text part. */
function hasReasoningTextPart(item) {
  return (
    Array.isArray(item.content) &&
    item.content.some((part) => part !== null && typeof part === 'object' && part.type === REASONING_TEXT_PART && typeof part.text === 'string')
  )
}

/**
 * Carry the recovered thinking text in the schema's plain-text slot.
 *
 * A gateway's OWN reasoning item can arrive as `{ id, summary, type }` with no
 * content part at all — and the refusal this fix answers names exactly that
 * missing `reasoning_text`. A replayed item therefore keeps its id and summary
 * but gains the text part when it has none; an item that already carries one is
 * untouched, and so is one for which no text was recovered.
 *
 * @param item - a cloned reasoning item.
 * @param text - the thinking text recovered for this turn, if any.
 * @returns the item, possibly with a reasoning_text part added.
 */
export function withReasoningText(item, text) {
  if (hasReasoningTextPart(item)) return item
  if (typeof text !== 'string' || text.trim().length === 0) return item
  return { ...item, content: [{ type: REASONING_TEXT_PART, text }] }
}

/** A cloned reasoning item, or undefined when a stored item is not one. */
function cloneItem(item) {
  if (item === null || typeof item !== 'object' || item.type !== 'reasoning') return undefined
  return cloneJson(item)
}

/**
 * Insert the missing reasoning items into one parsed Responses request body.
 *
 * A turn boundary is any item that is neither the turn's own reasoning and
 * assistant message nor its tool calls — in practice a user message or a
 * `function_call_output`. At most one injection happens per turn: one reasoning
 * item covers every parallel tool call of that turn.
 *
 * @param body - the parsed request body; `input` is replaced when it changed.
 * @param context - `{ stash }`, the turn-to-reasoning index.
 * @returns how many reasoning items were inserted.
 */
export function rewrite(body, context) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.input)) return 0
  const stash = context?.stash
  if (stash === undefined) return 0

  const output = []
  let reasoningSeen = false
  let inserted = 0

  for (const item of body.input) {
    const type = item !== null && typeof item === 'object' ? item.type : undefined

    if (type === 'reasoning') {
      reasoningSeen = true
      output.push(item)
      continue
    }

    if (typeof type === 'string' && TOOL_CALL_ITEM_TYPES.has(type)) {
      if (!reasoningSeen && typeof item.call_id === 'string' && item.call_id.length > 0) {
        const injected = reasoningItemsFor(stash.lookup(item.call_id))
        if (injected.length > 0) {
          output.push(...injected)
          inserted += injected.length
          reasoningSeen = true
        }
      }
      output.push(item)
      continue
    }

    // Assistant text stays inside the turn; everything else ends it.
    const stays = type === 'message' && item?.role === 'assistant'
    if (!stays) reasoningSeen = false
    output.push(item)
  }

  if (inserted > 0) body.input = output
  return inserted
}

/**
 * Create the per-response observer that records what a turn produced.
 *
 * The stream is the only place the original reasoning item is available: DSH's
 * durable replay state is what goes missing, so the item has to be kept here as
 * it passes by. Collection happens on `response.output_item.done` (the finalized
 * item) and falls back to the terminal `response.completed` payload when a
 * gateway sends no per-item events.
 *
 * @returns an observer with `feed(event)` and `result()`.
 */
export function createResponseObserver() {
  const items = []
  const callIds = []
  let terminalOutputSeen = false

  const collect = (item) => {
    if (item === null || typeof item !== 'object') return
    if (item.type === 'reasoning') {
      items.push(item)
      return
    }
    if (TOOL_CALL_ITEM_TYPES.has(String(item.type)) && typeof item.call_id === 'string' && item.call_id.length > 0) {
      callIds.push(item.call_id)
    }
  }

  return {
    /**
     * Feed one decoded SSE event.
     * @param event - the parsed `data:` payload, or `[DONE]`.
     */
    feed(event) {
      if (event === null || typeof event !== 'object') return
      if (event.type === 'response.output_item.done') {
        collect(event.item)
        return
      }
      if (event.type === 'response.completed') {
        const output = event.response?.output
        if (Array.isArray(output)) {
          terminalOutputSeen = true
          if (items.length === 0 && callIds.length === 0) for (const item of output) collect(item)
        }
      }
    },
    /**
     * The turn's reasoning as it should be replayed.
     * @returns `{ callIds, items, text }`; `callIds` empty means nothing to record.
     */
    result() {
      const text = items.map(reasoningTextOf).filter((part) => part.length > 0).join('\n\n')
      return {
        callIds: [...callIds],
        items: terminalOutputSeen && items.length === 0 ? [] : items.map(cloneJson),
        text,
      }
    },
  }
}

/** Metadata the fix catalog and the settings page read; behavior lives above. */
export const metadata = {
  id: 'responses-reasoning-echo',
  title: '思考内容回传（Responses 协议）',
  hint: '命中 Responses 请求时，把该轮思考项补回 function_call 之前；上一轮响应捕获不到时，用历史里仍保留的思考文本合成。',
  detail:
    '第三方网关在 thinking 模式下要求随历史回传上一轮思考内容。DSH 在跨模型、跨适配器或压缩之后会丢掉思考签名，' +
    'pi-ai 的 Responses 分支只回传带签名的思考项，于是带工具调用的续轮被网关以 400 拒绝。' +
    '本修复只改写 /responses 请求，且在已有思考项时不动作。',
  defaultEnabled: false,
}
