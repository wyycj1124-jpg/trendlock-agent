import { calculateGrid, calculateRisk, calculateStop, validateRules, type Candidate, type Rules, type StopState } from './engine.ts';

export type PaperState = {
  stop: StopState;
  status: 'OPEN' | 'STOP_TRIGGERED';
  marks: number[];
  events: string[];
  exitReference: number | null;
};

export function startPaper(side: 'LONG' | 'SHORT', entry: number, initialStopPct = 7): PaperState {
  return {
    stop: calculateStop(side, entry, entry, entry, undefined, initialStopPct),
    status: 'OPEN', marks: [0], exitReference: null,
    events: [`模拟建仓：${side}，开仓基准 ${entry}；初始保护 −${initialStopPct}%`],
  };
}

export function advancePaper(state: PaperState, favorablePct: number, initialStopPct = 7): PaperState {
  if (!Number.isFinite(favorablePct) || favorablePct < -30 || favorablePct > 60) throw new Error('模拟变化必须在 −30% 到 +60%');
  if (state.status !== 'OPEN') return state;
  const { side, entry, extreme, stopPrice } = state.stop;
  const mark = entry * (1 + (side === 'LONG' ? favorablePct : -favorablePct) / 100);
  // Evaluate the old protective order before advancing the ladder.
  const crossed = side === 'LONG' ? mark <= stopPrice + entry * 1e-12 : mark >= stopPrice - entry * 1e-12;
  if (crossed) return {
    ...state, status: 'STOP_TRIGGERED', exitReference: mark,
    stop: { ...state.stop, mark, favorablePct, triggered: true },
    marks: [...state.marks, favorablePct],
    events: [...state.events, `价格触及/越过保护线，模拟平仓；观察价 ${mark}，触发价 ${stopPrice}，实际成交仍取决于滑点。`],
  };
  const next = calculateStop(side, entry, mark, extreme, stopPrice, initialStopPct);
  return {
    ...state, stop: next, marks: [...state.marks, favorablePct],
    events: [...state.events, next.stopPrice !== stopPrice
      ? `有利变化 +${favorablePct}%：模拟新止损确认 → 旧止损撤销；保护 ${next.stopReturnPct.toFixed(2)}%`
      : `有利变化 ${favorablePct}%：保护线保持 ${next.stopReturnPct.toFixed(2)}%`],
  };
}

export function stageCandidate(candidate: Candidate, rules: Rules, source: string, asOf: number, now: number, stale: boolean) {
  validateRules(rules);
  if (stale || (source !== 'SYNTHETIC' && (now - asOf > 120_000 || asOf - now > 5_000))) throw new Error('证据已过期或上一轮失败，请先重新扫描');
  if (candidate.side === 'NO_TRADE' || !candidate.evidence.length || candidate.evidence.some((item) => !item.pass)) throw new Error('候选未通过全部硬规则');
  const grid = calculateGrid(candidate, rules.gridStepPct);
  if (candidate.side === 'RANGE' && !grid) throw new Error('区间太窄，不足以容纳至少两格；请调小格距或等待');
  if (grid) {
    // Long-grid plan. Upper levels sell existing inventory; never create naked shorts.
    const levels = grid.levels.slice(0, -1);
    const lossFraction = levels.reduce((sum, level) => sum + (level - grid.lowerHardStop) / level + 0.002, 0) / levels.length;
    const budget = rules.accountEquity * rules.riskPct / 100;
    const notional = Math.min(budget / lossFraction, rules.accountEquity * rules.leverage);
    return {
      kind: 'LONG_GRID_PLAN', status: 'DRAFT_ONLY', source,
      symbol: candidate.symbol, grid,
      orders: levels.map((level, index) => ({ limitPrice: level, quantity: notional / levels.length / level, sellAfterBuyFill: grid.levels[index + 1], activation: level < candidate.price ? 'BUY_LIMIT_DRAFT' : 'WAIT_UNTIL_PRICE_ABOVE_LEVEL' })),
      notional, margin: notional / rules.leverage, riskBudget: budget,
      estimatedLossAtStopWithReserve: notional * lossFraction,
      requirements: ['启动前核验实际持仓与挂单为空', '硬止损后停止全部补仓', '价格或数量尚未按交易所步长量化'],
    };
  }
  return {
    kind: 'TREND_PLAN', status: 'DRAFT_ONLY', source,
    symbol: candidate.symbol, side: candidate.side,
    indicativeEntry: candidate.price, risk: calculateRisk(rules, candidate.price),
    protection: calculateStop(candidate.side as 'LONG' | 'SHORT', candidate.price, candidate.price, candidate.price, undefined, rules.initialStopPct),
    requirements: ['成交后改用真实加权均价', '核验强平价缓冲与实际持仓', '价格或数量尚未按交易所步长量化'],
  };
}
