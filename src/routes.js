/**
 * Route paths shared by the Host half and the client bundle.
 *
 * A dependency-free module on purpose: `scripts/build.mjs` embeds these values
 * into the browser bundle, so importing the Host entry point (which needs the
 * harness packages) would make the build depend on a local install.
 *
 * @module llm-for-dsh/routes
 */

/** Same-origin route the settings page reads the log paths and clears them through. */
export const LOG_ROUTE = '/llm-compat/log'
