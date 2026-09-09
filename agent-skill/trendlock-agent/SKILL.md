---
name: trendlock-agent
description: Collect read-only Binance USDⓈ-M perpetual market evidence and use the TrendLock repository's deterministic engine to classify trend or range setups and stage non-executing risk plans. Use for TrendLock scans and evidence exports; do not use it to place or manage orders.
metadata:
  version: 0.2.0
  author: TrendLock contributors
license: MIT
---

# TrendLock Agent

Collect same-run market evidence through the official Binance MCP Server or the official `binance` skill, then let the repository engine make every classification and calculation. The output is analysis, not investment advice.

Read [references/result-contract.md](references/result-contract.md) before collecting or exporting evidence. The web app and `scripts/evaluate-evidence.ts` consume that contract.

## Workflow

1. Parse only these supported choices: interval (`15m`, `1h`, `4h`), pool size, minimum 24h quote turnover, maximum spread, minimum last-closed-bar volume ratio, hypothetical account equity, risk percent, leverage up to 3×, initial stop distance, and grid spacing. Use repository defaults for omitted values.
2. Use read-only Binance market-data calls to obtain server time, USDⓈ-M exchange information, 24h tickers, book ticker, funding/mark data, and at least 72 klines per displayed symbol. Keep only `TRADING`, `PERPETUAL`, `USDT` contracts. Do not retrieve balances, positions, orders, account information, or identifiers.
3. Set `collectedAt` from Binance server time. Include the exact successful tool names in `tools`; never invent a call trace. Exclude the still-open candle by retaining its exchange timestamps and letting the engine filter it.
4. Emit `trendlock.market/v1`. Never mark it as verified or signed; transport is a provenance claim only.
5. From the repository root, run `node scripts/evaluate-evidence.ts evidence.json`. Do not reproduce EMA, ATR, classification, risk, stop, or grid calculations in prose—the deterministic engine is authoritative.
6. Report all four possible states, including `NO_TRADE`, with failed evidence. Zero approved candidates is valid.
7. If requested, import the raw evidence JSON into the web workbench and generate a `DRAFT_ONLY` plan. Never call an order, cancel, transfer, account, or position endpoint from this skill.

## Non-obvious invariants

- Signal percentages are based on underlying price versus weighted entry, never leveraged ROE.
- A trend stop only tightens. Initial −7%; at +5% lock +2%; at +8% lock +5%; then +11% locks +8%, +14% locks +11%, and so on. Mirror for shorts. The default per-trade account risk budget is 10%, an intentionally aggressive user-selected setting rather than a loss guarantee.
- Price crossing the old stop closes the simulated state before any new ladder advance; a closed state never reopens itself.
- A losing trend position never becomes a grid. A range plan is a fresh, separately risk-sized long-grid draft with a hard exit.
- Fresh non-synthetic evidence expires after two minutes. Missing, discontinuous, malformed, or open-candle-only evidence must be rejected.
- A risk budget is not a guaranteed loss ceiling; fees, funding, slippage, gaps, liquidation, and infrastructure failures remain possible.

The Binance MCP product may support authenticated actions, but those are intentionally outside this skill and this prototype.
