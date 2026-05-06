/**
 * src/output/emit.js
 *
 * The single chokepoint that writes JSON / NDJSON to stdout. All other
 * console.log paths are for human (TTY) output; anything routed through
 * here is part of glnc's stable machine API.
 *
 * Single-document mode (`emitJSON`): one envelope, optionally pretty-printed
 * when stdout is a TTY (terminal-readable) but always single-line when piped
 * to a file or another process so jq parses without `slurp`.
 *
 * Stream mode (`emitNDJSON`): one envelope per line, never pretty, suitable
 * for `glnc balance ... --watch --json | jq -c`.
 */

/**
 * Emit a single JSON document to stdout, terminated by a newline.
 *
 * @param {object} envelope
 */
export function emitJSON(envelope) {
  const pretty = process.stdout.isTTY ? 2 : 0;
  process.stdout.write(JSON.stringify(envelope, null, pretty) + '\n');
}

/**
 * Emit one NDJSON line to stdout. Always compact, always newline-terminated.
 *
 * @param {object} envelope
 */
export function emitNDJSON(envelope) {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}
