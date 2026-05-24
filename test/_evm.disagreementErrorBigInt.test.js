/**
 * test/_evm.disagreementErrorBigInt.test.js
 *
 * Regression test for RpcDisagreementError.toJSON() when `values` contain
 * a BigInt nested inside an object. Prior to using jsonSafeQuorumValue from
 * src/output/serialize.js, the local previewValue used `JSON.stringify(v)`
 * without a replacer, which throws `TypeError: Do not know how to serialize
 * a BigInt` mid-error-serialization.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RpcDisagreementError } from '../src/chains/_evm.js';

describe('RpcDisagreementError — BigInt inside object value', () => {
  const URLS = ['https://r1.example.com', 'https://r2.example.com'];
  const VALUES = [
    { url: 'https://r1.example.com', normalizedKey: 'k1', value: { blockNumber: 12345n } },
    { url: 'https://r2.example.com', normalizedKey: 'k2', value: { blockNumber: 67890n } },
  ];

  it('constructor does not throw on BigInt-in-object values', () => {
    assert.doesNotThrow(() => new RpcDisagreementError({ chain: 'ethereum', urls: URLS, values: VALUES }));
  });

  it('err.toJSON() does not throw and serializes BigInt as decimal string', () => {
    const err = new RpcDisagreementError({ chain: 'ethereum', urls: URLS, values: VALUES });
    let json;
    assert.doesNotThrow(() => { json = err.toJSON(); });
    // valuePreview is itself a JSON-stringified preview; inspect it directly.
    assert.equal(json.valuePreviews[0].valuePreview, '{"blockNumber":"12345"}');
    assert.equal(json.valuePreviews[1].valuePreview, '{"blockNumber":"67890"}');
  });

  it('JSON.stringify(err) does not throw and contains the decimal string', () => {
    const err = new RpcDisagreementError({ chain: 'ethereum', urls: URLS, values: VALUES });
    let out;
    assert.doesNotThrow(() => { out = JSON.stringify(err); });
    // After outer JSON.stringify, inner quotes are escaped; match the escaped form.
    assert.match(out, /\\"12345\\"/);
    assert.match(out, /\\"67890\\"/);
  });
});
