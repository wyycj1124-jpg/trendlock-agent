import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Opt-in local adapter for Binance's official CLI. Public GET endpoints only.
// No arbitrary commands, signing flags, profile reads, balances, orders or transfers.
const run = promisify(execFile);
const symbols = (process.argv[2] ?? 'SOLUSDT,LINKUSDT,DOGEUSDT').split(',');
const interval = process.argv[3] ?? '1h';
if (symbols.length > 8 || symbols.some((symbol) => !/^[A-Z0-9]{2,20}USDT$/.test(symbol)) || !['15m', '1h', '4h'].includes(interval)) throw new Error('最多8个USDT币对；周期15m/1h/4h');
const traces: object[] = [];
const read = async (path: string, query: Record<string, string> = {}) => {
  const endpoint = new URL(path, 'https://fapi.binance.com');
  for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value);
  const args = ['request', 'GET', endpoint.href];
  // Never expose raw CLI stderr: some clients include profile metadata.
  const { stdout } = await run('binance-cli', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 10_000_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' } })
    .catch(() => { throw new Error('官方binance-cli未安装、接口受限或请求失败；请按官方文档检查。不改用其他地区接口。'); });
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error('binance-cli未返回纯JSON，拒绝继续'); }
  if (data && typeof data === 'object' && 'code' in data && data.code < 0) throw new Error('Binance返回错误，停止采集');
  traces.push({ name: `binance-cli request GET ${path}`, status: 'SUCCESS', symbols: query.symbol ? [query.symbol] : symbols });
  return data;
};
const clock = await read('/fapi/v1/time');
if (!Number.isFinite(clock.serverTime)) throw new Error('缺少服务器时间');
const exchange = await read('/fapi/v1/exchangeInfo');
const markets = [];
for (const symbol of symbols) {
  if (!exchange.symbols?.some((item: {symbol: string; status: string; contractType: string; quoteAsset: string}) => item.symbol === symbol && item.status === 'TRADING' && item.contractType === 'PERPETUAL' && item.quoteAsset === 'USDT')) throw new Error('币对不是可交易USDT永续合约');
  const ticker = await read('/fapi/v1/ticker/24hr', { symbol });
  const book = await read('/fapi/v1/ticker/bookTicker', { symbol });
  const premium = await read('/fapi/v1/premiumIndex', { symbol });
  const candles = await read('/fapi/v1/klines', { symbol, interval, limit: '72' });
  const bid = Number(book.bidPrice), ask = Number(book.askPrice);
  markets.push({
    symbol, price: Number(ticker.lastPrice), change24h: Number(ticker.priceChangePercent), turnover24h: Number(ticker.quoteVolume),
    spreadBps: bid > 0 && ask >= bid ? (ask - bid) / ((ask + bid) / 2) * 10_000 : null,
    fundingRate: Number(premium.lastFundingRate),
    candles: candles.map((bar: Array<string | number>) => ({ openTime: Number(bar[0]), open: Number(bar[1]), high: Number(bar[2]), low: Number(bar[3]), close: Number(bar[4]), volume: Number(bar[5]), closeTime: Number(bar[6]) })),
  });
}
process.stdout.write(JSON.stringify({ schema: 'trendlock.market/v1', transport: 'BINANCE_SKILL', collectedAt: clock.serverTime, tools: traces, markets }, null, 2) + '\n');
