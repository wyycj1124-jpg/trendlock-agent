import { defaults, evaluateMarket, validateRules, type Market, type Rules } from './engine.ts';

export type AgentEvidence = {
  schema: 'trendlock.market/v1';
  transport: 'MCP' | 'BINANCE_SKILL' | 'SYNTHETIC';
  collectedAt: number;
  tools: Array<{ name: string; status: 'SUCCESS'; symbols: string[] }>;
  markets: Market[];
};

// Imported claims are not authentication. Recompute every decision from candles.
export function importEvidence(raw: unknown, rules: Rules = defaults) {
  validateRules(rules);
  if (!raw || typeof raw !== 'object') throw new Error('需要Agent原始行情JSON');
  const value = raw as Partial<AgentEvidence>;
  if (value.schema !== 'trendlock.market/v1' || !['MCP', 'BINANCE_SKILL', 'SYNTHETIC'].includes(value.transport ?? '') ||
    !Number.isFinite(value.collectedAt) || !Array.isArray(value.markets) || !value.markets.length || value.markets.length > 80 || !Array.isArray(value.tools)) throw new Error('Agent数据契约不完整');
  if ((value.transport !== 'SYNTHETIC' && !value.tools.length) || value.tools.some((tool) =>
    !tool || typeof tool.name !== 'string' || !tool.name.trim() || tool.status !== 'SUCCESS' || !Array.isArray(tool.symbols) || tool.symbols.some((s) => typeof s !== 'string'))) throw new Error('缺少成功的工具调用记录');
  const symbols = new Set<string>();
  const markets = value.markets.map((market) => {
    if (!market || typeof market.symbol !== 'string' || !/^[A-Z0-9]{2,30}USDT$/.test(market.symbol) || symbols.has(market.symbol) ||
      !Array.isArray(market.candles) || market.candles.length < 55 || market.candles.length > 500) throw new Error('币对重复、名称无效或K线数量异常');
    symbols.add(market.symbol);
    const numeric = [market.price, market.change24h, market.turnover24h, market.spreadBps, market.fundingRate];
    if (!numeric.every((number) => typeof number === 'number' && Number.isFinite(number))) throw new Error('行情字段必须为有限数值');
    // Whitelist fields so unrelated account data cannot be included in exports.
    return {
      symbol: market.symbol, price: market.price, change24h: market.change24h, turnover24h: market.turnover24h,
      spreadBps: market.spreadBps, fundingRate: market.fundingRate,
      candles: market.candles.map((bar) => {
        if (!bar || ![bar.openTime, bar.closeTime, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) throw new Error('无效K线字段');
        return { openTime: bar.openTime, closeTime: bar.closeTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
      }),
    };
  });
  return {
    source: value.transport === 'SYNTHETIC' ? 'SYNTHETIC' : `IMPORTED_${value.transport}`,
    asOf: value.collectedAt!,
    agentOs: { transport: value.transport, verified: false, note: '导入来源为提供方声明，本应用没有验证连接或签名' },
    tools: value.tools.map((tool) => ({ name: String(tool.name).slice(0, 160), status: tool.status, symbols: tool.symbols.filter((s) => symbols.has(s)) })),
    rows: markets.map((market) => evaluateMarket(market, rules, value.collectedAt!)).sort((a, b) => b.score - a.score),
  };
}
