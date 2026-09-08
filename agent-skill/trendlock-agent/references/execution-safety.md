# Execution safety

Future design notes only. The current skill and web prototype do not perform authenticated operations, monitor live positions, place protective orders, or execute any of the steps below. These notes do not authorize account access or trading.

Before any authenticated operation:

1. Confirm the connected environment (`testnet` or `prod`), account, position mode, margin mode, existing position, existing open orders, and quantitative trading status.
2. Default to testnet or dry-run. Production requires a dedicated sub-account, read and Futures trading permissions only, IP restriction, and no withdrawal permission.
3. Reject a plan if the requested leverage exceeds the configured cap, the calculated maximum loss exceeds the risk budget, the liquidation buffer is insufficient, or price/position data is stale.
4. Never automatically average down, auto-add margin, convert a losing trend into a grid, or increase size after a stop has tightened.
5. For a new trend position: configure isolated margin and leverage, place the entry, verify the actual weighted fill price and quantity, then place the initial server-side conditional stop from the actual position.
6. For every stop upgrade: create the new tighter stop first; verify its accepted state and coverage; cancel the previous stop second. Keep exactly one intentional full-position protective stop after reconciliation.
7. If any step is ambiguous or partially fails, do not retry a write blindly. Read back positions and open orders, report `NEEDS_RECONCILIATION`, and wait for the user.
8. Never expose API keys, secrets, complete order identifiers, account identifiers, or private MCP connection URLs in logs, screenshots, exports, or public repositories.
