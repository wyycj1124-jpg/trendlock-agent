export type Side = 'LONG' | 'SHORT' | 'RANGE' | 'NO_TRADE';
export type Interval = '15m' | '1h' | '4h';

export type Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Rules = {
  interval: Interval;
  poolSize: number;
  minTurnover: number;
  maxSpreadBps: number;
  minVolumeRatio: number;
  accountEquity: number;
  riskPct: number;
  leverage: number;
  initialStopPct: number;
  gridStepPct: number;
};

export type Market = {
  symbol: string;
  price: number;
  change24h: number;
  turnover24h: number;
  spreadBps: number;
  fundingRate: number;
  candles: Candle[];
};

export type Evidence = {
  label: string;
  value: string;
  pass: boolean;
};

export type Candidate = Market & {
  side: Side;
  score: number;
  reason: string;
  evidence: Evidence[];
  ema20: number;
  ema50: number;
  atrPct: number;
  volumeRatio: number;
  signalTime: number;
  rangeLow: number;
  rangeHigh: number;
};

export type StopState = {
  side: 'LONG' | 'SHORT';
  entry: number;
  mark: number;
  extreme: number;
  favorablePct: number;
  stage: 0 | 1 | 2 | 3 | 4;
  stopPrice: number;
  stopReturnPct: number;
  trailingGapPct: number | null;
  nextTriggerPct: number | null;
  triggered: boolean;
};

export const defaults: Rules = {
  interval: '1h',
  poolSize: 36,
  minTurnover: 20_000_000,
  maxSpreadBps: 8,
  minVolumeRatio: 1.2,
  accountEquity: 10_000,
  riskPct: 10,
  leverage: 3,
  initialStopPct: 7,
  gridStepPct: 3,
};

export function validateRules(rules: Rules) {
  if (!['15m', '1h', '4h'].includes(rules.interval)) throw new Error('周期仅支持 15m、1h、4h');
  const checks: Array<[number, number, number, string]> = [
    [rules.poolSize, 8, 80, '扫描池'],
    [rules.minTurnover, 0, 1e12, '最低成交额'],
    [rules.maxSpreadBps, 0.1, 100, '最大价差'],
    [rules.minVolumeRatio, 0.2, 10, '最小量比'],
    [rules.accountEquity, 1, 1e12, '账户权益'],
    [rules.riskPct, 0.05, 10, '单笔风险'],
    [rules.leverage, 1, 3, '原型杠杆上限'],
    [rules.initialStopPct, 1, 30, '初始止损'],
    [rules.gridStepPct, 0.2, 10, '网格间距'],
  ];
  for (const [value, min, max, name] of checks) {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${name}超出允许范围 ${min}–${max}`);
    }
  }
  if (!Number.isInteger(rules.poolSize)) throw new Error('扫描池必须为整数');
  if (!Number.isInteger(rules.leverage)) throw new Error('杠杆必须为整数');
}

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function ema(values: number[], length: number) {
  if (!values.length) return 0;
  const alpha = 2 / (length + 1);
  return values.slice(1).reduce((value, next) => value + alpha * (next - value), values[0]);
}

function atr(candles: Candle[], length = 14) {
  const recent = candles.slice(-length - 1);
  if (recent.length < 2) return 0;
  return mean(
    recent.slice(1).map((bar, index) => {
      const previousClose = recent[index].close;
      return Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previousClose),
        Math.abs(bar.low - previousClose),
      );
    }),
  );
}

const fmt = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: value < 1 ? 6 : 2 });

export function evaluateMarket(market: Market, rules: Rules, asOf: number): Candidate {
  validateRules(rules);
  const bars = market.candles.filter((bar) => bar.closeTime < asOf);
  const empty: Candidate = {
    ...market,
    candles: bars,
    side: 'NO_TRADE',
    score: 0,
    reason: '有效已收盘K线不足',
    evidence: [],
    ema20: 0,
    ema50: 0,
    atrPct: 0,
    volumeRatio: 0,
    signalTime: 0,
    rangeLow: 0,
    rangeHigh: 0,
  };
  if (bars.length < 55) return empty;
  const intervalMs = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 }[rules.interval];
  if (!Number.isFinite(asOf) || asOf - bars.at(-1)!.closeTime > intervalMs + 1_000 ||
    bars.some((bar, index) => bar.closeTime !== bar.openTime + intervalMs - 1 ||
      (index > 0 && bar.openTime - bars[index - 1].openTime !== intervalMs))) {
    return { ...empty, reason: 'K线过期、周期不符或时间序列不连续' };
  }
  if (![market.price, market.change24h, market.turnover24h, market.spreadBps, market.fundingRate].every(Number.isFinite) || market.price <= 0) {
    return { ...empty, reason: '报价、资金费率或流动性数据缺失/异常' };
  }
  if (
    bars.some(
      (bar) =>
        ![bar.openTime, bar.closeTime, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.low <= 0 ||
        bar.high < Math.max(bar.open, bar.close) ||
        bar.low > Math.min(bar.open, bar.close) ||
        bar.volume < 0,
    )
  ) return { ...empty, reason: 'K线数据异常，已拒绝' };

  const last = bars.at(-1)!;
  const closes = bars.map((bar) => bar.close);
  const currentEma20 = ema(closes, 20);
  const currentEma50 = ema(closes, 50);
  const previousEma20 = ema(closes.slice(0, -4), 20);
  const slopePct = previousEma20 > 0 ? ((currentEma20 / previousEma20) - 1) * 100 : 0;
  const atrPct = last.close > 0 ? (atr(bars) / last.close) * 100 : 0;
  const prior20 = bars.slice(-21, -1);
  const previousVolume = mean(prior20.map((bar) => bar.volume));
  const volumeRatio = previousVolume > 0 ? last.volume / previousVolume : 0;
  const rangeBars = bars.slice(-48);
  const rangeLow = Math.min(...rangeBars.map((bar) => bar.low));
  const rangeHigh = Math.max(...rangeBars.map((bar) => bar.high));
  const separationPct = Math.abs(currentEma20 - currentEma50) / last.close * 100;
  const liquid = market.turnover24h >= rules.minTurnover;
  const tight = market.spreadBps >= 0 && market.spreadBps <= rules.maxSpreadBps;
  const volumePass = volumeRatio >= rules.minVolumeRatio;
  const longAligned = currentEma20 > currentEma50 && slopePct > 0.08 && last.close > currentEma20;
  const shortAligned = currentEma20 < currentEma50 && slopePct < -0.08 && last.close < currentEma20;
  const rangeAligned = [0, 1, 2].every((offset) => {
    const history = offset ? closes.slice(0, -offset) : closes;
    const fast = ema(history, 20), slow = ema(history, 50), earlier = ema(history.slice(0, -4), 20);
    return Math.abs(fast - slow) / history.at(-1)! * 100 < 0.75 && Math.abs(fast / earlier - 1) * 100 < 0.18;
  }) && atrPct >= 0.45 && atrPct <= 5.5;

  let side: Side = 'NO_TRADE';
  if (liquid && tight && volumePass && rangeAligned) side = 'RANGE';
  else if (liquid && tight && volumePass && !rangeAligned && separationPct >= 0.75 && longAligned) side = 'LONG';
  else if (liquid && tight && volumePass && !rangeAligned && separationPct >= 0.75 && shortAligned) side = 'SHORT';

  const directionPass = side !== 'NO_TRADE';
  const liquidityScore = liquid ? Math.min(18, 8 + Math.log10(market.turnover24h / Math.max(1, rules.minTurnover) + 1) * 8) : 0;
  const spreadScore = tight ? Math.max(3, 15 * (1 - market.spreadBps / rules.maxSpreadBps)) : 0;
  const volumeScore = Math.min(20, (volumeRatio / rules.minVolumeRatio) * 14);
  const score = Math.max(0, Math.min(99, Math.round(
    liquidityScore + spreadScore + (directionPass ? (side === 'RANGE' ? 26 : 30) : 0) + volumeScore + (atrPct >= 0.5 && atrPct <= 5.5 ? 12 : 3),
  )));

  const directionValue = side === 'RANGE'
    ? `EMA距离 ${separationPct.toFixed(2)}% · ATR ${atrPct.toFixed(2)}%`
    : `EMA20 ${fmt(currentEma20)} / EMA50 ${fmt(currentEma50)} · 斜率 ${slopePct.toFixed(2)}%`;
  const evidence: Evidence[] = [
    { label: side === 'RANGE' ? '震荡结构' : '趋势结构', value: directionValue, pass: directionPass },
    { label: `已收盘量比 ≥ ${rules.minVolumeRatio.toFixed(1)}×`, value: `${volumeRatio.toFixed(2)}×`, pass: volumePass },
    { label: `24h成交额 ≥ ${(rules.minTurnover / 1e6).toFixed(0)}M`, value: `$${(market.turnover24h / 1e6).toFixed(1)}M`, pass: liquid },
    { label: `买卖价差 ≤ ${rules.maxSpreadBps.toFixed(1)} bps`, value: `${market.spreadBps.toFixed(2)} bps`, pass: tight },
  ];
  const failed = evidence.filter((item) => !item.pass).map((item) => item.label);
  const reason = side === 'LONG'
    ? `EMA多头排列，斜率 ${slopePct.toFixed(2)}%，价格保持在EMA20上方`
    : side === 'SHORT'
      ? `EMA空头排列，斜率 ${slopePct.toFixed(2)}%，价格保持在EMA20下方`
      : side === 'RANGE'
        ? `均线距离仅 ${separationPct.toFixed(2)}%，ATR ${atrPct.toFixed(2)}%，适合生成网格计划`
        : `拒绝交易：${failed.length ? failed.join(' · ') : '趋势与震荡条件均不完整'}`;

  return {
    ...empty,
    side,
    score,
    reason,
    evidence,
    ema20: currentEma20,
    ema50: currentEma50,
    atrPct,
    volumeRatio,
    signalTime: last.closeTime,
    rangeLow,
    rangeHigh,
  };
}

export function calculateRisk(rules: Rules, entry: number) {
  validateRules(rules);
  if (!Number.isFinite(entry) || entry <= 0) throw new Error('开仓价格无效');
  const maxLoss = rules.accountEquity * (rules.riskPct / 100);
  // Illustrative round-trip fees + slippage reserve, not a fill guarantee.
  const costReservePct = 0.2;
  const notional = maxLoss / ((rules.initialStopPct + costReservePct) / 100);
  return {
    maxLoss,
    notional,
    margin: notional / rules.leverage,
    quantity: notional / entry,
    stopLoss: notional * rules.initialStopPct / 100,
    costReserve: notional * costReservePct / 100,
    costReservePct,
  };
}

export function calculateStop(
  side: 'LONG' | 'SHORT',
  entry: number,
  mark: number,
  extreme = mark,
  previousStop?: number,
  initialStopPct = 7,
  atrPct = 0,
): StopState {
  if (![entry, mark, extreme].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('止损计算价格无效');
  }
  if (!['LONG', 'SHORT'].includes(side) || !Number.isFinite(initialStopPct) || initialStopPct <= 0 || initialStopPct >= 100 ||
    !Number.isFinite(atrPct) || atrPct < 0 ||
    (previousStop !== undefined && (!Number.isFinite(previousStop) || previousStop <= 0))) throw new Error('止损参数无效');
  extreme = side === 'LONG' ? Math.max(entry, mark, extreme) : Math.min(entry, mark, extreme);
  const favorablePct = side === 'LONG' ? ((mark / entry) - 1) * 100 : (1 - mark / entry) * 100;
  const extremeFavorablePct = side === 'LONG' ? ((extreme / entry) - 1) * 100 : (1 - extreme / entry) * 100;
  let stage: StopState['stage'] = 0;
  let rawStop = side === 'LONG' ? entry * (1 - initialStopPct / 100) : entry * (1 + initialStopPct / 100);
  let trailingGapPct: number | null = null;
  let nextTriggerPct: number | null = 5;
  if (extremeFavorablePct >= 5 - 1e-9) {
    stage = 1;
    rawStop = side === 'LONG' ? entry * 1.02 : entry * 0.98;
    nextTriggerPct = 8;
  }
  if (extremeFavorablePct >= 8 - 1e-9) {
    stage = 2;
    rawStop = side === 'LONG' ? entry * 1.05 : entry * 0.95;
    nextTriggerPct = 11;
  }
  if (extremeFavorablePct >= 11 - 1e-9) {
    stage = 3;
    const lockPct = 8;
    rawStop = entry * (1 + (side === 'LONG' ? lockPct : -lockPct) / 100);
    nextTriggerPct = 15;
  }
  if (extremeFavorablePct >= 15 - 1e-9) {
    stage = 4;
    trailingGapPct = Math.min(8, Math.max(5, atrPct * 1.5));
    const lockPct = Math.max(10, extremeFavorablePct - trailingGapPct);
    rawStop = entry * (1 + (side === 'LONG' ? lockPct : -lockPct) / 100);
    nextTriggerPct = null;
  }
  const stopPrice = previousStop === undefined
    ? rawStop
    : side === 'LONG' ? Math.max(previousStop, rawStop) : Math.min(previousStop, rawStop);
  return {
    side,
    entry,
    mark,
    extreme,
    favorablePct,
    stage,
    stopPrice,
    stopReturnPct: side === 'LONG' ? ((stopPrice / entry) - 1) * 100 : (1 - stopPrice / entry) * 100,
    trailingGapPct,
    nextTriggerPct,
    triggered: side === 'LONG' ? mark <= stopPrice + entry * 1e-12 : mark >= stopPrice - entry * 1e-12,
  };
}

export function calculateGrid(candidate: Candidate, stepPct: number) {
  if (candidate.side !== 'RANGE') return null;
  if (!Number.isFinite(stepPct) || stepPct <= 0) throw new Error('网格间距无效');
  const widthPct = ((candidate.rangeHigh / candidate.rangeLow) - 1) * 100;
  const grids = Math.min(12, Math.floor(Math.log(candidate.rangeHigh / candidate.rangeLow) / Math.log(1 + stepPct / 100)));
  if (!Number.isFinite(widthPct) || candidate.rangeLow <= 0 || grids < 2) return null;
  const ratio = (candidate.rangeHigh / candidate.rangeLow) ** (1 / grids);
  return {
    lower: candidate.rangeLow,
    upper: candidate.rangeHigh,
    grids,
    stepPct: (ratio - 1) * 100,
    levels: Array.from({ length: grids + 1 }, (_, i) => candidate.rangeLow * ratio ** i),
    lowerHardStop: candidate.rangeLow * 0.95,
    upperHardStop: candidate.rangeHigh * 1.05,
};
}

export function parseIntent(text: string, current: Rules): Rules {
  const next = { ...current };
  if (/15\s*分|15m/i.test(text)) next.interval = '15m';
  else if (/4\s*小时|4h/i.test(text)) next.interval = '4h';
  else if (/1\s*小时|1h/i.test(text)) next.interval = '1h';
  const risk = text.match(/(?:风险|单笔风险)\s*(\d+(?:\.\d+)?)\s*%?/);
  const leverage = text.match(/(\d+(?:\.\d+)?)\s*倍杠杆/) ?? text.match(/杠杆\s*(\d+(?:\.\d+)?)\s*倍?/);
  const volume = text.match(/(?:量比|放量)\s*(?:至少|大于|≥|>=)?\s*(\d+(?:\.\d+)?)/);
  const grid = text.match(/(?:网格|一格|格距|间距)\s*(\d+(?:\.\d+)?)\s*%/);
  const initialStop = text.match(/(?:硬止损|初始止损|止损距离)\s*(\d+(?:\.\d+)?)\s*%/);
  if (risk) next.riskPct = Number(risk[1]);
  if (leverage) next.leverage = Number(leverage[1]);
  if (volume) next.minVolumeRatio = Number(volume[1]);
  if (grid) next.gridStepPct = Number(grid[1]);
  if (initialStop) next.initialStopPct = Number(initialStop[1]);
  validateRules(next);
  return next;
}
