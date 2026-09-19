/**
 * The outbound interceptor: the one seam where a fix may touch the wire.
 *
 * WHY A FETCH WRAPPER. DSH's request seam deliberately cannot be rewritten: the
 * `llm/stream` waterfall hands a LOOP-built request over deep-frozen, because the
 * request is a pure function of the session log. The fixes here are not about
 * the harness request at all — they are about the provider wire format, which is
 * produced INSIDE the adapter (pi-ai). Every provider stack in this process ends
 * at `globalThis.fetch` (the OpenAI and Anthropic SDKs both capture it when they
 * build a client), so wrapping that function is the narrowest place that sees the
 * final body. The `llm/stream` waterfall is still used, read-only, to learn the
 * durable thinking text the wire body lost.
 *
 * SAFETY RULES, in force for every fix:
 *  - only POST requests whose body is a JSON string are considered;
 *  - only enabled fixes, and only on allowed hosts, may look at the body;
 *  - any parse failure, matcher refusal or fix exception sends the ORIGINAL
 *    request untouched (the wrapper never becomes the reason a model call fails);
 *  - the wrapper is removed on dispose and restored only if it is still ours.
 *
 * @module llm-for-dsh/interceptor
 */
import { FIXES } from './fixes/index.js'

/** Request methods that can carry a model request body. */
const REWRITABLE_METHOD = 'POST'

/**
 * Whether a request URL is on an allowed host.
 *
 * An empty list means every host, which is what a namespace with no stored
 * section resolves to; the list exists so an operator can pin a fix to the one
 * gateway that needs it.
 *
 * @param url - the absolute request URL.
 * @param hosts - allowed hostnames; empty allows everything.
 * @returns true when the request may be inspected.
 */
export function hostAllowed(url, hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) return true
  let hostname
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return hosts.some((host) => {
    const wanted = String(host).toLowerCase()
    return wanted.length > 0 && (hostname === wanted || hostname.endsWith('.' + wanted))
  })
}

/**
 * Normalize the operator's host list: lowercase, scheme and path stripped, so a
 * pasted URL and a bare hostname mean the same thing.
 *
 * @param hosts - whatever the settings document holds.
 * @returns deduplicated hostnames in input order.
 */
export function normalizeHosts(hosts) {
  if (!Array.isArray(hosts)) return []
  const seen = new Set()
  const result = []
  for (const raw of hosts) {
    if (typeof raw !== 'string') continue
    let value = raw.trim().toLowerCase()
    if (value.length === 0) continue
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    const slash = value.indexOf('/')
    if (slash !== -1) value = value.slice(0, slash)
    const colon = value.indexOf(':')
    if (colon !== -1) value = value.slice(0, colon)
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** Deliver the payload accumulated for one event, if any. */
function flushSse(state, onEvent) {
  if (state.data.length === 0) return
  const payload = state.data.join('\n')
  state.data.length = 0
  if (payload === '[DONE]') return
  try {
    onEvent(JSON.parse(payload))
  } catch {
    // A malformed event is not a reason to stop observing the stream.
  }
}

/**
 * Apply one already-terminated line: a blank line emits the event, a \`data:\` line
 * accumulates a field, and every other field (and comment) is ignored.
 *
 * @param state - the line and data-field buffer.
 * @param line - one line without its terminator.
 * @param onEvent - called with each decoded payload.
 */
function consumeLine(state, line, onEvent) {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (text.length === 0) {
    flushSse(state, onEvent)
    return
  }
  if (text.startsWith(':')) return
  const colon = text.indexOf(':')
  const field = colon === -1 ? text : text.slice(0, colon)
  if (field !== 'data') return
  let value = colon === -1 ? '' : text.slice(colon + 1)
  if (value.startsWith(' ')) value = value.slice(1)
  state.data.push(value)
}

/**
 * Consume whole lines out of the buffer, emitting one event per blank line.
 *
 * @param state - the line and data-field buffer.
 * @param onEvent - called with each decoded payload.
 */
function feedSse(state, onEvent) {
  let index
  while ((index = state.buffer.indexOf('\n')) !== -1) {
    const line = state.buffer.slice(0, index)
    state.buffer = state.buffer.slice(index + 1)
    consumeLine(state, line, onEvent)
  }
}

/**
 * Finish a stream: a gateway may end it without the blank line that closes the
 * last event, so the trailing partial line is applied and whatever it left
 * pending is emitted. That last event is often the terminal one.
 *
 * @param state - the line and data-field buffer.
 * @param onEvent - called with each decoded payload.
 */
function finishSse(state, onEvent) {
  const trailing = state.buffer
  state.buffer = ''
  if (trailing.length > 0) consumeLine(state, trailing, onEvent)
  flushSse(state, onEvent)
}

/** Total thinking text carried by one reasoning item. */
function reasoningTextLength(item) {
  const parts = []
  if (Array.isArray(item.summary)) parts.push(...item.summary)
  if (Array.isArray(item.content)) parts.push(...item.content)
  return parts.reduce((total, part) => total + (typeof part?.text === 'string' ? part.text.length : 0), 0)
}

/**
 * A compact structural description of one outgoing body.
 *
 * A rejected body is megabytes of conversation, and the useful part is the SHAPE
 * of its last turns: which items they carry, in what order, and whether the
 * thinking text is present. This digest is small enough to read at a glance and
 * survives even when the raw body is truncated, so an intermittent rejection can
 * be compared turn by turn.
 *
 * @param body - the parsed request body that is about to be sent.
 * @returns `{ items, tail }` for the last turns, or undefined for an unknown shape.
 */
export function describeRequestBody(body) {
  if (body === null || typeof body !== 'object') return undefined
  const list = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : undefined
  if (list === undefined) return undefined
  const describe = (item) => {
    if (item === null || typeof item !== 'object') return { t: typeof item }
    const type = item.type ?? item.role ?? 'unknown'
    if (type === 'reasoning') {
      return {
        t: 'reasoning',
        id: typeof item.id === 'string' && item.id.length > 0 ? 'provider' : 'none',
        parts: Array.isArray(item.content) ? item.content.map((part) => part?.type).join('+') : '',
        text: reasoningTextLength(item),
      }
    }
    if (TOOL_CALL_TYPES.has(String(type))) return { t: type, call_id: item.call_id, name: item.name }
    if (type === 'function_call_output') return { t: 'function_call_output', call_id: item.call_id }
    if (type === 'message' && Array.isArray(item.content)) {
      return { t: 'message', role: item.role, parts: item.content.map((part) => part?.type).join('+') }
    }
    return { t: type }
  }
  return { items: list.length, tail: list.slice(-24).map(describe) }
}

/** Item types that answer with a tool call. */
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call'])

/** A copy of one Headers-ish value with `content-length` dropped. */
function withoutContentLength(headers) {
  const copy = new Headers(headers ?? {})
  copy.delete('content-length')
  return copy
}

/**
 * Create the request writer and response observer pair.
 *
 * @param options - `{ resolveSettings, stash, log?, fixes? }`; `fixes` defaults to
 *   the shipped catalog and exists so tests can inject a throwing fix.
 * @returns `{ rewriteRequest, startCapture }`.
 */
export function createWriter(options) {
  const resolveSettings = options.resolveSettings
  const stash = options.stash
  const log = typeof options.log === 'function' ? options.log : () => {}
  const fixes = Array.isArray(options.fixes) ? options.fixes : FIXES
  const byId = new Map(fixes.map((fix) => [fix.id, fix]))

  return {
    /**
     * Rewrite one outgoing body, or answer undefined to send it untouched.
     * @param url - the absolute request URL.
     * @param method - the request method.
     * @param bodyText - the serialized JSON body.
     * @returns `{ body, changed }` when a fix changed something.
     */
    rewriteRequest(url, method, bodyText) {
      if (String(method).toUpperCase() !== REWRITABLE_METHOD) return undefined
      if (typeof bodyText !== 'string' || bodyText.length === 0 || bodyText[0] !== '{') return undefined
      const settings = resolveSettings()
      if (settings === undefined || settings.enabled.size === 0) return undefined
      if (!hostAllowed(url, settings.hosts)) return undefined
      let body
      try {
        body = JSON.parse(bodyText)
      } catch {
        return undefined
      }
      const changed = []
      for (const id of settings.enabled) {
        const fix = byId.get(id)
        if (fix === undefined) continue
        try {
          if (fix.requestMatcher(url, body) !== true) continue
          const count = fix.rewrite(body, {
            stash,
            recentTurns: settings.recentTurns,
            singleReasoningSlot: settings.singleReasoningSlot,
          })
          if (count > 0) changed.push(id + '(' + String(count) + ')')
        } catch (error) {
          log('fix ' + id + ' threw for ' + url + ': ' + describe(error))
        }
      }
      if (changed.length === 0) return undefined
      const serialized = JSON.stringify(body)
      log('rewrote ' + url + ' via ' + changed.join(', ') + ' (' + String(serialized.length) + ' bytes)')
      return { body: serialized, changed, digest: describeRequestBody(body) }
    },

    /**
     * Observe the streamed response so a later request can replay it verbatim.
     *
     * The clone is taken BEFORE the caller reads the body; the returned promise
     * settles when the observation has drained, which tests await and production
     * deliberately does not.
     *
     * @param url - the absolute request URL.
     * @param response - the live Response.
     * @returns a promise, or undefined when nothing observes this URL.
     */
    startCapture(url, response) {
      const settings = resolveSettings()
      if (settings === undefined || settings.enabled.size === 0) return undefined
      if (!hostAllowed(url, settings.hosts)) return undefined
      if (response === null || typeof response !== 'object') return undefined
      if (response.body === null || response.body === undefined) return undefined
      const contentType =
        typeof response.headers?.get === 'function' ? String(response.headers.get('content-type') ?? '') : ''
      if (!contentType.includes('text/event-stream')) return undefined

      const observers = []
      for (const id of settings.enabled) {
        const fix = byId.get(id)
        if (fix === undefined || typeof fix.createResponseObserver !== 'function') continue
        if (typeof fix.observes === 'function' && fix.observes(url) !== true) continue
        observers.push({ id, observer: fix.createResponseObserver() })
      }
      if (observers.length === 0) return undefined

      let clone
      try {
        clone = response.clone()
      } catch {
        return undefined
      }

      return (async () => {
        const state = { buffer: '', data: [] }
        const deliver = (event) => {
          for (const entry of observers) {
            try {
              entry.observer.feed(event)
            } catch (error) {
              log('observer ' + entry.id + ' threw: ' + describe(error))
            }
          }
        }
        const reader = clone.body.getReader()
        const decoder = new TextDecoder()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done === true) break
            state.buffer += decoder.decode(value, { stream: true })
            feedSse(state, deliver)
          }
          // EOF: apply the trailing partial line and emit whatever it left pending.
          finishSse(state, deliver)
        } finally {
          try {
            await reader.cancel()
          } catch {
            // The caller owns the other branch; cancelling ours is best effort.
          }
          for (const entry of observers) {
            try {
              const result = entry.observer.result()
              if (result.callIds.length === 0) continue
              stash.record(result.callIds, { items: result.items, text: result.text })
              log('captured ' + String(result.callIds.length) + ' call id(s) for ' + entry.id)
            } catch (error) {
              log('observer ' + entry.id + ' result threw: ' + describe(error))
            }
          }
        }
      })()
    },
  }
}

/** The message of an unknown thrown value. */
function describe(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Resolve one fetch call into the facts the writer needs.
 *
 * Only POSTs are considered, and only when a JSON body can be reached WITHOUT
 * stealing it from the caller: a string body is used as-is, and a Request body is
 * read from a clone.
 *
 * @param input - the fetch first argument.
 * @param init - the fetch second argument.
 * @returns `{ url, method, bodyText, source }`, or undefined to pass through.
 */
async function resolveCall(input, init) {
  const method = String(init?.method ?? (typeof input?.method === 'string' ? input.method : 'GET')).toUpperCase()
  if (method !== REWRITABLE_METHOD) return undefined
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : typeof input?.url === 'string'
          ? input.url
          : undefined
  if (url === undefined) return undefined
  if (typeof init?.body === 'string') return { url, method, bodyText: init.body, source: 'init' }
  if (input instanceof Request && typeof input.clone === 'function') {
    try {
      const bodyText = await input.clone().text()
      return { url, method, bodyText, source: 'request' }
    } catch {
      return { url, method, bodyText: undefined, source: 'request' }
    }
  }
  return undefined
}

/**
 * Replace `globalThis.fetch` with the intercepting wrapper.
 *
 * @param options - `{ resolveSettings, stash, log?, fixes?, onRejection? }` for
 *   {@link createWriter}. `onRejection` is called once per refused request with the
 *   facts needed to diagnose it, including the exact body that was sent.
 * @returns the disposer that restores the original fetch.
 */
export function installFetchInterceptor(options) {
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => {}
  const writer = createWriter(options)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const onRejection = typeof options.onRejection === 'function' ? options.onRejection : undefined

  const wrapped = async function fetch(input, init) {
    let resolved
    try {
      resolved = await resolveCall(input, init)
    } catch {
      resolved = undefined
    }
    if (resolved === undefined) return original.call(this, input, init)

    let rewritten
    if (typeof resolved.bodyText === 'string') {
      try {
        rewritten = writer.rewriteRequest(resolved.url, resolved.method, resolved.bodyText)
      } catch (error) {
        log('interceptor refused a rewrite for ' + resolved.url + ': ' + describe(error))
        rewritten = undefined
      }
    }

    let response
    if (rewritten === undefined) {
      response = await original.call(this, input, init)
    } else if (resolved.source === 'init') {
      response = await original.call(this, resolved.url, {
        ...init,
        headers: withoutContentLength(init.headers),
        body: rewritten.body,
      })
    } else {
      response = await original.call(this, new Request(input, {
        headers: withoutContentLength(input.headers),
        body: rewritten.body,
      }))
    }

    try {
      const capturing = writer.startCapture(resolved.url, response)
      if (capturing !== undefined) void capturing.catch((error) => log('capture failed: ' + describe(error)))
    } catch (error) {
      log('capture attach failed: ' + describe(error))
    }

    try {
      const status = typeof response?.status === 'number' ? response.status : undefined
      if (status !== undefined) {
        log('resp ' + String(status) + ' ' + resolved.url + (rewritten === undefined ? '' : ' after ' + rewritten.changed.join(', ')))
      }
      if (onRejection !== undefined && status !== undefined && status >= 400) {
        // The provider's own words plus the body we sent: the summary line alone
        // cannot say which item a gateway objected to.
        const sentBody = rewritten?.body ?? (typeof resolved.bodyText === 'string' ? resolved.bodyText : undefined)
        const changed = rewritten?.changed ?? []
        void (async () => {
          let responseBody = ''
          try {
            responseBody = await response.clone().text()
          } catch {
            // An unreadable error body still leaves the request body to inspect.
          }
          try {
            onRejection({
              url: resolved.url,
              status,
              changed,
              requestBody: sentBody,
              responseBody,
              digest: rewritten?.digest,
            })
          } catch (error) {
            log('rejection dump failed: ' + describe(error))
          }
        })()
      }
    } catch (error) {
      log('outcome inspection failed: ' + describe(error))
    }
    return response
  }

  globalThis.fetch = wrapped
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original
  }
}
