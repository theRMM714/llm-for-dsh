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

/**
 * Text used when a turn produced no thinking anywhere.
 *
 * A single space rather than an empty string: the refusal this option answers is
 * about the item being passed back at all, and a schema that trims or rejects an
 * empty part still accepts a blank one. The item is never invented unless the
 * operator turns the option on.
 */
const PLACEHOLDER_TEXT = ' '

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
 * where a missing one is often tolerated.
 *
 * By default BOTH text slots are filled — the schema's summary and the plain
 * `reasoning_text` part — because the refusal this fix answers names the latter
 * while the presentation schema reads the former, and the doubled copy is the
 * price of not knowing which one a particular gateway validates.
 * `singleReasoningSlot` drops the summary copy, halving the injected text at the
 * cost of that insurance.
 *
 * @param text - non-empty thinking text.
 * @param options - `{ singleReasoningSlot }`.
 * @returns one reasoning item.
 */
export function synthesizeReasoningItem(text, options = {}) {
  const content = [{ type: REASONING_TEXT_PART, text }]
  if (options.singleReasoningSlot === true) return { type: 'reasoning', content }
  return {
    type: 'reasoning',
    summary: [{ type: SUMMARY_TEXT_PART, text }],
    content,
  }
}

/** A structured clone of one JSON value, so the stash is never aliased into a request. */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * The reasoning items to inject for one stash payload, or an empty list.
 *
 * A captured item is the gateway's OWN item, so under `singleReasoningSlot` it is
 * replayed exactly as it was sent — no invented content part, which is both the
 * smaller and the more faithful choice.
 *
 * @param payload - `{ items?, text? }` recorded for this turn.
 * @param options - `{ singleReasoningSlot }`.
 * @returns reasoning items, freshly cloned.
 */
export function reasoningItemsFor(payload, options = {}) {
  /** The last resort: an item exists only to satisfy a presence check. */
  const placeholder = () => (options.placeholderReasoning === true ? [synthesizeReasoningItem(PLACEHOLDER_TEXT, options)] : [])
  // A turn outside the recent window exists to satisfy COVERAGE, not to carry
  // text: re-sending megabytes of old thinking is what a long session cannot
  // afford, so such a turn only ever gets the placeholder.
  if (options.recoveredText === false) return placeholder()
  if (payload === null || typeof payload !== 'object') return placeholder()
  if (Array.isArray(payload.items) && payload.items.length > 0) {
    const items = payload.items.map(cloneItem).filter((item) => item !== undefined)
    if (items.length > 0) {
      if (options.singleReasoningSlot === true) return items
      return items.map((item) => withReasoningText(item, payload.text))
    }
  }
  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return [synthesizeReasoningItem(payload.text, options)]
  }
  return placeholder()
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
 * The reasoning item belongs at the START of its turn: the Responses protocol
 * orders a turn's items as reasoning, then the assistant message, then the tool
 * calls — which is exactly how pi-ai emits the ones it can replay itself. A fix
 * that inserted the item just before the tool call leaves a turn that also has
 * assistant text looking like `message, reasoning, function_call`: the wrong
 * order, and the very thing a gateway validates when it complains that the
 * thinking was not passed back.
 *
 * @param context - `{ stash, recentTurns?, singleReasoningSlot? }`. `recentTurns`
 *   bounds the work to the newest N assistant turns (0 or absent means every turn),
 *   which is what keeps a long session from re-sending megabytes of old thinking.
 * @returns how many reasoning items were inserted.
 */
export function rewrite(body, context) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.input)) return 0
  const stash = context?.stash
  if (stash === undefined) return 0

  const output = []
  /** One entry per assistant turn, in wire order; `start` indexes into `output`. */
  const turns = []
  let current = null
  let inserted = 0

  for (const item of body.input) {
    const type = item !== null && typeof item === 'object' ? item.type : undefined

    if (type === 'reasoning') {
      if (current === null) current = openTurn(output, turns)
      current.hasReasoning = true
      output.push(item)
      continue
    }

    if (typeof type === 'string' && TOOL_CALL_ITEM_TYPES.has(type)) {
      if (current === null) current = openTurn(output, turns)
      if (current.callId === undefined && typeof item.call_id === 'string' && item.call_id.length > 0) {
        current.callId = item.call_id
      }
      output.push(item)
      continue
    }

    // Assistant text stays inside the turn; everything else ends it.
    const stays = type === 'message' && item?.role === 'assistant'
    if (stays) {
      if (current === null) current = openTurn(output, turns)
    } else {
      current = null
    }
    output.push(item)
  }

  const options = {
    singleReasoningSlot: context?.singleReasoningSlot === true,
    placeholderReasoning: context?.placeholderReasoning === true,
  }
  // Every turn is a candidate — the gateway validates the whole window. The bound
  // decides which turns may carry RECOVERED TEXT; a turn before it still gets the
  // (tiny) placeholder, so coverage never depends on how long the session is.
  const recent = Number.isInteger(context?.recentTurns) && context.recentTurns > 0 ? context.recentTurns : 0
  const firstRecent = recent === 0 ? 0 : Math.max(0, turns.length - recent)

  // Inject newest first, so a `start` recorded earlier stays valid.
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn.hasReasoning || turn.callId === undefined) continue
    const optionsForTurn = { ...options, recoveredText: recent === 0 || index >= firstRecent }
    const injected = reasoningItemsFor(stash.lookup(turn.callId), optionsForTurn)
    if (injected.length === 0) continue
    output.splice(turn.start, 0, ...injected)
    inserted += injected.length
  }

  if (inserted > 0) body.input = output
  return inserted
}

/** Record a turn whose items start at the current end of the output. */
function openTurn(output, turns) {
  const turn = { start: output.length, hasReasoning: false, callId: undefined }
  turns.push(turn)
  return turn
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
  /**
   * Options this fix reads, rendered by the settings page from this declaration
   * rather than from hard-coded copy, so a new option is one entry here.
   */
  options: [
    {
      id: 'recentTurns',
      kind: 'number',
      title: '最近 N 轮写真实思考文本',
      hint: '每一轮的缺项都会补上；这里只决定哪几轮用真实文本。N=0（默认）表示每一轮都用真实文本；填 1 则只有最新一轮用真实文本，更早的缺项轮改用单空格占位项——覆盖面不变，注入量从约 1 MB 降到几 KB（需要同时开启「没有思考时补一个占位项」）。',
      min: 0,
    },
    {
      id: 'placeholderReasoning',
      kind: 'boolean',
      title: '没有思考时补一个占位项',
      hint: '提供方某一轮可能完全不回传思考（模型只吐工具调用）。开启后，这类轮次会补一个文本为单个空格的思考项，只为满足「必须回传」的存在性检查；关闭则不改写（默认）。',
    },
    {
      id: 'singleReasoningSlot',
      kind: 'boolean',
      title: '思考项只写一个文本槽',
      hint: '默认同时写 summary 与 reasoning_text（保险，但文本翻倍）。开启后合成项只写 reasoning_text，捕获到的原始项原样回放，注入文本约减半。',
    },
  ],
}
