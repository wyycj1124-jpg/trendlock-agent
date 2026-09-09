# Execution contract

The executor fails closed. Account reads may prepare a confirmation card, but no entry is allowed unless server-side protection can be created and verified in the same supervised workflow.

## Required input

- `schema`: `trendlock.approval/v1`
- immutable `id`, `symbol`, `signal`, `orderMode`, and `score`
- source timestamp no older than two minutes
- score at least 90
- per-slot risk no greater than 5% while two slots are enabled
- status `AWAITING_USER_CONFIRMATION`

## Read-only preflight

Read all of the following from Binance MCP in the same run:

1. Agentic USDⓈ-M USDT balance and available balance.
2. Every nonzero USDⓈ-M position.
3. Every open USDⓈ-M order, not only the proposed symbol.
4. One-way or hedge position mode.
5. Symbol trading status, price tick, quantity step, minimum quantity, and minimum notional.
6. Current mark price and any available trading restriction status.

Treat both a position and a pending entry as occupying a slot. Protective reduce-only or close-position orders do not consume an additional symbol slot.

## Confirmation card

Show the exact normalized values that would be submitted. Include a two-minute expiry and require the user to name or clearly approve that specific proposal. If price changes enough to alter quantity, stop price, margin, or risk, expire the card and build a new one.

The confirmation must not be broadened to a different symbol, direction, order type, quantity, grid, or later scan. Never batch two proposals under an ambiguous single confirmation.

## Protected execution gate

Before an entry, the tool schema must expose enough fields to create and verify a server-side protective order, including its explicit trigger price and full-position/reduce-only semantics. A generic `STOP_MARKET` enum without an exposed trigger-price field is insufficient.

For a grid, the toolset must support either a native protected grid or a sequence with deterministic fill handling, inventory-aware sells, a full-strategy hard stop, idempotency, and account reconciliation. Otherwise return:

```text
EXECUTION_BLOCKED: required server-side protection is not available in the current Binance MCP tool schema; no entry was submitted.
```

## Post-write reconciliation

- Read back the actual fill before calculating any price-relative stop.
- Verify the protective order is active, on the correct `positionSide`, and covers the full actual quantity.
- For a stop upgrade, create and verify the tighter protection before removing the older protection.
- Keep exactly one intentional full-position stop after reconciliation.
- On ambiguity, read state and return `NEEDS_RECONCILIATION`; do not infer success from prose or retry the write.

Do not include secrets, private MCP URLs, account identifiers, or complete order IDs in public output.
