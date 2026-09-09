---
name: trendlock-executor
description: Coordinate user-confirmed Binance Agentic USDⓈ-M futures preflight and protected execution from a fresh TrendLock approval queue. Use only after TrendLock has produced a score-90-or-higher proposal; do not use for general market scans or unconfirmed autonomous trading.
metadata:
  version: 0.1.0
  author: TrendLock contributors
license: MIT
---

# TrendLock Executor

Turn a fresh `trendlock.approval-queue/v1` proposal into a proposal-specific Binance MCP confirmation card. The user approves the exact order package; a general request to keep trading is never standing authorization.

Read [references/execution-contract.md](references/execution-contract.md) before accessing an authenticated account or preparing an order.

## Workflow

1. Accept only a proposal with score at least 90, status `AWAITING_USER_CONFIRMATION`, and market evidence no older than two minutes. Reject edited scores or a missing proposal ID.
2. Use Binance MCP read calls to retrieve the Agentic sub-account's USDⓈ-M available USDT balance, every nonzero USDⓈ-M position, every open USDⓈ-M order, position mode, symbol filters, mark price, and current quantitative trading status when available.
3. Count distinct symbols that already have a nonzero position or an entry order. The maximum is two. Exclude occupied symbols and duplicate exposure. A released slot requires a fresh scan; it does not reuse an old proposal.
4. Recalculate quantity from current equity and exchange rules. The portfolio risk budget is 10% across both slots, so each slot receives at most 5% while the two-slot policy is enabled. Use at most 3× leverage and isolated margin. Never average down, auto-add margin, or turn a losing trend position into a grid.
5. Present one confirmation card containing proposal ID and expiry, symbol, LONG/SHORT/RANGE, `positionSide`, margin mode, leverage, order type, quantized quantity and price, estimated margin, server-side initial stop, and worst-case risk budget. Do not issue a write call while creating this card.
6. Before any entry write, confirm that the currently exposed Binance MCP tools can create a full-position server-side protective stop with an explicit trigger price and read it back. For a grid, also require a supported protected grid or an atomic/reconcilable order sequence. If either capability is absent, return `EXECUTION_BLOCKED` and do not open a position.
7. After the user explicitly confirms this exact, unexpired card, request confirmation for each Binance MCP non-GET action as required by the platform. Configure isolated margin and leverage, submit the entry, read back the actual weighted fill and quantity, create the full-position server stop, then read back and verify coverage.
8. If any write is rejected, times out, or has an ambiguous result, stop. Read positions and open orders, return `NEEDS_RECONCILIATION`, and never retry blindly.

## Direction rules

- `LONG`: buy/open `LONG` or `BOTH`, then place the protective sell stop below the actual weighted fill.
- `SHORT`: sell/open `SHORT` or `BOTH`, then place the protective buy stop above the actual weighted fill.
- `RANGE`: only a new, separately risk-sized long grid. Never create naked shorts above inventory and never inherit a losing trend position.

This skill never withdraws, transfers, or funds the Agentic sub-account. It never treats a page button, prior approval, or recurring monitor as authorization for a later order.
