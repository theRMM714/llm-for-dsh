/**
 * The retry catalog: the single source of truth for which refusals are retried,
 * what the settings page shows, and what the interceptor enforces.
 *
 * ADDING A RULE is one module plus one row here; REMOVING ONE is deleting both.
 * Nothing else in the plugin names a rule id, so the framework stays a framework.
 *
 * Each entry carries:
 *  - `id` — stable key stored in the settings document;
 *  - `title` / `hint` — the settings page's copy;
 *  - `defaultEnabled` — the value a namespace with no stored section resolves to;
 *  - `matches({ status, bodyText, url })` — may this refusal be retried.
 *
 * @module llm-for-dsh/retries
 */
import { matches, metadata as reasoningTextNotPassedBack } from './reasoning-text-not-passed-back.js'

/** Every retry rule this build ships, in settings-page order. */
export const RETRIES = [
  {
    ...reasoningTextNotPassedBack,
    matches,
  },
]

/** Rule ids enabled for a namespace that has no stored user section. */
export const DEFAULT_RETRY_RULES = RETRIES.filter((rule) => rule.defaultEnabled).map((rule) => rule.id)

/**
 * Look one rule up by id.
 * @param id - the stored rule id.
 * @returns the rule, or undefined for an id this build does not know.
 */
export function retryById(id) {
  return RETRIES.find((rule) => rule.id === id)
}

/**
 * The serializable half of the catalog, embedded in the client bundle at build
 * time so the settings page draws the enforced list without a runtime channel.
 * @returns metadata for every rule.
 */
export function describeRetries() {
  return RETRIES.map((rule) => ({
    id: rule.id,
    title: rule.title,
    hint: rule.hint,
    defaultEnabled: rule.defaultEnabled === true,
  }))
}
