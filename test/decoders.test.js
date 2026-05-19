/**
 * test/decoders.test.js
 *
 * Decoder registry, nested calldata, and MultiSend packed-byte walker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, toHex } from 'viem';
import { decodeNestedCalldata, summarizeCalldata } from '../src/decoders/index.js';
import { decodeMultiSend } from '../src/decoders/multisend.js';
import { lookupSelector } from '../src/decoders/registry.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const RECIPIENT = '0x0000000000000000000000000000000000000001';
const TARGET = '0x1234567890123456789012345678901234567890';

function packMultiSendRecord({ operation = 0, to, value = 0n, data = '0x' }) {
  const toHex = to.replace(/^0x/, '').toLowerCase().padStart(40, '0').slice(-40);
  const dataBody = data === '0x' ? '' : data.replace(/^0x/, '');
  const dataLen = dataBody.length / 2;

  let valueHex = value.toString(16);
  if (valueHex.length > 64) throw new Error('value too large');
  valueHex = valueHex.padStart(64, '0');

  const dataLenHex = dataLen.toString(16).padStart(64, '0');
  return `0x${operation.toString(16).padStart(2, '0')}${toHex}${valueHex}${dataLenHex}${dataBody}`;
}

function encodeTransfer(recipient = RECIPIENT, amount = 1_000_000n) {
  return encodeFunctionData({
    abi: [{
      name: 'transfer',
      type: 'function',
      inputs: [
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      outputs: [{ type: 'bool' }],
    }],
    functionName: 'transfer',
    args: [recipient, amount],
  });
}

function encodeSafeExec({ to, data, value = 0n }) {
  return encodeFunctionData({
    abi: [{
      name: 'execTransaction',
      type: 'function',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'signatures', type: 'bytes' },
      ],
      outputs: [{ type: 'bool' }],
    }],
    functionName: 'execTransaction',
    args: [
      to,
      value,
      data,
      0,
      0n,
      0n,
      0n,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x',
    ],
  });
}

function encodeGovernorPropose(calldatas) {
  return encodeFunctionData({
    abi: [{
      name: 'propose',
      type: 'function',
      inputs: [
        { name: 'targets', type: 'address[]' },
        { name: 'values', type: 'uint256[]' },
        { name: 'signatures', type: 'string[]' },
        { name: 'calldatas', type: 'bytes[]' },
        { name: 'description', type: 'string' },
      ],
      outputs: [{ type: 'uint256' }],
    }],
    functionName: 'propose',
    args: [[TARGET], [0n], [''], calldatas, 'fixture'],
  });
}

function encodeMultiSend(transactionsPacked) {
  return encodeFunctionData({
    abi: [{
      name: 'multiSend',
      type: 'function',
      inputs: [{ name: 'transactions', type: 'bytes' }],
      outputs: [],
    }],
    functionName: 'multiSend',
    args: [transactionsPacked],
  });
}

describe('decodeMultiSend', () => {
  it('parses a single packed record with inner calldata', () => {
    const transfer = encodeTransfer();
    const packed = packMultiSendRecord({ to: USDC, value: 0n, data: transfer });
    const ops = decodeMultiSend(packed);

    assert.equal(ops.length, 1);
    assert.equal(ops[0].operation, 0);
    assert.equal(ops[0].to.toLowerCase(), USDC.toLowerCase());
    assert.equal(ops[0].value, 0n);
    assert.equal(ops[0].data.toLowerCase(), transfer.toLowerCase());
  });

  it('returns [] on truncated packed bytes', () => {
    const packed = packMultiSendRecord({ to: USDC, data: encodeTransfer() });
    const truncated = packed.slice(0, -4);
    assert.deepEqual(decodeMultiSend(truncated), []);
  });
});

describe('registry governance selectors', () => {
  const cases = [
    ['0xda95691a', 'GovernorBravo', 'propose'],
    ['0xddf0b009', 'GovernorBravo', 'queue'],
    ['0xfe0d94c1', 'GovernorBravo', 'execute'],
    ['0x7d5e81e2', 'OZ Governor', 'propose'],
    ['0x2656227d', 'OZ Governor', 'execute'],
    ['0x01d5062a', 'OZ Timelock', 'schedule'],
    ['0x8f2a0bb0', 'OZ Timelock', 'scheduleBatch'],
    ['0x134008d3', 'OZ Timelock', 'execute'],
    ['0xe38335e5', 'OZ Timelock', 'executeBatch'],
    ['0x6a761202', 'Safe', 'execTransaction'],
    ['0x8d80ff0a', 'Gnosis MultiSend', 'multiSend'],
  ];

  for (const [selector, protocol, name] of cases) {
    it(`registers ${protocol}.${name} (${selector})`, () => {
      const entry = lookupSelector(`${selector}00000000`);
      assert.ok(entry);
      assert.equal(entry.protocol, protocol);
      assert.equal(entry.name, name);
    });
  }
});

describe('summarizeCalldata', () => {
  it('summarizes GovernorBravo.propose with protocol tag', async () => {
    const transfer = encodeTransfer();
    const safeExec = encodeSafeExec({ to: USDC, data: transfer });
    const propose = encodeGovernorPropose([safeExec]);
    const summary = await summarizeCalldata('ethereum', propose);
    assert.match(summary, /GovernorBravo|Proposed governance action/i);
    assert.match(summary, /Safe exec/i);
  });

  it('summarizes Safe.execTransaction with protocol tag', async () => {
    const calldata = encodeSafeExec({ to: USDC, data: encodeTransfer() });
    const summary = await summarizeCalldata('ethereum', calldata);
    assert.match(summary, /Safe exec/i);
    assert.ok(summary.toLowerCase().includes(USDC.slice(0, 10).toLowerCase()));
  });

  it('summarizes Gnosis MultiSend with inner call count', async () => {
    const transfer = encodeTransfer();
    const packed = packMultiSendRecord({ to: USDC, data: transfer });
    const calldata = encodeMultiSend(packed);
    const nested = decodeNestedCalldata(calldata, 0, 0);

    assert.equal(nested.registryEntry.protocol, 'Gnosis MultiSend');
    assert.equal(nested.params.children.length, 1);
    assert.equal(nested.params.children[0].registryEntry.protocol, 'ERC20');

    const summary = await summarizeCalldata('ethereum', calldata);
    assert.match(summary, /MultiSend 1 inner calls/i);
  });

  it('stacks Governor → Safe → ERC20 across three levels', async () => {
    const transfer = encodeTransfer();
    const safeExec = encodeSafeExec({ to: USDC, data: transfer });
    const propose = encodeGovernorPropose([safeExec]);
    const nested = decodeNestedCalldata(propose, 0, 0);

    assert.equal(nested.registryEntry.protocol, 'GovernorBravo');
    assert.equal(nested.params.children[0].registryEntry.protocol, 'Safe');
    assert.equal(
      nested.params.children[0].params.children[0].registryEntry.protocol,
      'ERC20',
    );

    const summary = await summarizeCalldata('ethereum', propose);
    assert.match(summary, /Proposed governance action/i);
    assert.match(summary, /Safe exec/i);
    assert.match(summary, /Transferred/i);
  });

  it('decodes Governor → Safe → MultiSend → ERC20 leaf at depth 3', async () => {
    const transfer = encodeTransfer();
    const packed = packMultiSendRecord({ to: USDC, data: transfer });
    const multiSend = encodeMultiSend(packed);
    const safeExec = encodeSafeExec({ to: USDC, data: multiSend });
    const propose = encodeGovernorPropose([safeExec]);

    const nested = decodeNestedCalldata(propose, 0, 0);
    const safeChild = nested.params.children[0];
    const msChild = safeChild.params.children[0];
    assert.equal(msChild.registryEntry.protocol, 'Gnosis MultiSend');

    const leaf = msChild.params.children[0];
    assert.equal(leaf.registryEntry.protocol, 'ERC20');
    assert.equal(leaf.registryEntry.name, 'transfer');

    const summary = await summarizeCalldata('ethereum', propose);
    assert.match(summary, /Proposed governance action/i);
    assert.match(summary, /Safe exec/i);
    assert.match(summary, /MultiSend/i);
    assert.match(summary, /Transferred|transfer/i);
    assert.doesNotMatch(summary, /deeper call not expanded/i);
  });

  it('drops depth-4 leaf with explicit not-expanded note', async () => {
    const transfer = encodeTransfer();
    const innerSafe = encodeSafeExec({ to: USDC, data: transfer });
    const packed = packMultiSendRecord({ to: TARGET, data: innerSafe });
    const multiSend = encodeMultiSend(packed);
    const outerSafe = encodeSafeExec({ to: TARGET, data: multiSend });
    const propose = encodeGovernorPropose([outerSafe]);

    const nested = decodeNestedCalldata(propose, 0, 0);
    const msChild = nested.params.children[0].params.children[0];
    assert.equal(msChild.registryEntry.protocol, 'Gnosis MultiSend');
    const innerSafeNode = msChild.params.children[0];
    assert.equal(innerSafeNode.registryEntry.protocol, 'Safe');
    assert.ok(innerSafeNode.params.children.some(c => c.dropped === true));

    const summary = await summarizeCalldata('ethereum', propose);
    assert.match(summary, /deeper call not expanded/i);
  });

  it('renders parent summary when MultiSend payload is malformed', async () => {
    const packed = packMultiSendRecord({ to: USDC, data: encodeTransfer() }).slice(0, -6);
    const calldata = encodeMultiSend(packed);
    const nested = decodeNestedCalldata(calldata, 0, 0);

    assert.deepEqual(decodeMultiSend(packed), []);
    assert.equal(nested.params.children.length, 0);

    const summary = await summarizeCalldata('ethereum', calldata);
    assert.match(summary, /MultiSend 0 inner calls/i);
  });

  it('does not recurse Safe signatures bytes field', async () => {
    const calldata = encodeSafeExec({ to: USDC, data: '0x' });
    const nested = decodeNestedCalldata(calldata, 0, 0);
    assert.equal(nested.params.children.length, 0);
  });
});
