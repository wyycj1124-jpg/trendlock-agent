import assert from 'node:assert/strict';
import test from 'node:test';
import { BinanceFuturesGateway } from './binance.ts';
import { loadConfig } from './config.ts';

void test('Binance protective order uses the migrated algo endpoint without quantity or reduceOnly', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : '';
      requests.push({ url, method, body });
      if (url.endsWith('/fapi/v1/time')) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), {
          status: 200,
        });
      }
      if (url.includes('/fapi/v1/exchangeInfo')) {
        return new Response(
          JSON.stringify({
            symbols: [
              {
                symbol: 'LINKUSDT',
                status: 'TRADING',
                filters: [
                  { filterType: 'PRICE_FILTER', tickSize: '0.01' },
                  {
                    filterType: 'MARKET_LOT_SIZE',
                    minQty: '0.001',
                    maxQty: '10000',
                    stepSize: '0.001',
                  },
                  { filterType: 'MIN_NOTIONAL', notional: '5' },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      const params = new URLSearchParams(body || url.split('?')[1]);
      const order = {
        algoId: 42,
        clientAlgoId: params.get('clientAlgoId') ?? 'TL-test',
        algoType: 'CONDITIONAL',
        orderType: 'STOP_MARKET',
        symbol: 'LINKUSDT',
        side: 'SELL',
        positionSide: 'BOTH',
        algoStatus: 'NEW',
        triggerPrice: '2299.34',
        workingType: 'MARK_PRICE',
        closePosition: true,
      };
      if (url.includes('/fapi/v1/algoOrder') && method === 'POST') {
        return new Response(JSON.stringify(order), { status: 200 });
      }
      if (url.includes('/fapi/v1/openAlgoOrders')) {
        return new Response(JSON.stringify([order]), { status: 200 });
      }
      return new Response(
        JSON.stringify({ code: -1, msg: 'unexpected test request' }),
        { status: 400 },
      );
    };
    const config = loadConfig({
      TRENDLOCK_MODE: 'TESTNET',
      BINANCE_API_KEY: 'test-key',
      BINANCE_SECRET_KEY: 'test-secret',
    });
    const gateway = new BinanceFuturesGateway(config);
    const result = await gateway.placeProtectiveStop({
      symbol: 'LINKUSDT',
      side: 'LONG',
      positionSide: 'BOTH',
      triggerPrice: 2299.34,
      clientAlgoId: 'TL-test',
    });
    assert.equal(result.triggerPrice, 2299.34);
    const request = requests.find(
      (item) =>
        item.url.includes('/fapi/v1/algoOrder') && item.method === 'POST',
    )!;
    const body = new URLSearchParams(request.body);
    assert.equal(body.get('algoType'), 'CONDITIONAL');
    assert.equal(body.get('type'), 'STOP_MARKET');
    assert.equal(body.get('workingType'), 'MARK_PRICE');
    assert.equal(body.get('triggerPrice'), '2299.34');
    assert.equal(body.get('closePosition'), 'true');
    assert.equal(body.has('quantity'), false);
    assert.equal(body.has('reduceOnly'), false);
    assert.ok(body.get('signature'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('Binance V3 positions obtain leverage and margin type from symbolConfig', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('/fapi/v1/time')) {
        return new Response(JSON.stringify({ serverTime: Date.now() }), {
          status: 200,
        });
      }
      if (url.includes('/fapi/v3/balance')) {
        return new Response(
          JSON.stringify([
            { asset: 'USDT', balance: '50', availableBalance: '40' },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/fapi/v3/positionRisk')) {
        return new Response(
          JSON.stringify([
            {
              symbol: 'LINKUSDT',
              positionSide: 'LONG',
              positionAmt: '1',
              entryPrice: '18',
              markPrice: '19',
              unRealizedProfit: '1',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/fapi/v1/symbolConfig')) {
        return new Response(
          JSON.stringify([
            {
              symbol: 'LINKUSDT',
              marginType: 'ISOLATED',
              leverage: 3,
            },
          ]),
          { status: 200 },
        );
      }
      if (
        url.includes('/fapi/v1/openOrders') ||
        url.includes('/fapi/v1/openAlgoOrders')
      ) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/fapi/v1/accountConfig')) {
        return new Response(
          JSON.stringify({ canTrade: true, dualSidePosition: true }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ code: -1, msg: 'unexpected test request' }),
        { status: 400 },
      );
    };
    const gateway = new BinanceFuturesGateway(
      loadConfig({
        TRENDLOCK_MODE: 'TESTNET',
        BINANCE_API_KEY: 'test-key',
        BINANCE_SECRET_KEY: 'test-secret',
      }),
    );
    const snapshot = await gateway.getAccountSnapshot();
    assert.equal(snapshot.positions[0]?.leverage, 3);
    assert.equal(snapshot.positions[0]?.marginType, 'ISOLATED');
    assert.equal(snapshot.equity, 51);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
