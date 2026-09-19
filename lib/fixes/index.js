/**
 * The fix catalog: the single source of truth for which compatibility fixes
 * exist, what the settings page shows, and what the Host enforces.
 *
 * ADDING A FIX is one module plus one row here. REMOVING ONE is deleting both.
 * Nothing else in the plugin names a fix id, so the framework stays a framework.
 *
 * Each entry carries:
 *  - `id` — stable key stored in the settings document;
 *  - `title` / `hint` / `detail` — the settings page's copy;
 *  - `defaultEnabled` — the value a namespace with no stored section resolves to;
 *  - `requestMatcher(url, body)` — may this fix rewrite this parsed request;
 *  - `rewrite(body, context)` — mutate the parsed body, return the change count;
 *  - `observes(url)` / `createResponseObserver()` — optional response capture.
 *
 * @module llm-for-dsh/fixes
 */
import {
  createResponseObserver,
  metadata as responsesReasoningEcho,
  observes,
  requestMatcher,
  rewrite,
} from './responses-reasoning-echo.js'

/** Every fix this build ships, in settings-page order. */
export const FIXES = [
  {
    ...responsesReasoningEcho,
    requestMatcher,
    rewrite,
    observes,
    createResponseObserver,
  },
]

/** Fix ids enabled for a namespace that has no stored user section. */
export const DEFAULT_ENABLED = FIXES.filter((fix) => fix.defaultEnabled).map((fix) => fix.id)

/**
 * Look one fix up by id.
 * @param id - the stored fix id.
 * @returns the fix, or undefined for an id this build does not know.
 */
export function fixById(id) {
  return FIXES.find((fix) => fix.id === id)
}

/**
 * The serializable half of the catalog, embedded in the client bundle at build
 * time so the settings page draws the enforced list without a runtime channel.
 * @returns metadata for every fix.
 */
export function describeFixes() {
  return FIXES.map((fix) => ({
    id: fix.id,
    title: fix.title,
    hint: fix.hint,
    detail: fix.detail,
    defaultEnabled: fix.defaultEnabled === true,
    /** Options this fix reads; the settings page renders one control per entry. */
    options: Array.isArray(fix.options) ? fix.options.map((option) => ({ ...option })) : [],
  }))
}
