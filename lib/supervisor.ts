import { calculateStop } from './engine.ts';

export const MAX_SUPERVISOR_TICK_GAP_MS = 30_000;

export type SupervisorStatus =
  | 'MONITORING'
  | 'WAITING_CONFIRMATION'
  | 'RECONCILIATION_REQUIRED'
  | 'HALTED'
  | 'CLOSED';

export type StopReplacement = {
  kind: 'REPLACE_PROTECTIVE_STOP';
  symbol: string;
  orderSide: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  workingType: 'MARK_PRICE';
  closePosition: true;
  previousTriggerPrice: number;
  requestedTriggerPrice: number;
  requestedLockPct: number;
  createdAt: number;
  confirmationRequired: true;
};

export type SupervisorState = {
  schema: 'trendlock.supervisor/v1';
  status: SupervisorStatus;
  symbol: string;
  side: 'LONG' | 'SHORT';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  currentStopPrice: number;
  currentStopReturnPct: number;
  markPrice: number;
  extremePrice: number;
  initialStopPct: number;
  nextTriggerPct: number | null;
  startedAt: number;
  lastTickAt: number;
  pendingAction: StopReplacement | null;
  events: string[];
};

export type SupervisorInput = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  currentStopPrice: number;
  markPrice?: number;
  initialStopPct?: number;
};

const validPrice = (value: number) => Number.isFinite(value) && value > 0;
const events = (state: SupervisorState, message: string) => [...state.events, message].slice(-60);
const tighter = (side: 'LONG' | 'SHORT', next: number, current: number) =>
  side === 'LONG' ? next > current + current * 1e-10 : next < current - current * 1e-10;
const crossed = (side: 'LONG' | 'SHORT', mark: number, stop: number) =>
  side === 'LONG' ? mark <= stop : mark >= stop;
const stopReturn = (side: 'LONG' | 'SHORT', entry: number, stop: number) =>
  (side === 'LONG' ? stop / entry - 1 : 1 - stop / entry) * 100;

export function startSupervisor(input: SupervisorInput, now = Date.now()): SupervisorState {
  const symbol = input.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) throw new Error('监督任务交易对格式无效');
  if (!validPrice(input.entryPrice) || !validPrice(input.currentStopPrice) ||
    !Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error('真实持仓参数无效');
  const markPrice = input.markPrice ?? input.entryPrice;
  const initialStopPct = input.initialStopPct ?? 10;
  if (!validPrice(markPrice) || !Number.isFinite(initialStopPct) || initialStopPct <= 0 || initialStopPct >= 100) {
    throw new Error('监督任务价格或止损参数无效');
  }
  if (crossed(input.side, markPrice, input.currentStopPrice)) {
    throw new Error('当前价格已经触及或越过现有止损，必须先读取账户并对账');
  }
  const positionSide = input.positionSide ?? 'BOTH';
  if (positionSide !== 'BOTH' && positionSide !== input.side) {
    throw new Error('双向持仓的 positionSide 必须与方向一致');
  }
  const calculated = calculateStop(
    input.side,
    input.entryPrice,
    markPrice,
    markPrice,
    input.currentStopPrice,
    initialStopPct,
  );
  return {
    schema: 'trendlock.supervisor/v1',
    status: 'MONITORING',
    symbol,
    side: input.side,
    positionSide,
    entryPrice: input.entryPrice,
    quantity: input.quantity,
    currentStopPrice: input.currentStopPrice,
    currentStopReturnPct: stopReturn(input.side, input.entryPrice, input.currentStopPrice),
    markPrice,
    extremePrice: calculated.extreme,
    initialStopPct,
    nextTriggerPct: calculated.nextTriggerPct,
    startedAt: now,
    lastTickAt: now,
    pendingAction: null,
    events: [`监督任务启动：${symbol} ${input.side}；现有服务器止损 ${input.currentStopPrice}`],
  };
}

export function observeSupervisor(state: SupervisorState, markPrice: number, at = Date.now()): SupervisorState {
  if (!['MONITORING', 'WAITING_CONFIRMATION'].includes(state.status)) return state;
  if (!validPrice(markPrice)) throw new Error('监督行情价格无效');
  if (!Number.isFinite(at) || at <= state.lastTickAt) throw new Error('监督行情时间必须递增');
  if (at - state.lastTickAt > MAX_SUPERVISOR_TICK_GAP_MS) {
    return haltSupervisor(state, at, '行情中断超过30秒');
  }
  if (crossed(state.side, markPrice, state.currentStopPrice)) {
    return {
      ...state,
      status: 'RECONCILIATION_REQUIRED',
      markPrice,
      lastTickAt: at,
      pendingAction: null,
      events: events(state, `标记价格 ${markPrice} 已越过现有服务器止损；停止推断，必须读取真实持仓和订单对账`),
    };
  }
  if (state.pendingAction && crossed(state.side, markPrice, state.pendingAction.requestedTriggerPrice)) {
    return {
      ...state,
      status: 'RECONCILIATION_REQUIRED',
      markPrice,
      lastTickAt: at,
      pendingAction: null,
      events: events(state, `确认前价格已回撤越过待提交止损 ${state.pendingAction.requestedTriggerPrice}；废弃该动作，必须读取真实持仓和订单对账`),
    };
  }

  const extremePrice = state.side === 'LONG'
    ? Math.max(state.extremePrice, markPrice)
    : Math.min(state.extremePrice, markPrice);
  const desired = calculateStop(
    state.side,
    state.entryPrice,
    markPrice,
    extremePrice,
    state.currentStopPrice,
    state.initialStopPct,
  );
  if (!tighter(state.side, desired.stopPrice, state.currentStopPrice)) {
    return {
      ...state,
      markPrice,
      extremePrice,
      nextTriggerPct: desired.nextTriggerPct,
      lastTickAt: at,
    };
  }
  if (state.pendingAction && Math.abs(state.pendingAction.requestedTriggerPrice - desired.stopPrice) <= Math.max(desired.stopPrice * 1e-10, 1e-12)) {
    return {
      ...state,
      markPrice,
      extremePrice,
      nextTriggerPct: desired.nextTriggerPct,
      lastTickAt: at,
    };
  }
  const action: StopReplacement = {
    kind: 'REPLACE_PROTECTIVE_STOP',
    symbol: state.symbol,
    orderSide: state.side === 'LONG' ? 'SELL' : 'BUY',
    positionSide: state.positionSide,
    workingType: 'MARK_PRICE',
    closePosition: true,
    previousTriggerPrice: state.currentStopPrice,
    requestedTriggerPrice: desired.stopPrice,
    requestedLockPct: desired.stopReturnPct,
    createdAt: at,
    confirmationRequired: true,
  };
  const replacingExisting = state.pendingAction !== null;
  return {
    ...state,
    status: 'WAITING_CONFIRMATION',
    markPrice,
    extremePrice,
    nextTriggerPct: desired.nextTriggerPct,
    lastTickAt: at,
    pendingAction: action,
    events: events(state, `${replacingExisting ? '更新' : '生成'}待确认改单：止损 ${state.currentStopPrice} → ${desired.stopPrice}，锁定 ${desired.stopReturnPct.toFixed(2)}%`),
  };
}

export function recordStopReplacement(state: SupervisorState, acceptedTriggerPrice: number, at = Date.now()): SupervisorState {
  if (state.status !== 'WAITING_CONFIRMATION' || !state.pendingAction) {
    throw new Error('当前没有待确认的改单动作');
  }
  const expected = state.pendingAction.requestedTriggerPrice;
  if (!validPrice(acceptedTriggerPrice) || Math.abs(acceptedTriggerPrice - expected) > Math.max(expected * 1e-6, 1e-12)) {
    throw new Error('记录的已接受止损价与待确认动作不一致');
  }
  return {
    ...state,
    status: 'MONITORING',
    currentStopPrice: acceptedTriggerPrice,
    currentStopReturnPct: stopReturn(state.side, state.entryPrice, acceptedTriggerPrice),
    lastTickAt: at,
    pendingAction: null,
    events: events(state, `已记录MCP读回核验结果：服务器止损更新为 ${acceptedTriggerPrice}`),
  };
}

export function reconcileSupervisor(
  state: SupervisorState,
  input: { quantity: number; entryPrice?: number; currentStopPrice?: number; markPrice: number },
  at = Date.now(),
): SupervisorState {
  if (!Number.isFinite(input.quantity) || input.quantity < 0 || !validPrice(input.markPrice)) {
    throw new Error('持仓对账数据无效');
  }
  if (input.quantity === 0) {
    return {
      ...state,
      status: 'CLOSED',
      quantity: 0,
      markPrice: input.markPrice,
      lastTickAt: at,
      pendingAction: null,
      events: events(state, 'MCP读回确认持仓数量为0；监督任务关闭'),
    };
  }
  const entryPrice = input.entryPrice ?? state.entryPrice;
  const currentStopPrice = input.currentStopPrice ?? state.currentStopPrice;
  if (!validPrice(entryPrice) || !validPrice(currentStopPrice) || crossed(state.side, input.markPrice, currentStopPrice)) {
    throw new Error('对账后的持仓或保护单仍不一致');
  }
  return {
    ...state,
    status: 'MONITORING',
    quantity: input.quantity,
    entryPrice,
    currentStopPrice,
    currentStopReturnPct: stopReturn(state.side, entryPrice, currentStopPrice),
    markPrice: input.markPrice,
    extremePrice: input.markPrice,
    lastTickAt: at,
    pendingAction: null,
    events: events(state, '已根据MCP读回的真实持仓和保护单完成对账；恢复监控'),
  };
}

export function haltSupervisor(state: SupervisorState, at = Date.now(), reason = '用户停止'): SupervisorState {
  if (['HALTED', 'CLOSED'].includes(state.status)) return state;
  return {
    ...state,
    status: 'HALTED',
    lastTickAt: at,
    pendingAction: null,
    events: events(state, `${reason}；现有币安服务器止损不受影响，恢复前必须重新读取账户对账`),
  };
}

export function recoverSupervisor(state: SupervisorState, at = Date.now()) {
  return ['MONITORING', 'WAITING_CONFIRMATION'].includes(state.status)
    ? haltSupervisor(state, at, '检测到页面刷新或离开')
    : state;
}

export function buildMcpReplacementPrompt(state: SupervisorState) {
  if (!state.pendingAction) throw new Error('当前没有待确认动作');
  const action = state.pendingAction;
  return [
    '使用 Binance MCP 处理以下 U 本位合约保护单调整。先只读取并核验，不要立即执行。',
    `交易对：${action.symbol}`,
    `持仓方向：${state.side}；positionSide：${action.positionSide}`,
    `网页记录的真实加权开仓均价：${state.entryPrice}`,
    `网页记录的持仓数量：${state.quantity}`,
    `当前服务器止损：${action.previousTriggerPrice}`,
    `请求的新止损触发价：${action.requestedTriggerPrice}`,
    `触发依据：相对真实加权开仓均价锁定 ${action.requestedLockPct.toFixed(2)}%，使用 MARK_PRICE。`,
    '执行前必须读取真实持仓、持仓模式、当前保护单、交易规则和数量；任一不一致就停止。',
    '请先向我展示将要提交的新全仓位保护单参数并等待确认。确认后先创建更紧的新保护单并读回验证，再单独请求确认是否取消旧保护单；任何一步含糊都进入对账，禁止盲目重试。',
  ].join('\n');
}
