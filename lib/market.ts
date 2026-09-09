import { evaluateMarket, validateRules, type Candle, type Candidate, type Market, type Rules } from './engine.ts';

export const FUTURES_SOURCE = 'https://fapi.binance.com';

type ExchangeInfo = {
  symbols: Array<{
    symbol: string;
    contractType: string;
    status: string;
    quoteAsset: string;
    baseAsset: string;
  }>;
};
type Ticker = { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string };
type Book = { symbol: string; bidPrice: string; askPrice: string };
type Premium = { symbol: string; lastFundingRate: string };
type MarkPrice = { symbol: string; markPrice: string; time: number };

async function read<T>(path: string): Promise<T> {
  const response = await fetch(FUTURES_SOURCE + path, {
    signal: AbortSignal.timeout(12_000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(response.status === 451 ? '币安限制此网络地区访问（HTTP 451）；请使用符合平台地区要求的官方连接' : response.status === 429 ? '币安行情限流，请稍后重试' : `Binance Futures HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function fetchMarkPrice(symbol: string) {
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) throw new Error('交易对格式无效');
  const result = await read<MarkPrice>(`/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`);
  const markPrice = Number(result.markPrice);
  if (result.symbol !== symbol || !Number.isFinite(markPrice) || markPrice <= 0 || !Number.isFinite(result.time)) {
    throw new Error('币安标记价格数据异常');
  }
  return { symbol, markPrice, time: result.time };
}

export async function scanFutures(rules: Rules, onProgress?: (done: number, total: number) => void) {
  validateRules(rules);
  const startedAt = Date.now();
  const [exchange, tickers, books, premiums, clock] = await Promise.all([
    read<ExchangeInfo>('/fapi/v1/exchangeInfo'),
    read<Ticker[]>('/fapi/v1/ticker/24hr'),
    read<Book[]>('/fapi/v1/ticker/bookTicker'),
    read<Premium[]>('/fapi/v1/premiumIndex'),
    read<{serverTime: number}>('/fapi/v1/time'),
  ]);
  if (!Array.isArray(exchange.symbols) || !Array.isArray(tickers) || !Array.isArray(books) || !Array.isArray(premiums) || !Number.isFinite(clock.serverTime)) throw new Error('币安返回的数据结构不完整');
  const excluded = new Set(['BTC', 'ETH', 'BNB', 'USDC', 'FDUSD', 'USDP', 'TUSD', 'DAI', 'USDE']);
  const eligible = new Set(exchange.symbols.filter((symbol) =>
    symbol.contractType === 'PERPETUAL' &&
    symbol.status === 'TRADING' &&
    symbol.quoteAsset === 'USDT' &&
    !excluded.has(symbol.baseAsset) &&
    !/(UP|DOWN|BULL|BEAR)$/.test(symbol.baseAsset),
  ).map((symbol) => symbol.symbol));
  const pool = tickers.filter((ticker) => eligible.has(ticker.symbol) && Number(ticker.quoteVolume) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, rules.poolSize);
  if (!pool.length) throw new Error('未取得可扫描的U本位永续合约');
  const bookMap = new Map(books.map((book) => [book.symbol, book]));
  const fundingMap = new Map(premiums.map((premium) => [premium.symbol, Number(premium.lastFundingRate)]));
  const asOf = clock.serverTime;
  const rows: Candidate[] = [];
  let cursor = 0;
  let failed = 0;
  let done = 0;
  onProgress?.(0, pool.length);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < pool.length) {
      const ticker = pool[cursor++];
      try {
        const raw = await read<Array<Array<number | string>>>(`/fapi/v1/klines?symbol=${encodeURIComponent(ticker.symbol)}&interval=${rules.interval}&limit=72`);
        const candles: Candle[] = raw.map((bar) => ({
          openTime: Number(bar[0]), open: Number(bar[1]), high: Number(bar[2]), low: Number(bar[3]), close: Number(bar[4]), volume: Number(bar[5]), closeTime: Number(bar[6]),
        }));
        const book = bookMap.get(ticker.symbol);
        const bid = Number(book?.bidPrice);
        const ask = Number(book?.askPrice);
        const spreadBps = bid > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : Number.POSITIVE_INFINITY;
        const market: Market = {
          symbol: ticker.symbol,
          price: Number(ticker.lastPrice),
          change24h: Number(ticker.priceChangePercent),
          turnover24h: Number(ticker.quoteVolume),
          spreadBps,
          fundingRate: fundingMap.get(ticker.symbol) ?? Number.NaN,
          candles,
        };
        rows.push(evaluateMarket(market, rules, asOf));
      } catch {
        failed++;
      } finally {
        done++;
        onProgress?.(done, pool.length);
      }
    }
  }));
  if (!rows.length) throw new Error('K线读取全部失败；没有生成信号');
  rows.sort((a, b) => (a.side === 'NO_TRADE' ? 1 : 0) - (b.side === 'NO_TRADE' ? 1 : 0) || b.score - a.score);
  return { rows, asOf, failed, attempted: pool.length, source: FUTURES_SOURCE, startedAt, completedAt: Date.now() };
}
