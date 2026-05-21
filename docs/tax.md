# glnc — Cost Basis & Tax Documentation

`glnc history --cost-basis fifo` walks your on-chain history in chronological
order, tracks per-asset lots using FIFO (first-in-first-out), and annotates
each disposal with five new CSV columns: `cost_basis_usd`, `proceeds_usd`,
`realized_gain_usd`, `holding_period` (short / long / mixed), and `income_usd`
(a candidate Schedule 1 ordinary-income value for inbound transfers from
non-own-wallets). v1.1.0 covers Ethereum, Polygon, Arbitrum, Base, and Optimism
via Etherscan V2.

## Disclaimer

**IMPORTANT** — glnc does NOT compute ordinary income from staking rewards,
airdrops, hard forks, mining, or lending interest. These are taxable as
ordinary income at FMV on receipt (Rev. Rul. 2019-24, 2023-14). glnc records
each potential inbound as a zero-cost-basis lot and surfaces the USD value in
the `income_usd` column for you/your CPA to classify and report on Schedule 1.

glnc is MIT-licensed AS-IS software. It does not constitute tax, legal, or
accounting advice. Verify all output with a qualified tax professional before
filing.

## Canonical examples

```sh
glnc history 0xd8dA... --chain ethereum --cost-basis fifo --out 2025.csv
glnc history 0xd8dA... --chain ethereum --cost-basis fifo --own-wallets 0xA,0xB --out 2025.csv
glnc history 0xd8dA... --chain arbitrum --cost-basis fifo --from 2025-01-01 --to 2025-12-31 --out arb-2025.csv
```

Full handling spec, known limitations, and worked examples:
**https://glnc.dev/docs/taxes/**

This is a stub; the canonical docs live on the website. Update the website
page, not this file, for substantive changes.
