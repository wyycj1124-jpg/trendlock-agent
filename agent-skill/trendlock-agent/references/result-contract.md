# Read-only evidence contract

Create this raw document for import. Do not add account, balance, position, order, credential, authorization, or user identity fields.

```json
{
  "schema": "trendlock.market/v1",
  "transport": "MCP",
  "collectedAt": 1788858000000,
  "tools": [
    {
      "name": "exact_successful_tool_name",
      "status": "SUCCESS",
      "symbols": ["SOLUSDT"]
    }
  ],
  "markets": [
    {
      "symbol": "SOLUSDT",
      "price": 0,
      "change24h": 0,
      "turnover24h": 0,
      "spreadBps": 0,
      "fundingRate": 0,
      "candles": [
        {
          "openTime": 0,
          "closeTime": 0,
          "open": 0,
          "high": 0,
          "low": 0,
          "close": 0,
          "volume": 0
        }
      ]
    }
  ]
}
```

Requirements:

- `transport` is `MCP`, `BINANCE_SKILL`, or `SYNTHETIC`.
- Non-synthetic input has at least one real successful trace item. `name` is the exact client-visible tool/command; `symbols` lists the markets covered by that call.
- `collectedAt` is Binance server time in Unix milliseconds.
- Use at least 55 and at most 500 consecutive candles per market; 72 is recommended. Keep exchange-provided open and close times unchanged.
- All numeric fields are finite JSON numbers. Price and OHLC values are positive; volume is non-negative; best ask must not be below best bid when computing `spreadBps`.
- Symbols are uppercase alphanumeric USDT pairs and unique.

The importer whitelists these fields, recomputes the signal, and always labels imported Agent provenance as unverified. Its analyzed export uses `trendlock.analysis/v1` and may contain rules, candidates, the current paper state, a `DRAFT_ONLY` plan, and the sanitized trace.
