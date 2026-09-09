import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGrid, calculateRisk, calculateStop, defaults, evaluateMarket, parseIntent } from './engine.ts';
import { demoMarkets, demoTime } from './demo.ts';
import { advancePaper, stageCandidate, startPaper } from './plans.ts';
import { importEvidence } from './evidence.ts';
import { applyAutopilotTick, nextDemoPrice, recoverAutopilot, startAutopilot, stopAutopilot, unrealizedPnl } from './automation.ts';
import { buildMcpReplacementPrompt, observeSupervisor, reconcileSupervisor, recordStopReplacement, recoverSupervisor, startSupervisor } from './supervisor.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

void test('risk sizing depends on account risk and stop distance, not leverage', () => {
  const base = calculateRisk(defaults, 100);
  const lowerLeverage = calculateRisk({ ...defaults, leverage: 1 }, 100);
  assert.equal(base.maxLoss, 1_000);
  near(base.notional, 1_000 / .072);
  assert.equal(lowerLeverage.notional, base.notional);
  near(lowerLeverage.margin, base.margin * 3);
  near(base.stopLoss + base.costReserve, 1_000);
});

void test('long staged stop locks profit at 5 and 8 percent', () => {
  assert.equal(calculateStop('LONG', 100, 104, 104).stopPrice, 93);
  assert.equal(calculateStop('LONG', 100, 104, 105).stopPrice, 102);
  assert.equal(calculateStop('LONG', 100, 107, 108).stopPrice, 105);
});

void test('short staged stop mirrors long behavior', () => {
  assert.equal(calculateStop('SHORT', 100, 96, 96).stopPrice, 107);
  assert.equal(calculateStop('SHORT', 100, 96, 95).stopPrice, 98);
  assert.equal(calculateStop('SHORT', 100, 93, 92).stopPrice, 95);
});

void test('stop never loosens after it has tightened', () => {
  assert.equal(calculateStop('LONG', 100, 101, 101, 105).stopPrice, 105);
  assert.equal(calculateStop('SHORT', 100, 99, 99, 95).stopPrice, 95);
});

void test('intent parser extracts interval, risk, leverage and grid step', () => {
  const parsed = parseIntent('扫描 4 小时趋势，单笔风险 0.25%，硬止损 7%，2 倍杠杆，网格 2.5%', defaults);
  assert.equal(parsed.interval, '4h');
  assert.equal(parsed.riskPct, 0.25);
  assert.equal(parsed.leverage, 2);
  assert.equal(parsed.initialStopPct, 7);
  assert.equal(parsed.gridStepPct, 2.5);
});

void test('volume ratio is not interpreted as leverage', () => {
  const result = parseIntent('量比 1.5 倍，杠杆 2 倍', defaults);
  assert.equal(result.minVolumeRatio, 1.5);
  assert.equal(result.leverage, 2);
  assert.equal(parseIntent('量比 1.5 倍', defaults).leverage, defaults.leverage);
});

void test('later protection advances only at discrete three-point thresholds', () => {
  for (const [move, locked, next] of [[10.9, 5, 11], [11, 8, 14], [12, 8, 14], [14, 11, 17], [17, 14, 20]]) {
    for (const side of ['LONG', 'SHORT'] as const) {
      const mark = 100 * (1 + (side === 'LONG' ? move : -move) / 100);
      const state = calculateStop(side, 100, mark);
      near(state.stopReturnPct, locked);
      assert.equal(state.nextTriggerPct, next);
    }
  }
});

void test('stop sandbox preserves protection and never silently reopens', () => {
  for (const side of ['LONG', 'SHORT'] as const) {
    let state = startPaper(side, 100);
    state = advancePaper(state, 5);
    state = advancePaper(state, 8);
    state = advancePaper(state, 7);
    near(state.stop.stopReturnPct, 5);
    state = advancePaper(state, 4);
    assert.equal(state.status, 'STOP_TRIGGERED');
    assert.equal(advancePaper(state, 12), state);
    near(state.exitReference!, side === 'LONG' ? 104 : 96);
  }
});

void test('initial gap through stop exits at observation, not a guaranteed trigger fill', () => {
  const state = advancePaper(startPaper('LONG', 100), -12);
  assert.equal(state.status, 'STOP_TRIGGERED');
  assert.equal(state.exitReference, 88);
  assert.equal(state.stop.stopPrice, 93);
});

void test('invalid inputs fail before changing state', () => {
  for (const accountEquity of [0, -1, NaN, Infinity]) assert.throws(() => calculateRisk({ ...defaults, accountEquity }, 100));
  assert.throws(() => calculateRisk({ ...defaults, riskPct: 10.01 }, 100));
  assert.throws(() => calculateRisk({ ...defaults, leverage: 4 }, 100));
  assert.throws(() => calculateStop('LONG', 0, 100));
  assert.throws(() => advancePaper(startPaper('LONG', 100), NaN));
});

void test('synthetic scenarios cover long, short, range and rejection at every interval', () => {
  for (const interval of ['15m', '1h', '4h'] as const) {
    assert.deepEqual(new Set(demoMarkets({ ...defaults, interval }).map((row) => row.side)), new Set(['LONG', 'SHORT', 'RANGE', 'NO_TRADE']));
  }
});

void test('unfinished candle is ignored, not used as a breakout', () => {
  const market = demoMarkets(defaults)[0];
  const last = market.candles.at(-1)!;
  const openBar = { ...last, openTime: last.openTime + 3_600_000, closeTime: last.closeTime + 3_600_000, high: last.high * 10, close: last.close * 10, volume: last.volume * 100 };
  const result = evaluateMarket({ ...market, candles: [...market.candles, openBar] }, defaults, demoTime);
  assert.equal(result.side, market.side);
  assert.equal(result.ema20, market.ema20);
  assert.equal(result.volumeRatio, market.volumeRatio);
  assert.equal(result.candles.length, market.candles.length);
});

void test('stale, discontinuous or invalid data is vetoed', () => {
  const market = demoMarkets(defaults)[0];
  assert.equal(evaluateMarket(market, defaults, demoTime + 7_200_000).side, 'NO_TRADE');
  assert.equal(evaluateMarket({ ...market, candles: market.candles.filter((_, index) => index !== 10) }, defaults, demoTime).side, 'NO_TRADE');
  assert.equal(evaluateMarket({ ...market, fundingRate: NaN }, defaults, demoTime).side, 'NO_TRADE');
  assert.equal(evaluateMarket({ ...market, spreadBps: -1 }, defaults, demoTime).side, 'NO_TRADE');
  assert.equal(evaluateMarket({ ...market, candles: market.candles.map((bar) => ({ ...bar, volume: 0 })) }, defaults, demoTime).side, 'NO_TRADE');
});

void test('plan refuses failed rules, stale source and unachievable grid spacing', () => {
  const markets = demoMarkets(defaults);
  assert.throws(() => stageCandidate(markets.find((row) => row.side === 'NO_TRADE')!, defaults, 'SYNTHETIC', demoTime, demoTime, false));
  assert.throws(() => stageCandidate(markets[0], defaults, 'BINANCE_PUBLIC_FUTURES_REST', demoTime, demoTime + 121_000, false));
  assert.throws(() => stageCandidate(markets[0], defaults, 'SYNTHETIC', demoTime, demoTime, true));
  const range = markets.find((row) => row.side === 'RANGE')!;
  assert.equal(calculateGrid(range, 10), null);
  assert.throws(() => stageCandidate(range, { ...defaults, gridStepPct: 10 }, 'SYNTHETIC', demoTime, demoTime, false));
});

void test('grid uses all possible fills and hard stop in its own risk sizing', () => {
  const candidate = demoMarkets(defaults).find((row) => row.side === 'RANGE')!;
  const plan = stageCandidate(candidate, defaults, 'SYNTHETIC', demoTime, demoTime, false);
  assert.equal(plan.kind, 'LONG_GRID_PLAN');
  assert.ok(plan.orders && plan.grid);
  const actual = plan.orders.reduce((sum, order) => sum + order.quantity * (order.limitPrice - plan.grid!.lowerHardStop) + order.quantity * order.limitPrice * .002, 0);
  near(actual, plan.estimatedLossAtStopWithReserve!);
  assert.ok(actual <= defaults.accountEquity * defaults.riskPct / 100 + 1e-8);
  assert.equal(plan.status, 'DRAFT_ONLY');
});

const rawEvidence = () => ({ schema: 'trendlock.market/v1', transport: 'SYNTHETIC', collectedAt: demoTime, tools: [], markets: demoMarkets(defaults) });
void test('import recomputes classification and strips unrelated fields', () => {
  const raw = rawEvidence();
  raw.markets[0] = { ...raw.markets[0], side: 'NO_TRADE', score: 999 };
  Object.assign(raw.markets[0], { accountSecret: 'do-not-export' });
  const result = importEvidence(raw);
  assert.notEqual(result.rows[0].score, 999);
  assert.notEqual(result.rows[0].side, 'NO_TRADE');
  assert.equal('accountSecret' in result.rows[0], false);
  assert.equal(result.agentOs.verified, false);
});

void test('import rejects malformed trace and duplicate symbols; MCP assertion stays unverified', () => {
  const raw = rawEvidence();
  assert.throws(() => importEvidence({ ...raw, tools: [null] }));
  assert.throws(() => importEvidence({ ...raw, transport: 'MCP' }));
  assert.throws(() => importEvidence({ ...raw, markets: [raw.markets[0], raw.markets[0]] }));
  const result = importEvidence({ ...raw, transport: 'MCP', tools: [{ name: 'example_tool', status: 'SUCCESS', symbols: [raw.markets[0].symbol] }] });
  assert.equal(result.source, 'IMPORTED_MCP');
  assert.equal(result.agentOs.verified, false);
});

void test('trend paper autopilot advances protection and closes without reopening', () => {
  const candidate = demoMarkets(defaults).find((row) => row.side === 'LONG')!;
  const entry = candidate.price;
  let state = startAutopilot(candidate, defaults, 1_000);
  assert.equal(state.kind, 'TREND');
  state = applyAutopilotTick(state, entry * 1.052, 2_000);
  assert.equal(state.kind, 'TREND');
  near(state.paper.stop.stopReturnPct, 2);
  state = applyAutopilotTick(state, entry * 1.083, 3_000);
  assert.equal(state.kind, 'TREND');
  near(state.paper.stop.stopReturnPct, 5);
  state = applyAutopilotTick(state, entry * 1.049, 4_000);
  assert.equal(state.status, 'STOPPED_OUT');
  const closed = applyAutopilotTick(state, entry * 1.2, 5_000);
  assert.equal(closed, state);
  assert.equal(unrealizedPnl(state), 0);
});

void test('short paper autopilot uses underlying price movement, not leveraged ROE', () => {
  const candidate = demoMarkets(defaults).find((row) => row.side === 'SHORT')!;
  let state = startAutopilot(candidate, defaults, 1_000);
  state = applyAutopilotTick(state, candidate.price * .95, 2_000);
  assert.equal(state.kind, 'TREND');
  near(state.paper.stop.stopReturnPct, 2);
  assert.ok(unrealizedPnl(state) > 0);
});

void test('paper autopilot preserves a configured initial stop distance', () => {
  const candidate = demoMarkets(defaults).find((row) => row.side === 'LONG')!;
  let state = startAutopilot(candidate, { ...defaults, initialStopPct: 6 }, 1_000);
  assert.equal(state.kind, 'TREND');
  near(state.paper.stop.stopReturnPct, -6);
  state = applyAutopilotTick(state, candidate.price * 1.02, 2_000);
  assert.equal(state.kind, 'TREND');
  near(state.paper.stop.stopReturnPct, -6);
});

void test('grid paper autopilot fills a crossed level, sells the rebound and tracks pnl', () => {
  const candidate = demoMarkets(defaults).find((row) => row.side === 'RANGE')!;
  let state = startAutopilot(candidate, defaults, 1_000);
  assert.equal(state.kind, 'GRID');
  const lot = state.lots.filter((item) => item.status === 'WAITING_BUY').sort((a, b) => b.buyPrice - a.buyPrice)[0];
  state = applyAutopilotTick(state, lot.buyPrice * .999, 2_000);
  assert.equal(state.kind, 'GRID');
  assert.ok(state.lots.some((item) => item.status === 'OPEN'));
  state = applyAutopilotTick(state, lot.sellPrice * 1.001, 3_000);
  assert.equal(state.kind, 'GRID');
  assert.ok(state.realizedPnl > 0);
});

void test('paper autopilot halts on stale ticks, refresh recovery or explicit stop', () => {
  const candidate = demoMarkets(defaults).find((row) => row.side === 'LONG')!;
  const started = startAutopilot(candidate, defaults, 1_000);
  assert.equal(applyAutopilotTick(started, candidate.price, 32_000).status, 'HALTED');
  assert.equal(recoverAutopilot(started, 2_000).status, 'HALTED');
  assert.equal(stopAutopilot(started, 2_000).status, 'STOPPED_BY_USER');
  assert.ok(nextDemoPrice(started) > candidate.price);
});

void test('supervisor queues a stop replacement but never applies it before confirmation', () => {
  let state = startSupervisor({ symbol: 'solusdt', side: 'LONG', entryPrice: 100, quantity: 2, currentStopPrice: 90 }, 1_000);
  state = observeSupervisor(state, 105, 2_000);
  assert.equal(state.status, 'WAITING_CONFIRMATION');
  assert.equal(state.currentStopPrice, 90);
  assert.equal(state.pendingAction?.requestedTriggerPrice, 102);
  const prompt = buildMcpReplacementPrompt(state);
  assert.match(prompt, /不要立即执行/);
  assert.match(prompt, /先创建更紧的新保护单/);
  state = recordStopReplacement(state, 102, 3_000);
  assert.equal(state.status, 'MONITORING');
  assert.equal(state.currentStopPrice, 102);
});

void test('supervisor keeps the old server stop active while confirmation is pending', () => {
  let state = startSupervisor({ symbol: 'ETHUSDT', side: 'SHORT', positionSide: 'SHORT', entryPrice: 100, quantity: 1, currentStopPrice: 110 }, 1_000);
  state = observeSupervisor(state, 95, 2_000);
  assert.equal(state.pendingAction?.requestedTriggerPrice, 98);
  state = observeSupervisor(state, 97, 3_000);
  assert.equal(state.status, 'WAITING_CONFIRMATION');
  assert.equal(state.currentStopPrice, 110);
  assert.equal(state.pendingAction?.requestedTriggerPrice, 98);
  assert.equal(state.events.length, 2);
});

void test('supervisor discards a pending replacement if price crosses it before confirmation', () => {
  let state = startSupervisor({ symbol: 'ETHUSDT', side: 'LONG', entryPrice: 100, quantity: 1, currentStopPrice: 90 }, 1_000);
  state = observeSupervisor(state, 105, 2_000);
  assert.equal(state.pendingAction?.requestedTriggerPrice, 102);
  state = observeSupervisor(state, 101, 3_000);
  assert.equal(state.status, 'RECONCILIATION_REQUIRED');
  assert.equal(state.pendingAction, null);
  assert.equal(state.currentStopPrice, 90);
});

void test('crossing the recorded server stop forces account reconciliation', () => {
  let state = startSupervisor({ symbol: 'SOLUSDT', side: 'LONG', entryPrice: 100, quantity: 2, currentStopPrice: 90 }, 1_000);
  state = observeSupervisor(state, 89, 2_000);
  assert.equal(state.status, 'RECONCILIATION_REQUIRED');
  assert.equal(reconcileSupervisor(state, { quantity: 0, markPrice: 89 }, 3_000).status, 'CLOSED');
});

void test('refresh recovery halts supervisor instead of silently resuming', () => {
  const state = startSupervisor({ symbol: 'SOLUSDT', side: 'LONG', entryPrice: 100, quantity: 2, currentStopPrice: 90 }, 1_000);
  const recovered = recoverSupervisor(state, 2_000);
  assert.equal(recovered.status, 'HALTED');
  assert.match(recovered.events.at(-1)!, /重新读取账户对账/);
});
