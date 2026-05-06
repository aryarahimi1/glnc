/**
 * src/output/stderr.js
 *
 * Helpers that route human chatter (warnings, progress, hints) to stderr
 * when JSON / NDJSON mode is active so stdout stays pipe-clean. In pretty
 * mode these still write to stderr — that's where warnings always belong;
 * stdout is reserved for the actual data the user asked for.
 */

/**
 * @param {string} msg
 */
export function info(msg) {
  process.stderr.write(msg + '\n');
}

/**
 * @param {string} msg
 */
export function warn(msg) {
  process.stderr.write('Warning: ' + msg + '\n');
}
