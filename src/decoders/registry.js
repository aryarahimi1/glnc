/**
 * src/decoders/registry.js
 *
 * Maps 4-byte function selectors to human-readable names and ABI parameter
 * definitions for the most common DeFi contracts.
 *
 * Selectors are deterministic keccak256(signature) first 4 bytes.
 * We hard-code them here to avoid a runtime keccak dependency.
 *
 * Each entry:
 * {
 *   selector: '0xabcd1234',
 *   name:     'transfer',
 *   protocol: 'ERC20',
 *   inputs:   [{ name, type }],   // ABI parameter types for viem decodeAbiParameters
 * }
 */

// ─── Known contract addresses → display names ─────────────────────────────────
// addr→name, keyed by canonical chain name (matches adapter `name` exports).
// Addresses are lowercase. Used by the event decoder for counterparty name
// resolution; the renderer also imports this map for consistent labeling.

export const KNOWN_CONTRACTS = {
  ethereum: {
    // Uniswap routers
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 SwapRouter',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 SwapRouter02',
    '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap Universal Router (old)',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',

    // Wrapped native
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',

    // Major tokens
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',

    // Well-known Uniswap V2/V3 pools
    '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc': 'Uniswap V2: USDC/ETH',
    '0x0d4a11d5eeaac28ec3f61d100daf4d40471f1852': 'Uniswap V2: ETH/USDT',
    '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640': 'Uniswap V3: USDC/ETH 0.05%',
    '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8': 'Uniswap V3: USDC/ETH 0.3%',
    '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36': 'Uniswap V3: ETH/USDT 0.3%',
  },

  arbitrum: {
    // Uniswap routers (deterministic deployment shared with Ethereum)
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 SwapRouter',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 SwapRouter02',
    '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap Universal Router (old)',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',

    // Wrapped native
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  },

  polygon: {
    // Wrapped native
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'WMATIC',
  },

  base: {
    // Uniswap (separate deployment)
    '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap V3 SwapRouter02',
    '0x198ef1ec325a96cc354c7266a038be8b5c558f67': 'Uniswap Universal Router',

    // Wrapped native
    '0x4200000000000000000000000000000000000006': 'WETH',
  },
};

export const REGISTRY = [
  // ─── ERC-20 ─────────────────────────────────────────────────────────────────
  {
    selector: '0xa9059cbb',
    name:     'transfer',
    protocol: 'ERC20',
    signature: 'transfer(address,uint256)',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount',    type: 'uint256' },
    ],
  },
  {
    selector: '0x095ea7b3',
    name:     'approve',
    protocol: 'ERC20',
    signature: 'approve(address,uint256)',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
  },
  {
    selector: '0x23b872dd',
    name:     'transferFrom',
    protocol: 'ERC20',
    signature: 'transferFrom(address,address,uint256)',
    inputs: [
      { name: 'sender',    type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount',    type: 'uint256' },
    ],
  },

  // ─── WETH ────────────────────────────────────────────────────────────────────
  {
    selector: '0xd0e30db0',
    name:     'deposit',
    protocol: 'WETH',
    signature: 'deposit()',
    inputs: [],
  },
  {
    selector: '0x2e1a7d4d',
    name:     'withdraw',
    protocol: 'WETH',
    signature: 'withdraw(uint256)',
    inputs: [
      { name: 'wad', type: 'uint256' },
    ],
  },

  // ─── Uniswap V2 Router ───────────────────────────────────────────────────────
  {
    selector: '0x38ed1739',
    name:     'swapExactTokensForTokens',
    protocol: 'Uniswap V2',
    signature: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    inputs: [
      { name: 'amountIn',     type: 'uint256'   },
      { name: 'amountOutMin', type: 'uint256'   },
      { name: 'path',         type: 'address[]' },
      { name: 'to',           type: 'address'   },
      { name: 'deadline',     type: 'uint256'   },
    ],
  },
  {
    selector: '0x8803dbee',
    name:     'swapTokensForExactTokens',
    protocol: 'Uniswap V2',
    signature: 'swapTokensForExactTokens(uint256,uint256,address[],address,uint256)',
    inputs: [
      { name: 'amountOut',   type: 'uint256'   },
      { name: 'amountInMax', type: 'uint256'   },
      { name: 'path',        type: 'address[]' },
      { name: 'to',          type: 'address'   },
      { name: 'deadline',    type: 'uint256'   },
    ],
  },
  {
    selector: '0x7ff36ab5',
    name:     'swapExactETHForTokens',
    protocol: 'Uniswap V2',
    signature: 'swapExactETHForTokens(uint256,address[],address,uint256)',
    inputs: [
      { name: 'amountOutMin', type: 'uint256'   },
      { name: 'path',         type: 'address[]' },
      { name: 'to',           type: 'address'   },
      { name: 'deadline',     type: 'uint256'   },
    ],
  },
  {
    selector: '0x4a25d94a',
    name:     'swapTokensForExactETH',
    protocol: 'Uniswap V2',
    signature: 'swapTokensForExactETH(uint256,uint256,address[],address,uint256)',
    inputs: [
      { name: 'amountOut',   type: 'uint256'   },
      { name: 'amountInMax', type: 'uint256'   },
      { name: 'path',        type: 'address[]' },
      { name: 'to',          type: 'address'   },
      { name: 'deadline',    type: 'uint256'   },
    ],
  },
  {
    selector: '0x18cbafe5',
    name:     'swapExactTokensForETH',
    protocol: 'Uniswap V2',
    signature: 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
    inputs: [
      { name: 'amountIn',     type: 'uint256'   },
      { name: 'amountOutMin', type: 'uint256'   },
      { name: 'path',         type: 'address[]' },
      { name: 'to',           type: 'address'   },
      { name: 'deadline',     type: 'uint256'   },
    ],
  },
  {
    selector: '0xfb3bdb41',
    name:     'swapETHForExactTokens',
    protocol: 'Uniswap V2',
    signature: 'swapETHForExactTokens(uint256,address[],address,uint256)',
    inputs: [
      { name: 'amountOut', type: 'uint256'   },
      { name: 'path',      type: 'address[]' },
      { name: 'to',        type: 'address'   },
      { name: 'deadline',  type: 'uint256'   },
    ],
  },

  // ─── Uniswap V3 SwapRouter ───────────────────────────────────────────────────
  {
    selector: '0x414bf389',
    name:     'exactInputSingle',
    protocol: 'Uniswap V3',
    signature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'recipient',         type: 'address' },
          { name: 'deadline',          type: 'uint256' },
          { name: 'amountIn',          type: 'uint256' },
          { name: 'amountOutMinimum',  type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
  },
  {
    selector: '0xc04b8d59',
    name:     'exactInput',
    protocol: 'Uniswap V3',
    signature: 'exactInput((bytes,address,uint256,uint256,uint256))',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path',             type: 'bytes'   },
          { name: 'recipient',        type: 'address' },
          { name: 'deadline',         type: 'uint256' },
          { name: 'amountIn',         type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
  },
  {
    selector: '0xdb3e2198',
    name:     'exactOutputSingle',
    protocol: 'Uniswap V3',
    signature: 'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',          type: 'address' },
          { name: 'tokenOut',         type: 'address' },
          { name: 'fee',              type: 'uint24'  },
          { name: 'recipient',        type: 'address' },
          { name: 'deadline',         type: 'uint256' },
          { name: 'amountOut',        type: 'uint256' },
          { name: 'amountInMaximum',  type: 'uint256' },
          { name: 'sqrtPriceLimitX96',type: 'uint160' },
        ],
      },
    ],
  },
  {
    selector: '0x09b81346',
    name:     'exactOutput',
    protocol: 'Uniswap V3',
    signature: 'exactOutput((bytes,address,uint256,uint256,uint256))',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path',            type: 'bytes'   },
          { name: 'recipient',       type: 'address' },
          { name: 'deadline',        type: 'uint256' },
          { name: 'amountOut',       type: 'uint256' },
          { name: 'amountInMaximum', type: 'uint256' },
        ],
      },
    ],
  },

  // ─── Uniswap Universal Router (multicall wrapper) ────────────────────────────
  {
    selector: '0x3593564c',
    name:     'execute',
    protocol: 'Uniswap Universal Router',
    signature: 'execute(bytes,bytes[],uint256)',
    inputs: [
      { name: 'commands', type: 'bytes'    },
      { name: 'inputs',   type: 'bytes[]'  },
      { name: 'deadline', type: 'uint256'  },
    ],
  },

  // ─── Governance / Safe / MultiSend ───────────────────────────────────────────
  {
    selector: '0xda95691a',
    name:     'propose',
    protocol: 'GovernorBravo',
    signature: 'propose(address[],uint256[],string[],bytes[],string)',
    inputs: [
      { name: 'targets',     type: 'address[]' },
      { name: 'values',      type: 'uint256[]' },
      { name: 'signatures',  type: 'string[]'  },
      { name: 'calldatas',   type: 'bytes[]'   },
      { name: 'description', type: 'string'    },
    ],
  },
  {
    selector: '0xddf0b009',
    name:     'queue',
    protocol: 'GovernorBravo',
    signature: 'queue(uint256)',
    inputs: [
      { name: 'proposalId', type: 'uint256' },
    ],
  },
  {
    selector: '0xfe0d94c1',
    name:     'execute',
    protocol: 'GovernorBravo',
    signature: 'execute(uint256)',
    inputs: [
      { name: 'proposalId', type: 'uint256' },
    ],
  },
  {
    selector: '0x7d5e81e2',
    name:     'propose',
    protocol: 'OZ Governor',
    signature: 'propose(address[],uint256[],bytes[],string)',
    inputs: [
      { name: 'targets',     type: 'address[]' },
      { name: 'values',      type: 'uint256[]' },
      { name: 'calldatas',   type: 'bytes[]'   },
      { name: 'description', type: 'string'    },
    ],
  },
  {
    selector: '0x2656227d',
    name:     'execute',
    protocol: 'OZ Governor',
    signature: 'execute(address[],uint256[],bytes[],bytes32)',
    inputs: [
      { name: 'targets',         type: 'address[]' },
      { name: 'values',          type: 'uint256[]' },
      { name: 'calldatas',       type: 'bytes[]'   },
      { name: 'descriptionHash', type: 'bytes32'   },
    ],
  },
  {
    selector: '0x01d5062a',
    name:     'schedule',
    protocol: 'OZ Timelock',
    signature: 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
    inputs: [
      { name: 'target',      type: 'address' },
      { name: 'value',       type: 'uint256' },
      { name: 'data',        type: 'bytes'   },
      { name: 'predecessor', type: 'bytes32' },
      { name: 'salt',        type: 'bytes32' },
      { name: 'delay',       type: 'uint256' },
    ],
  },
  {
    selector: '0x8f2a0bb0',
    name:     'scheduleBatch',
    protocol: 'OZ Timelock',
    signature: 'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
    inputs: [
      { name: 'targets',     type: 'address[]' },
      { name: 'values',      type: 'uint256[]' },
      { name: 'payloads',    type: 'bytes[]'   },
      { name: 'predecessor', type: 'bytes32'   },
      { name: 'salt',        type: 'bytes32'   },
      { name: 'delay',       type: 'uint256'   },
    ],
  },
  {
    selector: '0x134008d3',
    name:     'execute',
    protocol: 'OZ Timelock',
    signature: 'execute(address,uint256,bytes,bytes32,bytes32)',
    inputs: [
      { name: 'target',      type: 'address' },
      { name: 'value',       type: 'uint256' },
      { name: 'payload',     type: 'bytes'   },
      { name: 'predecessor', type: 'bytes32' },
      { name: 'salt',        type: 'bytes32' },
    ],
  },
  {
    selector: '0xe38335e5',
    name:     'executeBatch',
    protocol: 'OZ Timelock',
    signature: 'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)',
    inputs: [
      { name: 'targets',     type: 'address[]' },
      { name: 'values',      type: 'uint256[]' },
      { name: 'payloads',    type: 'bytes[]'   },
      { name: 'predecessor', type: 'bytes32'   },
      { name: 'salt',        type: 'bytes32'   },
    ],
  },
  {
    selector: '0x6a761202',
    name:     'execTransaction',
    protocol: 'Safe',
    signature: 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
    inputs: [
      { name: 'to',             type: 'address' },
      { name: 'value',          type: 'uint256' },
      { name: 'data',           type: 'bytes'   },
      { name: 'operation',      type: 'uint8'   },
      { name: 'safeTxGas',      type: 'uint256' },
      { name: 'baseGas',        type: 'uint256' },
      { name: 'gasPrice',       type: 'uint256' },
      { name: 'gasToken',       type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures',     type: 'bytes'   },
    ],
  },
  {
    selector: '0x8d80ff0a',
    name:     'multiSend',
    protocol: 'Gnosis MultiSend',
    signature: 'multiSend(bytes)',
    inputs: [
      { name: 'transactions', type: 'bytes' },
    ],
  },
];

// Build a quick lookup map: selector (lowercase) → entry
export const SELECTOR_MAP = new Map(
  REGISTRY.map(entry => [entry.selector.toLowerCase(), entry])
);

/**
 * Look up a registry entry by the first 4 bytes of calldata.
 *
 * @param {string} calldata  - hex string (with or without 0x prefix)
 * @returns {object | null}
 */
export function lookupSelector(calldata) {
  if (!calldata || calldata.length < 10) return null;
  const raw = calldata.startsWith('0x') ? calldata : `0x${calldata}`;
  const selector = raw.slice(0, 10).toLowerCase();
  return SELECTOR_MAP.get(selector) ?? null;
}
