/**
 * Numeric bounds shared by the Host half, the settings schema, the build-time
 * catalog and the browser bundle.
 *
 * Dependency-free on purpose, exactly like `routes.js`: the build embeds these
 * values, so importing the Host entry point (which needs the harness packages)
 * would make the build depend on a local install.
 *
 * @module llm-for-dsh/limits
 */

/** Retries per request when the user has not chosen a number. */
export const DEFAULT_RETRY_ATTEMPTS = 2

/** Hard ceiling for one request's retries, so a stored document cannot spin forever. */
export const MAX_RETRY_ATTEMPTS = 5
