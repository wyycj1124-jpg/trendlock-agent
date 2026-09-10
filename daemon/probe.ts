import { randomUUID } from 'node:crypto';
import { ceilToStep, quantizeStop } from './math.ts';
import type {
  ExchangeGateway,
  ExchangePosition,
  ProtectiveOrder,
} from './types.ts';

export const TESTNET_PROBE_ACK = 'I_ACCEPT_TESTNET_ORDER_PROBE';

type ProbeOptions = {
  acknowledgement?: string;
  symbol?: string;
  notional?: number;
  leverage?: number;
};

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function probeId(symbol: string, kind: 'E' | 'S' | 'T' | 'X') {
  return `TLP${Date.now().toString(36)}${kind}${symbol.slice(0, 8)}${randomUUID().replaceAll('-', '').slice(0, 6)}`.slice(
    0,
    36,
  );
}

async function findProbePosition(
  exchange: ExchangeGateway,
  symbol: string,
  positionSide: 'BOTH' | 'LONG',
) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const position = (await exchange.getPositions(symbol)).find(
      (item) => item.side === 'LONG' && item.positionSide === positionSide,
    );
    if (position) return position;
    await delay(300);
  }
  return undefined;
}

async function cleanup(
  exchange: ExchangeGateway,
  symbol: string,
  positionSide: 'BOTH' | 'LONG',
) {
  const errors: string[] = [];
  let position = await findProbePosition(exchange, symbol, positionSide);
  if (position) {
    try {
      await exchange.emergencyClose(position, probeId(symbol, 'X'));
    } catch (error) {
      errors.push(
        `平仓失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
  }
  position = await findProbePosition(exchange, symbol, positionSide);
  if (position) {
    errors.push('测试仓位仍存在；为保留保护，程序不会撤销服务器止损');
    return errors;
  }
  try {
    const stops = await exchange.getOpenProtectiveStops(symbol);
    for (const stop of stops.filter((item) =>
      item.clientAlgoId.startsWith('TLP'),
    )) {
      await exchange.cancelProtectiveStop(stop);
    }
  } catch (error) {
    errors.push(
      `清理测试止损失败：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }
  return errors;
}

export async function runTestnetProbe(
  exchange: ExchangeGateway,
  options: ProbeOptions = {},
) {
  if (exchange.mode !== 'TESTNET') {
    throw new Error('测试闭环探针只能在 TESTNET 模式运行');
  }
  if (options.acknowledgement !== TESTNET_PROBE_ACK) {
    throw new Error(
      `测试闭环探针被锁定；设置 TRENDLOCK_TESTNET_PROBE_ACK=${TESTNET_PROBE_ACK}`,
    );
  }
  const symbol = (options.symbol ?? 'ETHUSDT').toUpperCase();
  const requestedNotional = options.notional ?? 25;
  const leverage = options.leverage ?? 3;
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) throw new Error('探针交易对无效');
  if (
    !Number.isFinite(requestedNotional) ||
    requestedNotional < 5 ||
    requestedNotional > 50
  ) {
    throw new Error('探针名义价值必须在 5–50 USDT 之间');
  }
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 3) {
    throw new Error('探针杠杆必须为 1–3 倍整数');
  }

  const before = await exchange.getAccountSnapshot();
  if (!before.canTrade) throw new Error('测试账户当前不可交易');
  if (
    before.positions.length ||
    before.normalOpenOrders.length ||
    before.algoOpenOrders.length
  ) {
    throw new Error('测试账户必须无持仓、无普通挂单且无 Algo 单');
  }
  const rules = await exchange.getSymbolRules(symbol);
  if (rules.status !== 'TRADING') throw new Error(`${symbol} 当前不可交易`);
  const mark = await exchange.getMarkPrice(symbol);
  const targetNotional = Math.max(requestedNotional, rules.minNotional * 1.1);
  const quantity = ceilToStep(
    Math.max(targetNotional / mark.price, rules.minQuantity),
    rules.stepSize,
  );
  const actualNotional = quantity * mark.price;
  if (
    quantity > rules.maxQuantity ||
    actualNotional < rules.minNotional ||
    actualNotional > 50 ||
    actualNotional / leverage > before.availableBalance * 0.1
  ) {
    throw new Error('量化后的探针仓位超出 50 USDT 或账户安全边界');
  }

  const positionSide = before.dualSidePosition ? 'LONG' : 'BOTH';
  let initialProtection: ProtectiveOrder | undefined;
  let tighterProtection: ProtectiveOrder | undefined;
  let position: ExchangePosition | undefined;
  try {
    await exchange.setIsolatedMargin(symbol);
    await exchange.setLeverage(symbol, leverage);
    const fill = await exchange.placeMarketEntry({
      symbol,
      side: 'LONG',
      positionSide,
      quantity,
      clientOrderId: probeId(symbol, 'E'),
    });
    position = await findProbePosition(exchange, symbol, positionSide);
    if (!position) throw new Error('市场单提交后无法读回测试仓位');
    if (
      position.marginType.toUpperCase() !== 'ISOLATED' ||
      position.leverage !== leverage
    ) {
      throw new Error('测试仓位不是预期的逐仓或杠杆配置');
    }

    const initialTrigger = quantizeStop(
      position.entryPrice * 0.93,
      rules.tickSize,
      'LONG',
    );
    if (position.markPrice <= initialTrigger) {
      throw new Error('价格已越过初始测试止损，不创建过期保护');
    }
    initialProtection = await exchange.placeProtectiveStop({
      symbol,
      side: 'LONG',
      positionSide,
      triggerPrice: initialTrigger,
      clientAlgoId: probeId(symbol, 'S'),
    });

    position = await findProbePosition(exchange, symbol, positionSide);
    if (!position) throw new Error('挂初始止损后测试仓位意外消失');
    const tighterTrigger = quantizeStop(
      position.entryPrice * 0.95,
      rules.tickSize,
      'LONG',
    );
    if (position.markPrice <= tighterTrigger) {
      throw new Error('价格已越过收紧测试线，保留初始止损并停止改单测试');
    }
    tighterProtection = await exchange.placeProtectiveStop({
      symbol,
      side: 'LONG',
      positionSide,
      triggerPrice: tighterTrigger,
      clientAlgoId: probeId(symbol, 'T'),
    });
    const bothStops = await exchange.getOpenProtectiveStops(symbol);
    if (
      !bothStops.some(
        (item) => item.clientAlgoId === initialProtection?.clientAlgoId,
      ) ||
      !bothStops.some(
        (item) => item.clientAlgoId === tighterProtection?.clientAlgoId,
      )
    ) {
      throw new Error('新旧保护未同时读回，拒绝撤销旧保护');
    }
    await exchange.cancelProtectiveStop(initialProtection);
    const afterReplacement = await exchange.getOpenProtectiveStops(symbol);
    if (
      afterReplacement.some(
        (item) => item.clientAlgoId === initialProtection?.clientAlgoId,
      ) ||
      !afterReplacement.some(
        (item) => item.clientAlgoId === tighterProtection?.clientAlgoId,
      )
    ) {
      throw new Error('先建后撤的最终保护状态不一致');
    }

    await exchange.emergencyClose(position, probeId(symbol, 'X'));
    const cleanupErrors = await cleanup(exchange, symbol, positionSide);
    if (cleanupErrors.length) throw new Error(cleanupErrors.join('；'));
    const finalPositions = await exchange.getPositions(symbol);
    const finalStops = await exchange.getOpenProtectiveStops(symbol);
    if (
      finalPositions.some((item) => item.positionSide === positionSide) ||
      finalStops.some((item) => item.clientAlgoId.startsWith('TLP'))
    ) {
      throw new Error('探针结束后仍有测试持仓或保护单');
    }
    return {
      mode: exchange.mode,
      symbol,
      side: 'LONG' as const,
      positionSide,
      requestedNotional,
      actualNotional,
      quantity,
      entryPrice: fill.entryPrice,
      initialStop: initialProtection.triggerPrice,
      tighterStop: tighterProtection.triggerPrice,
      closed: true,
      clean: true,
    };
  } catch (error) {
    const cleanupErrors = await cleanup(exchange, symbol, positionSide);
    const detail = error instanceof Error ? error.message : '未知错误';
    throw new Error(
      cleanupErrors.length
        ? `TESTNET 探针失败：${detail}；清理异常：${cleanupErrors.join('；')}`
        : `TESTNET 探针失败且已完成清理：${detail}`,
    );
  }
}
