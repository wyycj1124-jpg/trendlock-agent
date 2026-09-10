import { randomUUID } from 'node:crypto';
import {
  calculateRisk,
  calculateStop,
  type Candidate,
  type Rules,
} from '../lib/engine.ts';
import { floorToStep, quantizeStop } from './math.ts';
import { buildDailyReport } from './report.ts';
import { StateStore, localDayKey } from './store.ts';
import type {
  AccountSnapshot,
  DaemonState,
  ExchangeGateway,
  ExchangePosition,
  ManagedPosition,
  PendingAction,
  ProtectiveOrder,
  RuntimeConfig,
  TrendSide,
} from './types.ts';

const safeError = (error: unknown) =>
  error instanceof Error ? error.message : '未知错误';
const isTrend = (side: Candidate['side']): side is TrendSide =>
  side === 'LONG' || side === 'SHORT';
const crossed = (side: TrendSide, mark: number, stop: number) =>
  side === 'LONG' ? mark <= stop : mark >= stop;
const tighter = (side: TrendSide, next: number, current: number) =>
  side === 'LONG'
    ? next > current + current * 1e-10
    : next < current - current * 1e-10;

function clientId(symbol: string, kind: 'E' | 'S' | 'X') {
  return `TL${Date.now().toString(36)}${kind}${symbol.slice(0, 8)}${randomUUID().replaceAll('-', '').slice(0, 6)}`.slice(
    0,
    36,
  );
}

function riskRules(config: RuntimeConfig, equity: number): Rules {
  return {
    interval: '1h',
    poolSize: config.poolSize,
    minTurnover: config.minTurnover,
    maxSpreadBps: config.maxSpreadBps,
    minVolumeRatio: config.minVolumeRatio,
    accountEquity: equity,
    riskPct: config.perSlotRiskPct,
    leverage: config.leverage,
    initialStopPct: config.initialStopPct,
    gridStepPct: 3,
  };
}

function findPosition(
  snapshot: AccountSnapshot,
  symbol: string,
  side: TrendSide,
  positionSide: 'BOTH' | TrendSide,
) {
  return snapshot.positions.find(
    (position) =>
      position.symbol === symbol &&
      position.side === side &&
      position.positionSide === positionSide,
  );
}

export class TrendLockCore {
  readonly config: RuntimeConfig;
  readonly exchange: ExchangeGateway;
  readonly store: StateStore;
  state: DaemonState;

  private constructor(
    config: RuntimeConfig,
    exchange: ExchangeGateway,
    store: StateStore,
    state: DaemonState,
  ) {
    this.config = config;
    this.exchange = exchange;
    this.store = store;
    this.state = state;
  }

  static async create(config: RuntimeConfig, exchange: ExchangeGateway) {
    const store = new StateStore(config.stateDir);
    const state = await store.load(config.mode);
    const core = new TrendLockCore(config, exchange, store, state);
    await core.reconcileStartup();
    return core;
  }

  private async save() {
    this.state = await this.store.save(this.state);
  }

  private async halt(reason: string, symbol?: string) {
    this.state.status = 'HALTED';
    this.state.haltReason = reason;
    await this.save();
    await this.store.audit('CRITICAL', 'DAEMON_HALTED', reason, { symbol });
  }

  private occupiedSymbols(snapshot: AccountSnapshot) {
    return new Set([
      ...snapshot.positions.map((position) => position.symbol),
      ...snapshot.normalOpenOrders
        .filter((order) => !order.reduceOnly)
        .map((order) => order.symbol),
    ]);
  }

  private async emergencyClose(position: ExchangePosition, reason: string) {
    try {
      await this.exchange.emergencyClose(
        position,
        clientId(position.symbol, 'X'),
      );
      const remaining = (
        await this.exchange.getPositions(position.symbol)
      ).find(
        (item) =>
          item.side === position.side &&
          item.positionSide === position.positionSide,
      );
      if (remaining) throw new Error('紧急平仓后仍读到非零持仓');
      const ownedStops = (
        await this.exchange.getOpenProtectiveStops(position.symbol)
      ).filter((order) => order.clientAlgoId.startsWith('TL'));
      for (const stop of ownedStops)
        await this.exchange.cancelProtectiveStop(stop);
      const residualStops = (
        await this.exchange.getOpenProtectiveStops(position.symbol)
      ).filter((order) => order.clientAlgoId.startsWith('TL'));
      if (residualStops.length)
        throw new Error('紧急平仓后仍有 TrendLock 条件单');
      delete this.state.managed[position.symbol];
      this.state.pendingAction = null;
      await this.save();
      await this.store.audit('CRITICAL', 'EMERGENCY_CLOSE', reason, {
        symbol: position.symbol,
        data: { quantity: position.quantity, side: position.side },
      });
      await this.halt(`${reason}；已提交紧急减仓平仓`, position.symbol);
    } catch (error) {
      await this.halt(
        `${reason}；紧急平仓也失败，必须立即人工对账：${safeError(error)}`,
        position.symbol,
      );
    }
  }

  private async initializeDay(snapshot: AccountSnapshot) {
    const key = localDayKey(snapshot.serverTime);
    if (this.state.dayKey !== key) {
      const previousEvents = await this.store.events(this.state.dayKey);
      const report = buildDailyReport(
        this.state.dayKey,
        this.state,
        previousEvents,
        this.config,
      );
      await this.store.writeReport(this.state.dayKey, report);
      this.state.dayKey = key;
      this.state.dayStartEquity = snapshot.equity;
      this.state.consecutiveLosses = 0;
    }
    if (this.state.dayStartEquity === null)
      this.state.dayStartEquity = snapshot.equity;
    this.state.lastEquity = snapshot.equity;
    const drawdownPct =
      this.state.dayStartEquity > 0
        ? ((this.state.dayStartEquity - snapshot.equity) /
            this.state.dayStartEquity) *
          100
        : 0;
    if (
      drawdownPct >= this.config.maxDailyDrawdownPct &&
      this.state.status !== 'HALTED'
    ) {
      await this.halt(
        `当日权益回撤 ${drawdownPct.toFixed(2)}% 达到熔断阈值 ${this.config.maxDailyDrawdownPct}%`,
      );
    } else {
      await this.save();
    }
  }

  async reconcileStartup() {
    let snapshot: AccountSnapshot;
    try {
      snapshot = await this.exchange.getAccountSnapshot();
    } catch (error) {
      await this.halt(`启动账户读取失败：${safeError(error)}`);
      return;
    }
    await this.initializeDay(snapshot);
    if (!snapshot.canTrade && this.config.mode !== 'DRY_RUN') {
      await this.halt('API Key 没有 U 本位合约交易权限');
      return;
    }

    if (this.state.pendingAction) {
      await this.recoverPending(snapshot, this.state.pendingAction);
      snapshot = await this.exchange.getAccountSnapshot();
    }

    for (const managed of Object.values(this.state.managed)) {
      const position = findPosition(
        snapshot,
        managed.symbol,
        managed.side,
        managed.positionSide,
      );
      if (!position) {
        delete this.state.managed[managed.symbol];
        await this.store.audit(
          'INFO',
          'POSITION_CLOSED',
          '启动对账确认托管仓位已关闭',
          { symbol: managed.symbol },
        );
        continue;
      }
      const protection = snapshot.algoOpenOrders.find(
        (order) => order.clientAlgoId === managed.protection.clientAlgoId,
      );
      if (!protection) {
        await this.emergencyClose(
          position,
          '启动对账发现托管仓位缺少预期服务器保护单',
        );
        return;
      }
      const quantityChanged =
        Math.abs(position.quantity - managed.quantity) >
        Math.max(managed.quantity * 1e-8, 1e-12);
      const entryChanged =
        Math.abs(position.entryPrice - managed.entryPrice) >
        Math.max(managed.entryPrice * 1e-8, 1e-12);
      if (quantityChanged || entryChanged) {
        await this.halt(
          '启动对账发现托管持仓的数量或均价被外部修改；服务器保护保留，需人工核验',
          managed.symbol,
        );
        return;
      }
      managed.markPrice = position.markPrice;
      managed.protection = protection;
      managed.updatedAt = snapshot.serverTime;
    }
    const unknown = snapshot.positions.filter((position) => {
      const managed = this.state.managed[position.symbol];
      return (
        !managed ||
        managed.side !== position.side ||
        managed.positionSide !== position.positionSide
      );
    });
    if (unknown.length) {
      await this.store.audit(
        'WARN',
        'UNKNOWN_POSITIONS',
        '发现非 TrendLock 托管仓位：仅占用槽位，不自动修改',
        {
          data: { symbols: unknown.map((position) => position.symbol) },
        },
      );
    }
    await this.save();
  }

  private async recoverPending(
    snapshot: AccountSnapshot,
    pending: PendingAction,
  ) {
    const position = findPosition(
      snapshot,
      pending.symbol,
      pending.side,
      pending.positionSide,
    );
    if (!position) {
      this.state.pendingAction = null;
      await this.save();
      await this.store.audit(
        'WARN',
        'PENDING_CLEARED',
        '重启后未发现待恢复仓位，已清除开仓意图',
        { symbol: pending.symbol },
      );
      return;
    }
    let protection = snapshot.algoOpenOrders.find(
      (order) => order.clientAlgoId === pending.stopClientAlgoId,
    );
    if (!protection) {
      try {
        const rules = await this.exchange.getSymbolRules(pending.symbol);
        const desired = calculateStop(
          pending.side,
          position.entryPrice,
          position.markPrice,
          position.markPrice,
          undefined,
          this.config.initialStopPct,
          pending.candidate.atrPct,
        );
        const triggerPrice = quantizeStop(
          desired.stopPrice,
          rules.tickSize,
          pending.side,
        );
        if (crossed(pending.side, position.markPrice, triggerPrice)) {
          await this.emergencyClose(position, '待恢复仓位已越过应有保护线');
          return;
        }
        protection = await this.exchange.placeProtectiveStop({
          symbol: pending.symbol,
          side: pending.side,
          positionSide: pending.positionSide,
          triggerPrice,
          clientAlgoId: pending.stopClientAlgoId,
        });
      } catch (error) {
        await this.emergencyClose(
          position,
          `恢复待处理开仓时无法补齐服务器保护：${safeError(error)}`,
        );
        return;
      }
    }
    this.state.managed[pending.symbol] = {
      symbol: pending.symbol,
      side: pending.side,
      positionSide: pending.positionSide,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      extremePrice: position.markPrice,
      markPrice: position.markPrice,
      atrPct: pending.candidate.atrPct,
      scoreAtEntry: pending.candidate.score,
      signalTime: pending.candidate.signalTime,
      entryOrderId: 'RECOVERED',
      entryClientOrderId: pending.entryClientOrderId,
      protection,
      stopStage: 0,
      openedAt: pending.createdAt,
      updatedAt: snapshot.serverTime,
    };
    this.state.pendingAction = null;
    await this.save();
    await this.store.audit(
      'WARN',
      'PENDING_RECOVERED',
      '重启后已恢复仓位并核验服务器保护',
      { symbol: pending.symbol },
    );
  }

  async refreshRisk() {
    const snapshot = await this.exchange.getAccountSnapshot();
    await this.initializeDay(snapshot);
    return snapshot;
  }

  private assertCandidate(candidate: Candidate, observedAt: number) {
    if (!isTrend(candidate.side))
      throw new Error('核心版只自动执行 LONG/SHORT；RANGE 网格仍为失败关闭');
    if (candidate.score < this.config.minScore)
      throw new Error(`评分 ${candidate.score} 低于 ${this.config.minScore}`);
    if (
      !candidate.evidence.length ||
      candidate.evidence.some((item) => !item.pass)
    )
      throw new Error('候选未通过全部硬规则');
    if (Date.now() - observedAt > 120_000 || observedAt - Date.now() > 5_000)
      throw new Error('扫描结果已过期');
    if (
      this.config.allowedSymbols.length &&
      !this.config.allowedSymbols.includes(candidate.symbol)
    ) {
      throw new Error(`${candidate.symbol} 不在允许名单`);
    }
    if (this.state.status !== 'RUNNING')
      throw new Error(`守护进程已熔断：${this.state.haltReason}`);
    if (this.state.pendingAction)
      throw new Error('已有未完成交易动作，禁止并发下单');
  }

  async openCandidate(candidate: Candidate, observedAt = Date.now()) {
    this.assertCandidate(candidate, observedAt);
    const side = candidate.side;
    if (!isTrend(side)) throw new Error('核心版只自动执行 LONG/SHORT');
    const snapshot = await this.refreshRisk();
    if (this.state.status !== 'RUNNING')
      throw new Error(`风险熔断：${this.state.haltReason}`);
    const occupied = this.occupiedSymbols(snapshot);
    if (occupied.size >= this.config.maxSlots) throw new Error('交易槽位已满');
    if (occupied.has(candidate.symbol))
      throw new Error(`${candidate.symbol} 已有持仓或开仓委托`);
    if (!snapshot.canTrade) throw new Error('账户不可交易');

    const mark = await this.exchange.getMarkPrice(candidate.symbol);
    const driftPct = Math.abs(mark.price / candidate.price - 1) * 100;
    if (driftPct > this.config.maxEntryDriftPct) {
      throw new Error(
        `价格相对扫描价偏移 ${driftPct.toFixed(2)}%，超过 ${this.config.maxEntryDriftPct}%`,
      );
    }
    const symbolRules = await this.exchange.getSymbolRules(candidate.symbol);
    if (symbolRules.status !== 'TRADING')
      throw new Error(`${candidate.symbol} 当前不可交易`);
    const sizing = calculateRisk(
      riskRules(this.config, snapshot.equity),
      mark.price,
    );
    const openSlots = Math.max(1, this.config.maxSlots - occupied.size);
    const affordableNotional =
      (snapshot.availableBalance * this.config.leverage * 0.8) / openSlots;
    const notional = Math.min(sizing.notional, affordableNotional);
    const quantity = floorToStep(notional / mark.price, symbolRules.stepSize);
    if (
      quantity < symbolRules.minQuantity ||
      quantity > symbolRules.maxQuantity ||
      quantity * mark.price < symbolRules.minNotional
    ) {
      throw new Error('按风险预算量化后的仓位不满足最小数量/名义价值规则');
    }
    const positionSide = snapshot.dualSidePosition ? side : 'BOTH';
    const entryClientOrderId = clientId(candidate.symbol, 'E');
    const stopClientAlgoId = clientId(candidate.symbol, 'S');
    this.state.pendingAction = {
      kind: 'OPEN_TREND',
      symbol: candidate.symbol,
      side,
      positionSide,
      entryClientOrderId,
      stopClientAlgoId,
      candidate: {
        symbol: candidate.symbol,
        side,
        score: candidate.score,
        price: candidate.price,
        atrPct: candidate.atrPct,
        signalTime: candidate.signalTime,
      },
      step: 'INTENT_SAVED',
      createdAt: Date.now(),
    };
    await this.save();
    await this.store.audit(
      'INFO',
      'ENTRY_INTENT',
      '已持久化开仓意图；尚未提交订单',
      {
        symbol: candidate.symbol,
        data: {
          side,
          quantity,
          score: candidate.score,
          riskBudget: (notional * (this.config.initialStopPct + 0.2)) / 100,
        },
      },
    );

    let entryMayExist = false;
    try {
      await this.exchange.setIsolatedMargin(candidate.symbol);
      await this.exchange.setLeverage(candidate.symbol, this.config.leverage);
      if (!this.state.pendingAction) throw new Error('开仓意图意外丢失');
      this.state.pendingAction.step = 'ENTRY_SUBMITTED';
      await this.save();
      entryMayExist = true;
      const fill = await this.exchange.placeMarketEntry({
        symbol: candidate.symbol,
        side,
        positionSide,
        quantity,
        clientOrderId: entryClientOrderId,
      });
      if (!this.state.pendingAction) throw new Error('开仓提交状态意外丢失');
      this.state.pendingAction.step = 'ENTRY_CONFIRMED';
      await this.save();
      const positions = await this.exchange.getPositions(candidate.symbol);
      const actual = positions.find(
        (position) =>
          position.side === side && position.positionSide === positionSide,
      );
      if (!actual) throw new Error('开仓后读回不到对应持仓');
      const stop = calculateStop(
        side,
        actual.entryPrice,
        actual.markPrice,
        actual.markPrice,
        undefined,
        this.config.initialStopPct,
        candidate.atrPct,
      );
      const triggerPrice = quantizeStop(
        stop.stopPrice,
        symbolRules.tickSize,
        side,
      );
      if (crossed(side, actual.markPrice, triggerPrice))
        throw new Error('真实成交后价格已越过初始保护线');
      if (!this.state.pendingAction) throw new Error('保护提交状态意外丢失');
      this.state.pendingAction.step = 'PROTECTION_SUBMITTED';
      await this.save();
      const protection = await this.exchange.placeProtectiveStop({
        symbol: candidate.symbol,
        side,
        positionSide,
        triggerPrice,
        clientAlgoId: stopClientAlgoId,
      });
      const managed: ManagedPosition = {
        symbol: candidate.symbol,
        side,
        positionSide,
        quantity: actual.quantity,
        entryPrice: actual.entryPrice,
        extremePrice: actual.markPrice,
        markPrice: actual.markPrice,
        atrPct: candidate.atrPct,
        scoreAtEntry: candidate.score,
        signalTime: candidate.signalTime,
        entryOrderId: fill.orderId,
        entryClientOrderId,
        protection,
        stopStage: stop.stage,
        openedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.state.managed[candidate.symbol] = managed;
      this.state.pendingAction = null;
      await this.save();
      await this.store.audit(
        'INFO',
        'POSITION_PROTECTED',
        '真实成交已读回，服务器全仓位保护单已验证',
        {
          symbol: candidate.symbol,
          data: {
            side,
            quantity: actual.quantity,
            entryPrice: actual.entryPrice,
            triggerPrice,
            mode: this.config.mode,
          },
        },
      );
      return managed;
    } catch (error) {
      if (!entryMayExist) {
        this.state.pendingAction = null;
        await this.save();
        await this.store.audit('WARN', 'ENTRY_ABORTED', safeError(error), {
          symbol: candidate.symbol,
        });
        throw error;
      }
      try {
        const actual = (
          await this.exchange.getPositions(candidate.symbol)
        ).find(
          (position) =>
            position.side === side && position.positionSide === positionSide,
        );
        if (actual)
          await this.emergencyClose(
            actual,
            `开仓保护流程失败：${safeError(error)}`,
          );
        else {
          this.state.pendingAction = null;
          await this.save();
          await this.store.audit(
            'WARN',
            'ENTRY_UNCONFIRMED',
            `写操作失败且读回无持仓：${safeError(error)}`,
            { symbol: candidate.symbol },
          );
        }
      } catch (reconcileError) {
        await this.halt(
          `开仓结果不确定且无法对账：${safeError(reconcileError)}`,
          candidate.symbol,
        );
      }
      throw error;
    }
  }

  private async replaceStop(
    managed: ManagedPosition,
    position: ExchangePosition,
    desiredPrice: number,
    stage: ManagedPosition['stopStage'],
  ) {
    const rules = await this.exchange.getSymbolRules(managed.symbol);
    const triggerPrice = quantizeStop(
      desiredPrice,
      rules.tickSize,
      managed.side,
    );
    if (!tighter(managed.side, triggerPrice, managed.protection.triggerPrice))
      return;
    if (crossed(managed.side, position.markPrice, triggerPrice)) {
      await this.emergencyClose(
        position,
        '价格已越过新计算的保护线，禁止补挂过期止损',
      );
      return;
    }
    const previous = managed.protection;
    try {
      await this.exchange.cancelProtectiveStop(previous);
    } catch (error) {
      try {
        const oldStillExists = (
          await this.exchange.getOpenProtectiveStops(managed.symbol)
        ).some((order) => order.algoId === previous.algoId);
        if (oldStillExists) {
          await this.store.audit(
            'WARN',
            'STOP_REPLACE_SKIPPED',
            `旧保护撤销失败但服务器保护仍在，本轮不改单：${safeError(error)}`,
            { symbol: managed.symbol },
          );
          return;
        }
      } catch {
        // The result is uncertain; the emergency close below is fail-closed.
      }
      await this.emergencyClose(
        position,
        `旧保护撤销结果不确定且无法确认保护仍在：${safeError(error)}`,
      );
      return;
    }

    const nextClientAlgoId = clientId(managed.symbol, 'S');
    let next: ProtectiveOrder | undefined;
    try {
      next = await this.exchange.placeProtectiveStop({
        symbol: managed.symbol,
        side: managed.side,
        positionSide: managed.positionSide,
        triggerPrice,
        clientAlgoId: nextClientAlgoId,
      });
    } catch (error) {
      try {
        next = (
          await this.exchange.getOpenProtectiveStops(managed.symbol)
        ).find((order) => order.clientAlgoId === nextClientAlgoId);
      } catch {
        // The emergency close below is safer than assuming protection exists.
      }
      if (!next) {
        await this.emergencyClose(
          position,
          `旧保护已撤销但新保护创建/读回失败：${safeError(error)}`,
        );
        return;
      }
    }
    let verified: ProtectiveOrder | undefined;
    try {
      verified = (
        await this.exchange.getOpenProtectiveStops(managed.symbol)
      ).find((order) => order.clientAlgoId === next.clientAlgoId);
    } catch (error) {
      await this.emergencyClose(
        position,
        `撤旧建新后最终保护读回失败：${safeError(error)}`,
      );
      return;
    }
    if (!verified) {
      await this.emergencyClose(position, '改单后无法再次读回新服务器保护单');
      return;
    }
    managed.protection = verified;
    managed.stopStage = stage;
    managed.updatedAt = Date.now();
    await this.save();
    await this.store.audit(
      'INFO',
      'STOP_REPLACED',
      '按币安单保护限制撤旧后立即建新，服务器保护价已提高',
      {
        symbol: managed.symbol,
        data: {
          previousTriggerPrice: previous.triggerPrice,
          triggerPrice: verified.triggerPrice,
          stage,
        },
      },
    );
  }

  async monitorOnce() {
    if (this.state.status === 'HALTED') return;
    if (!Object.keys(this.state.managed).length) {
      this.state.lastTickAt = Date.now();
      await this.save();
      return;
    }
    let positions: ExchangePosition[];
    try {
      positions = await this.exchange.getPositions();
      this.state.consecutiveReadFailures = 0;
    } catch (error) {
      this.state.consecutiveReadFailures++;
      await this.save();
      await this.store.audit('WARN', 'MONITOR_READ_FAILED', safeError(error), {
        data: { consecutiveFailures: this.state.consecutiveReadFailures },
      });
      if (this.state.consecutiveReadFailures >= 3)
        await this.halt('连续三次无法读取真实持仓；服务器旧止损保留');
      return;
    }

    for (const managed of Object.values(this.state.managed)) {
      if (this.state.haltReason !== null) break;
      const position = positions.find(
        (item) =>
          item.symbol === managed.symbol &&
          item.side === managed.side &&
          item.positionSide === managed.positionSide,
      );
      if (!position) {
        const losingProtection =
          managed.side === 'LONG'
            ? managed.protection.triggerPrice < managed.entryPrice
            : managed.protection.triggerPrice > managed.entryPrice;
        this.state.consecutiveLosses = losingProtection
          ? this.state.consecutiveLosses + 1
          : 0;
        delete this.state.managed[managed.symbol];
        await this.save();
        await this.store.audit(
          'INFO',
          'POSITION_CLOSED',
          '持仓读回为零；释放槽位，等待下一根已收盘 1h K 线重扫',
          {
            symbol: managed.symbol,
            data: { inferredLoss: losingProtection },
          },
        );
        if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
          await this.halt(
            `连续 ${this.state.consecutiveLosses} 次推定亏损退出，停止新开仓`,
          );
        }
        continue;
      }
      const quantityChanged =
        Math.abs(position.quantity - managed.quantity) >
        Math.max(managed.quantity * 1e-8, 1e-12);
      const entryChanged =
        Math.abs(position.entryPrice - managed.entryPrice) >
        Math.max(managed.entryPrice * 1e-8, 1e-12);
      if (quantityChanged || entryChanged) {
        await this.halt(
          '托管持仓的数量或均价被外部修改；停止自动改单，服务器现有保护保留',
          managed.symbol,
        );
        break;
      }
      let openStops: ProtectiveOrder[];
      try {
        openStops = await this.exchange.getOpenProtectiveStops(managed.symbol);
        this.state.consecutiveReadFailures = 0;
      } catch (error) {
        this.state.consecutiveReadFailures++;
        await this.save();
        await this.store.audit(
          'WARN',
          'PROTECTION_READ_FAILED',
          safeError(error),
          {
            symbol: managed.symbol,
            data: { consecutiveFailures: this.state.consecutiveReadFailures },
          },
        );
        if (this.state.consecutiveReadFailures >= 3)
          await this.halt('连续三次无法核验服务器保护单；现有保护不撤销');
        return;
      }
      const active = openStops.find(
        (order) => order.clientAlgoId === managed.protection.clientAlgoId,
      );
      if (!active) {
        await this.emergencyClose(position, '监控发现预期服务器保护单消失');
        break;
      }
      managed.protection = active;
      for (const redundant of openStops.filter(
        (order) =>
          order.clientAlgoId.startsWith('TL') &&
          order.clientAlgoId !== active.clientAlgoId &&
          order.positionSide === active.positionSide &&
          order.side === active.side,
      )) {
        try {
          await this.exchange.cancelProtectiveStop(redundant);
          await this.store.audit(
            'INFO',
            'REDUNDANT_STOP_CANCELED',
            '已清理同一托管仓位的旧保护单',
            { symbol: managed.symbol },
          );
        } catch (error) {
          await this.store.audit(
            'WARN',
            'REDUNDANT_STOP_REMAINS',
            safeError(error),
            { symbol: managed.symbol },
          );
        }
      }
      managed.markPrice = position.markPrice;
      managed.extremePrice =
        managed.side === 'LONG'
          ? Math.max(managed.extremePrice, position.markPrice)
          : Math.min(managed.extremePrice, position.markPrice);
      managed.updatedAt = Date.now();
      const desired = calculateStop(
        managed.side,
        managed.entryPrice,
        position.markPrice,
        managed.extremePrice,
        managed.protection.triggerPrice,
        this.config.initialStopPct,
        managed.atrPct,
      );
      if (
        tighter(
          managed.side,
          desired.stopPrice,
          managed.protection.triggerPrice,
        )
      ) {
        await this.replaceStop(
          managed,
          position,
          desired.stopPrice,
          desired.stage,
        );
      }
    }
    this.state.lastTickAt = Date.now();
    await this.save();
  }

  async scanAndOpen(candidates: Candidate[], observedAt = Date.now()) {
    const signalTimes = candidates
      .map((candidate) => candidate.signalTime)
      .filter(Number.isFinite);
    this.state.lastScanCandleClose = signalTimes.length
      ? Math.max(...signalTimes)
      : this.state.lastScanCandleClose;
    this.state.lastScanAt = observedAt;
    this.state.lastScanAttemptAt = observedAt;
    await this.save();
    if (this.state.status !== 'RUNNING') return [];
    const eligible = candidates
      .filter(
        (candidate) =>
          isTrend(candidate.side) && candidate.score >= this.config.minScore,
      )
      .filter(
        (candidate) =>
          !this.config.allowedSymbols.length ||
          this.config.allowedSymbols.includes(candidate.symbol),
      )
      .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    const opened: ManagedPosition[] = [];
    for (const candidate of eligible) {
      if (opened.length >= this.config.maxSlots) break;
      try {
        opened.push(await this.openCandidate(candidate, observedAt));
      } catch (error) {
        await this.store.audit('WARN', 'CANDIDATE_REJECTED', safeError(error), {
          symbol: candidate.symbol,
          data: { score: candidate.score },
        });
        if (this.state.haltReason !== null) break;
      }
    }
    if (!opened.length) {
      await this.store.audit(
        'INFO',
        'SCAN_NO_ENTRY',
        `本轮没有可安全执行的 ${this.config.minScore}+ 趋势候选`,
      );
    }
    return opened;
  }

  async recordScanAttempt(at = Date.now()) {
    this.state.lastScanAttemptAt = at;
    await this.save();
  }

  async report(dayKey = this.state.dayKey) {
    const events = await this.store.events(dayKey);
    const markdown = buildDailyReport(dayKey, this.state, events, this.config);
    const path = await this.store.writeReport(dayKey, markdown);
    return { path, markdown };
  }
}
