/**
 * src/output/serialize.js
 *
 * Shared output-boundary helpers used by both the balance and tx flows to
 * produce JSON-safe envelopes:
 *
 *   - jsonSafeQuorumValue: coerce BigInt / object adapter values into
 *     primitives or bounded JSON previews so `JSON.stringify` never throws.
 *   - jsonSafeQuorum:      apply jsonSafeQuorumValue across an adapter
 *     `quorum` block (sources[].value, disagreements[].value).
 *   - redactUrl:           strip credentials + query string from a URL before
 *     it lands in any output the user (or pipeline) might read.
 *   - buildDisagreementEntry: convert an adapter `quorum` block into the
 *     envelope `meta.sources.rpc.disagreements[]` entry shape.
 *
 * Lives at the OUTPUT boundary on purpose — adapter-internal data (the
 * adapter's own `quorum.sources[].url`) is not redacted here; redaction
 * happens at the point those URLs are about to be exposed in user output.
 */

/**
 * Strip credentials, query string, and URL fragment from a URL for safe
 * inclusion in any user-visible output. The fragment is stripped because
 * some providers smuggle tokens there (e.g. `…/#token=secret`).
 * Returns '[invalid-url]' for unparseable input.
 *
 * @param {string} u
 * @returns {string}
 */
export function redactUrl(u) {
  try {
    const url = new URL(u);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Make a value JSON-safe for the envelope: BigInts become decimal strings,
 * objects are stringified and bounded to 256 chars (matching the
 * `previewValue` style used in `src/chains/_evm.js`).
 *
 * @param {*} v
 * @returns {string|number|boolean|null}
 */
export function jsonSafeQuorumValue(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'bigint') return v.toString();
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  try {
    const s = JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? val.toString() : val);
    if (s === undefined) return String(v).slice(0, 256);
    return s.length > 256 ? s.slice(0, 256) + '…' : s;
  } catch {
    return String(v).slice(0, 256);
  }
}

/**
 * Make an adapter `quorum` block JSON-safe (recursively converts BigInts
 * inside `sources[].value` and `disagreements[].value`). The adapter shape
 * itself is preserved.
 *
 * @param {{ agreement: string, disagreements: any[], sources: any[] }} quorum
 * @returns {object}
 */
export function jsonSafeQuorum(quorum) {
  return {
    agreement: quorum.agreement,
    disagreements: (quorum.disagreements ?? []).map(d => ({
      url: d.url,
      value: jsonSafeQuorumValue(d.value),
      normalizedKey: d.normalizedKey,
    })),
    sources: (quorum.sources ?? []).map(s => {
      const out = { url: s.url, status: s.status };
      if (s.status === 'fulfilled') {
        out.value = jsonSafeQuorumValue(s.value);
        if (s.normalizedKey !== undefined) out.normalizedKey = s.normalizedKey;
      } else if (s.error !== undefined) {
        out.error = s.error;
      }
      return out;
    }),
  };
}

/**
 * Convert an adapter's `quorum` block into the envelope `disagreements[]`
 * entry shape. Returns null if the picked source cannot be located.
 *
 * URLs in the returned `providers[].url` and `picked.url` are redacted so the
 * envelope never leaks credentials.
 *
 * @param {string} chain
 * @param {{ quorum: { agreement: string, disagreements: any[], sources: any[] }, source?: string }} result
 * @returns {{
 *   chain: string,
 *   agreement: string,
 *   providers: Array<{ url: string, value: any, agreed: boolean }>,
 *   picked: { url: string, value: any },
 * } | null}
 */
export function buildDisagreementEntry(chain, result) {
  const { quorum, source: pickedUrl } = result;
  const sources = Array.isArray(quorum?.sources) ? quorum.sources : [];
  const disagreed = new Set(
    (quorum.disagreements ?? []).map(d => d.url).filter(Boolean),
  );
  let pickedValue;
  const providersOut = sources.map(s => {
    const agreed = s.status === 'fulfilled' && !disagreed.has(s.url);
    if (s.url === pickedUrl && s.status === 'fulfilled') {
      pickedValue = s.value;
    }
    return {
      url: redactUrl(s.url),
      value: s.status === 'fulfilled' ? jsonSafeQuorumValue(s.value) : null,
      agreed,
    };
  });
  if (pickedUrl === undefined || pickedValue === undefined) return null;
  return {
    chain,
    agreement: quorum.agreement,
    providers: providersOut,
    picked: { url: redactUrl(pickedUrl), value: jsonSafeQuorumValue(pickedValue) },
  };
}

/**
 * Return true if a per-chain quorum result represents an actual divergence
 * between RPC providers (not just first-success-wins or unanimous agreement).
 *
 * @param {{ agreement?: string, disagreements?: any[] }} quorum
 * @returns {boolean}
 */
export function isDisagreement(quorum) {
  if (!quorum) return false;
  if (Array.isArray(quorum.disagreements) && quorum.disagreements.length > 0) return true;
  if (quorum.agreement === 'plurality') return true;
  return false;
}
