/**
 * Turn-to-reasoning index.
 *
 * The wire body cannot be repaired from itself: by the time a degraded history
 * reaches the provider, the reasoning text has either been merged into the
 * assistant message or dropped along with its signature. Two observers therefore
 * feed this index, keyed by the tool-call id that survives both:
 *
 *  - `harnessReasoningByCallId()` reads the durable harness request at the
 *    `llm/stream` waterfall and recovers the reasoning text plus, when the
 *    replay envelope is still present, the original provider signature;
 *  - the interceptor records the reasoning items of every streamed response, so
 *    the exact item can be replayed verbatim instead of synthesized.
 *
 * Call ids are provider-minted and unique, so a single process-wide map cannot
 * cross-talk between concurrent sessions or subagents.
 *
 * @module llm-for-dsh/stash
 */

/** How long a recorded turn stays usable. */
export const DEFAULT_TTL_MS = 30 * 60 * 1000

/** Upper bound on recorded turns, evicted oldest first. */
export const DEFAULT_MAX_ENTRIES = 4096

/**
 * The stable half of one harness tool-call id.
 *
 * pi-ai encodes a tool call as `<call id>|<item id>` so the provider item id can
 * be dropped when it is not replayable, and every wire `call_id` is the half
 * before the separator.
 *
 * @param id - a harness tool-call id or a wire call id.
 * @returns the wire call id, or undefined for a value that is not one.
 */
export function callIdOf(id) {
  if (typeof id !== 'string' || id.length === 0) return undefined
  const separator = id.indexOf('|')
  const head = separator === -1 ? id : id.slice(0, separator)
  return head.length > 0 ? head : undefined
}

/**
 * Create the process-wide index.
 *
 * @param options - optional bounds and clock, for tests.
 * @returns `record`, `lookup`, `size` and `clear`.
 */
export function createStash(options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  /** Insertion-ordered, so the oldest entry is the first key. */
  const entries = new Map()

  function evict() {
    const deadline = now() - ttlMs
    for (const [key, entry] of entries) {
      if (entry.at >= deadline) break
      entries.delete(key)
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
  }

  return {
    /**
     * Index one turn's reasoning under every tool-call id it produced.
     * @param callIds - harness tool-call ids or wire call ids.
     * @param payload - `{ items?, text? }`; an empty payload is not recorded.
     */
    record(callIds, payload) {
      if (payload === null || typeof payload !== 'object') return
      const hasItems = Array.isArray(payload.items) && payload.items.length > 0
      const hasText = typeof payload.text === 'string' && payload.text.trim().length > 0
      if (!hasItems && !hasText) return
      const at = now()
      for (const raw of callIds ?? []) {
        const key = callIdOf(raw)
        if (key !== undefined) entries.set(key, { payload, at })
      }
      evict()
    },
    /**
     * The reasoning recorded for one wire call id.
     * @param callId - the wire call id.
     * @returns the payload, or undefined when nothing usable was recorded.
     */
    lookup(callId) {
      const key = callIdOf(callId)
      if (key === undefined) return undefined
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (now() - entry.at > ttlMs) {
        entries.delete(key)
        return undefined
      }
      entry.at = now()
      return entry.payload
    },
    /** How many turns are currently indexed. */
    size() {
      return entries.size
    },
    /** Drop every indexed turn. */
    clear() {
      entries.clear()
    },
  }
}

/**
 * Recover the original reasoning items from a durable replay envelope.
 *
 * The envelope is adapter-owned and versioned (`response.kind === 'pi-ai'`,
 * `version === 2`); anything else is ignored rather than guessed at, because
 * this path only ever adds fidelity on top of the durable text.
 *
 * @param replayState - `message.source.replayState`, of unknown shape.
 * @returns the parsed reasoning items, or undefined when there are none.
 */
export function replayReasoningItems(replayState) {
  const blocks = replayState?.blocks
  if (!Array.isArray(blocks)) return undefined
  const items = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || block.type !== 'reasoning') continue
    if (typeof block.thinkingSignature !== 'string' || block.thinkingSignature.length === 0) continue
    try {
      const item = JSON.parse(block.thinkingSignature)
      if (item !== null && typeof item === 'object' && item.type === 'reasoning') items.push(item)
    } catch {
      // A signature this build cannot parse is not a reason to lose the text path.
    }
  }
  return items.length > 0 ? items : undefined
}

/**
 * Everything one harness request is willing to contribute to the index.
 *
 * Only assistant messages that produced a tool call are indexed: those are the
 * ones a gateway pairs with a reasoning item.
 *
 * @param messages - `GenerateOptions.messages` from the `llm/stream` waterfall.
 * @returns one `{ callIds, payload }` per assistant turn that has tool calls.
 */
export function harnessReasoningByCallId(messages) {
  const found = []
  if (!Array.isArray(messages)) return found
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue
    if (!Array.isArray(message.content)) continue
    const callIds = []
    const texts = []
    for (const block of message.content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'tool-call' && typeof block.id === 'string') callIds.push(block.id)
      else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim().length > 0) texts.push(block.text)
    }
    if (callIds.length === 0) continue
    found.push({
      callIds,
      payload: {
        items: replayReasoningItems(message.source?.replayState),
        text: texts.join('\n\n'),
      },
    })
  }
  return found
}
