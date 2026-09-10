import { calculateGrid, calculateRisk, type Candidate, type Rules } from './engine.ts';
import { advancePaper, startPaper, type PaperState } from './plans.ts';

export const MAX_AUTOPILOT_TICK_GAP_MS = 30_000;

export type AutopilotStatus = 'RUNNING' | 'STOPPED_OUT' | 'HALTED' | 'STOPPED_BY_USER';

type BaseAutopilot = {
  schema: 'trendlock.autopilot/v1';
  execution: 'PAPER';
  status: AutopilotStatus;
  symbol: string;
  markPrice: number;
  previousMark: number;
  startedAt: number;
  lastTickAt: number;
  tickCount: number;
  realizedPnl: number;
  events: string[];
};

export type TrendAutopilot = BaseAutopilot & {
  kind: 'TREND';
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  notional: number;
  margin: number;
  initialStopPct: number;
  paper: PaperState;
};

export type GridLot = {
  buyPrice: number;
  sellPrice: number;
  quantity: number;
  status: 'INACTIVE' | 'WAITING_BUY' | 'OPEN';
};

export type GridAutopilot = BaseAutopilot & {
  kind: 'GRID';
  side: 'LONG_GRID';
  lower: number;
  upper: number;
  lowerHardStop: number;
  upperHardStop: number;
  notional: number;
  margin: number;
  lots: GridLot[];
};

export type AutopilotState = TrendAutopilot | GridAutopilot;

const event = (state: AutopilotState, message: string) =>
  [...state.events, message].slice(-40);

const validPrice = (value: number) => Number.isFinite(value) && value > 0;

export function startAutopilot(candidate: Candidate, rules: Rules, now = Date.now()): AutopilotState {
  if (!Number.isFinite(now) || now <= 0) throw new Error('自动化启动时间无效');
  if (candidate.side === 'NO_TRADE' || candidate.evidence.some((item) => !item.pass)) {
    throw new Error('候选未通过全部硬规则，不能启动自动化');
  }
  if (!validPrice(candidate.price)) throw new Error('自动化开仓参考价无效');

  if (candidate.side === 'LONG' || candidate.side === 'SHORT') {
    const risk = calculateRisk(rules, candidate.price);
    return {
      schema: 'trendlock.autopilot/v1',
      execution: 'PAPER',
      kind: 'TREND',
      status: 'RUNNING',
      symbol: candidate.symbol,
      side: candidate.side,
      entryPrice: candidate.price,
      quantity: risk.quantity,
      notional: risk.notional,
      margin: risk.margin,
      initialStopPct: rules.initialStopPct,
      markPrice: candidate.price,
      previousMark: candidate.price,
      startedAt: now,
      lastTickAt: now,
      tickCount: 0,
      realizedPnl: 0,
      paper: startPaper(candidate.side, candidate.price, rules.initialStopPct, candidate.atrPct),
      events: [`PAPER 自动化启动：${candidate.symbol} ${candidate.side}，模拟成交均价 ${candidate.price}`],
    };
  }

  const grid = calculateGrid(candidate, rules.gridStepPct);
  if (!grid) throw new Error('当前区间不足两格，不能启动网格自动化');
  const levels = grid.levels.slice(0, -1);
  const lossFraction = levels.reduce(
    (sum, level) => sum + (level - grid.lowerHardStop) / level + 0.002,
    0,
  ) / levels.length;
  const budget = rules.accountEquity * rules.riskPct / 100;
  const notional = Math.min(budget / lossFraction, rules.accountEquity * rules.leverage);
  const perLotNotional = notional / levels.length;
  return {
    schema: 'trendlock.autopilot/v1',
    execution: 'PAPER',
    kind: 'GRID',
    status: 'RUNNING',
    symbol: candidate.symbol,
    side: 'LONG_GRID',
    lower: grid.lower,
    upper: grid.upper,
    lowerHardStop: grid.lowerHardStop,
    upperHardStop: grid.upperHardStop,
    notional,
    margin: notional / rules.leverage,
    markPrice: candidate.price,
    previousMark: candidate.price,
    startedAt: now,
    lastTickAt: now,
    tickCount: 0,
    realizedPnl: 0,
    lots: levels.map((buyPrice, index) => ({
      buyPrice,
      sellPrice: grid.levels[index + 1],
      quantity: perLotNotional / buyPrice,
      status: buyPrice < candidate.price ? 'WAITING_BUY' : 'INACTIVE',
    })),
    events: [`PAPER 网格启动：${candidate.symbol}，${levels.length} 个买入层级，突破边界自动停止`],
  };
}

export function applyAutopilotTick(state: AutopilotState, markPrice: number, at = Date.now()): AutopilotState {
  if (state.status !== 'RUNNING') return state;
  if (!validPrice(markPrice)) throw new Error('自动化行情价格无效');
  if (!Number.isFinite(at) || at <= state.lastTickAt) throw new Error('自动化行情时间必须递增');
  if (at - state.lastTickAt > MAX_AUTOPILOT_TICK_GAP_MS) {
    return {
      ...state,
      status: 'HALTED',
      previousMark: state.markPrice,
      markPrice,
      lastTickAt: at,
      tickCount: state.tickCount + 1,
      events: event(state, `行情中断超过 ${MAX_AUTOPILOT_TICK_GAP_MS / 1000} 秒，自动熔断；需人工对账后重新启动`),
    };
  }

  if (state.kind === 'TREND') {
    const favorablePct = state.side === 'LONG'
      ? (markPrice / state.entryPrice - 1) * 100
      : (1 - markPrice / state.entryPrice) * 100;
    const previousStop = state.paper.stop.stopPrice;
    const paper = advancePaper(state.paper, favorablePct, state.initialStopPct);
    const stopped = paper.status === 'STOP_TRIGGERED';
    const grossPnl = stopped
      ? state.quantity * (state.side === 'LONG' ? markPrice - state.entryPrice : state.entryPrice - markPrice)
      : state.realizedPnl;
    const messages: string[] = [];
    if (paper.stop.stopPrice !== previousStop) messages.push(`阶梯提高：保护价 ${paper.stop.stopPrice}`);
    if (stopped) messages.push(`价格越过保护线，PAPER 仓位关闭；观察成交参考 ${markPrice}`);
    return {
      ...state,
      status: stopped ? 'STOPPED_OUT' : 'RUNNING',
      previousMark: state.markPrice,
      markPrice,
      lastTickAt: at,
      tickCount: state.tickCount + 1,
      realizedPnl: grossPnl,
      paper,
      events: messages.reduce((items, message) => [...items, message].slice(-40), state.events),
    };
  }

  const hardExit = markPrice <= state.lowerHardStop || markPrice >= state.upperHardStop;
  if (hardExit) {
    const liquidationPnl = state.lots
      .filter((lot) => lot.status === 'OPEN')
      .reduce((sum, lot) => sum + lot.quantity * (markPrice - lot.buyPrice), 0);
    return {
      ...state,
      status: 'STOPPED_OUT',
      previousMark: state.markPrice,
      markPrice,
      lastTickAt: at,
      tickCount: state.tickCount + 1,
      realizedPnl: state.realizedPnl + liquidationPnl,
      lots: state.lots.map((lot) => lot.status === 'OPEN' ? { ...lot, status: 'INACTIVE' } : lot),
      events: event(state, `${markPrice <= state.lowerHardStop ? '下方' : '上方'}硬退出触发，PAPER 网格停止并按观察价清算库存`),
    };
  }

  let realizedPnl = state.realizedPnl;
  const messages: string[] = [];
  const lots = state.lots.map((lot) => {
    if (lot.status === 'INACTIVE' && markPrice > lot.buyPrice) {
      messages.push(`激活买入层级 ${lot.buyPrice}`);
      return { ...lot, status: 'WAITING_BUY' as const };
    }
    if (lot.status === 'WAITING_BUY' && state.markPrice > lot.buyPrice && markPrice <= lot.buyPrice) {
      messages.push(`模拟买入成交 ${lot.buyPrice} → 等待 ${lot.sellPrice} 卖出`);
      return { ...lot, status: 'OPEN' as const };
    }
    if (lot.status === 'OPEN' && state.markPrice < lot.sellPrice && markPrice >= lot.sellPrice) {
      realizedPnl += lot.quantity * (lot.sellPrice - lot.buyPrice);
      messages.push(`模拟网格卖出 ${lot.sellPrice}，该格完成`);
      return { ...lot, status: 'WAITING_BUY' as const };
    }
    return lot;
  });
  return {
    ...state,
    previousMark: state.markPrice,
    markPrice,
    lastTickAt: at,
    tickCount: state.tickCount + 1,
    realizedPnl,
    lots,
    events: messages.reduce((items, message) => [...items, message].slice(-40), state.events),
  };
}

export function stopAutopilot(state: AutopilotState, at = Date.now(), reason = '用户停止'):
  AutopilotState {
  if (state.status !== 'RUNNING') return state;
  return {
    ...state,
    status: 'STOPPED_BY_USER',
    lastTickAt: at,
    events: event(state, `${reason}；PAPER 状态已冻结`),
  };
}

export function recoverAutopilot(state: AutopilotState, at = Date.now()): AutopilotState {
  if (state.status !== 'RUNNING') return state;
  return {
    ...state,
    status: 'HALTED',
    lastTickAt: at,
    events: event(state, '检测到页面曾离开或刷新，自动熔断；PAPER 状态已恢复但不会自行续跑'),
  };
}

export function haltAutopilot(state: AutopilotState, at = Date.now(), reason = '安全熔断'): AutopilotState {
  if (state.status !== 'RUNNING') return state;
  return {
    ...state,
    status: 'HALTED',
    lastTickAt: at,
    events: event(state, `${reason}；需人工核验后重新启动`),
  };
}

export function unrealizedPnl(state: AutopilotState) {
  if (state.kind === 'TREND') {
    if (state.status === 'STOPPED_OUT') return 0;
    return state.quantity * (state.side === 'LONG'
      ? state.markPrice - state.entryPrice
      : state.entryPrice - state.markPrice);
  }
  return state.lots
    .filter((lot) => lot.status === 'OPEN')
    .reduce((sum, lot) => sum + lot.quantity * (state.markPrice - lot.buyPrice), 0);
}

export function nextDemoPrice(state: AutopilotState) {
  if (state.kind === 'TREND') {
    const moves = [2, 5.2, 8.3, 7, 5.2, 4.8];
    const move = moves[Math.min(state.tickCount, moves.length - 1)];
    return state.entryPrice * (1 + (state.side === 'LONG' ? move : -move) / 100);
  }
  const target = state.lots
    .filter((lot) => lot.status === 'WAITING_BUY')
    .sort((a, b) => b.buyPrice - a.buyPrice)[0] ?? state.lots[0];
  const open = state.lots.find((lot) => lot.status === 'OPEN');
  if (open) return open.sellPrice * 1.001;
  return target.buyPrice * 0.999;
}
