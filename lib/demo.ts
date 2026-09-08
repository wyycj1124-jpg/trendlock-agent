import { defaults, evaluateMarket, type Candle, type Candidate, type Market, type Rules } from './engine.ts';

export const demoTime = Date.UTC(2026, 8, 8, 9);

function candlesFor(base: number, direction: 'up' | 'down' | 'range', index: number, intervalMs: number): Candle[] {
  return Array.from({ length: 72 }, (_, i) => {
    const trend = direction === 'up' ? i * 0.004 : direction === 'down' ? -i * 0.0034 : 0;
    const wave = direction === 'range' ? Math.sin(i * Math.PI / 2) * 0.032 : Math.sin(i * 0.78 + index) * 0.009;
    const center = base * (1 + trend + wave);
    const open = center * (1 + Math.sin(i * 1.31) * 0.0025);
    const close = center * (1 + Math.cos(i * 1.11) * 0.0028);
    const boost = i === 71 ? 1.7 + index * 0.07 : 1;
    return {
      openTime: demoTime - (72 - i) * intervalMs,
      closeTime: demoTime - (71 - i) * intervalMs - 1,
      open,
      high: Math.max(open, close) * 1.006,
      low: Math.min(open, close) * 0.994,
      close,
      volume: (1000 + (i % 8) * 55) * boost,
    };
  });
}

export function demoMarkets(rules: Rules = defaults): Candidate[] {
  const specs: Array<[string, number, 'up' | 'down' | 'range', number, number, number]> = [
    ['AVAXUSDT', 27.2, 'up', 6.08, 284_600_000, 1.7],
    ['LINKUSDT', 15.1, 'up', 3.42, 418_200_000, 1.2],
    ['DOGEUSDT', 0.142, 'range', -0.61, 732_000_000, 1.9],
    ['APTUSDT', 7.25, 'down', -4.16, 126_400_000, 2.6],
    ['SUIUSDT', 1.41, 'up', 4.21, 396_700_000, 1.5],
    ['ARBUSDT', 0.39, 'range', 0.38, 91_300_000, 3.2],
    ['NEARUSDT', 3.56, 'down', -2.81, 83_900_000, 3.8],
    ['WIFUSDT', 0.78, 'range', 1.18, 76_200_000, 5.1],
  ];
  const markets: Market[] = specs.map(([symbol, base, direction, change24h, turnover24h, spreadBps], index) => {
    const candles = candlesFor(base, direction, index, { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 }[rules.interval]);
    return {
      symbol,
      price: candles.at(-1)!.close,
      change24h,
      turnover24h,
      spreadBps,
      fundingRate: (index % 3 - 1) * 0.00007,
      candles,
    };
  });
  // One deliberate rejection makes the veto path visible in the demo.
  markets[7].spreadBps = 25;
  return markets.map((market) => evaluateMarket(market, rules, demoTime)).sort((a, b) => b.score - a.score);
}
