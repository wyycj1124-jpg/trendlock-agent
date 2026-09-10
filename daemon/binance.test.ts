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
        triggerPrice: '18.000',
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
      triggerPrice: 18,
      clientAlgoId: 'TL-test',
    });
    assert.equal(result.triggerPrice, 18);
    const request = requests.find(
      (item) =>
        item.url.includes('/fapi/v1/algoOrder') && item.method === 'POST',
    )!;
    const body = new URLSearchParams(request.body);
    assert.equal(body.get('algoType'), 'CONDITIONAL');
    assert.equal(body.get('type'), 'STOP_MARKET');
    assert.equal(body.get('workingType'), 'MARK_PRICE');
    assert.equal(body.get('closePosition'), 'true');
    assert.equal(body.has('quantity'), false);
    assert.equal(body.has('reduceOnly'), false);
    assert.ok(body.get('signature'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
