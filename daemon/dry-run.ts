import type {
  AccountSnapshot,
  EntryFill,
  EntryRequest,
  ExchangeGateway,
  ExchangePosition,
  ProtectiveOrder,
  StopRequest,
  SymbolRules,
} from './types.ts';

export class DryRunGateway implements ExchangeGateway {
  readonly mode = 'DRY_RUN' as const;
  readonly positions = new Map<string, ExchangePosition>();
  readonly stops = new Map<string, ProtectiveOrder>();
  readonly marks = new Map<string, number>();
  walletBalance: number;
  failNextProtection = false;
  private orderSequence = 0;

  constructor(equity = 50) {
    this.walletBalance = equity;
  }

  seedMark(symbol: string, price: number) {
    this.marks.set(symbol, price);
  }

  setMark(symbol: string, price: number) {
    this.marks.set(symbol, price);
    const position = this.positions.get(symbol);
    const stop = [...this.stops.values()].find(
      (order) => order.symbol === symbol && order.status === 'NEW',
    );
    if (
      position &&
      stop &&
      (position.side === 'LONG'
        ? price <= stop.triggerPrice
        : price >= stop.triggerPrice)
    ) {
      this.walletBalance +=
        position.quantity *
        (position.side === 'LONG'
          ? price - position.entryPrice
          : position.entryPrice - price);
      this.positions.delete(symbol);
      this.stops.delete(stop.algoId);
    }
  }

  async getServerTime() {
    return Date.now();
  }

  async getAccountSnapshot(): Promise<AccountSnapshot> {
    const positions = await this.getPositions();
    const unrealized = positions.reduce(
      (sum, position) => sum + position.unrealizedPnl,
      0,
    );
    const margin = positions.reduce(
      (sum, position) =>
        sum + (position.quantity * position.entryPrice) / position.leverage,
      0,
    );
    return {
      serverTime: Date.now(),
      canTrade: true,
      dualSidePosition: false,
      walletBalance: this.walletBalance,
      equity: this.walletBalance + unrealized,
      availableBalance: Math.max(0, this.walletBalance - margin),
      positions,
      normalOpenOrders: [],
      algoOpenOrders: [...this.stops.values()].filter(
        (order) => order.status === 'NEW',
      ),
    };
  }

  async getPositions(symbol?: string) {
    return [...this.positions.values()]
      .filter((position) => !symbol || position.symbol === symbol)
      .map((position) => {
        const markPrice = this.marks.get(position.symbol) ?? position.markPrice;
        return {
          ...position,
          markPrice,
          unrealizedPnl:
            position.quantity *
            (position.side === 'LONG'
              ? markPrice - position.entryPrice
              : position.entryPrice - markPrice),
        };
      });
  }

  async getMarkPrice(symbol: string) {
    const price = this.marks.get(symbol);
    if (!price) throw new Error(`DRY_RUN 没有 ${symbol} 模拟价格`);
    return { price, time: Date.now() };
  }

  async getSymbolRules(symbol: string): Promise<SymbolRules> {
    const mark = this.marks.get(symbol) ?? 1;
    return {
      symbol,
      tickSize: mark >= 100 ? 0.01 : mark >= 1 ? 0.001 : 0.000001,
      stepSize: mark >= 100 ? 0.001 : mark >= 1 ? 0.01 : 1,
      minQuantity: mark >= 100 ? 0.001 : mark >= 1 ? 0.01 : 1,
      maxQuantity: 1_000_000,
      minNotional: 5,
      status: 'TRADING',
    };
  }

  async setIsolatedMargin() {}
  async setLeverage() {}

  async placeMarketEntry(request: EntryRequest): Promise<EntryFill> {
    if (this.positions.has(request.symbol))
      throw new Error('DRY_RUN 禁止同币重复开仓');
    const price = this.marks.get(request.symbol);
    if (!price) throw new Error('DRY_RUN 缺少模拟成交价');
    const orderId = String(++this.orderSequence);
    this.positions.set(request.symbol, {
      symbol: request.symbol,
      side: request.side,
      positionSide: request.positionSide,
      quantity: request.quantity,
      signedQuantity:
        request.side === 'LONG' ? request.quantity : -request.quantity,
      entryPrice: price,
      markPrice: price,
      unrealizedPnl: 0,
      leverage: 3,
      marginType: 'isolated',
    });
    return {
      symbol: request.symbol,
      side: request.side,
      positionSide: request.positionSide,
      quantity: request.quantity,
      entryPrice: price,
      orderId,
      clientOrderId: request.clientOrderId,
    };
  }

  async placeProtectiveStop(request: StopRequest) {
    if (this.failNextProtection) {
      this.failNextProtection = false;
      throw new Error('DRY_RUN 注入的保护单失败');
    }
    const order: ProtectiveOrder = {
      symbol: request.symbol,
      algoId: String(++this.orderSequence),
      clientAlgoId: request.clientAlgoId,
      side: request.side === 'LONG' ? 'SELL' : 'BUY',
      positionSide: request.positionSide,
      type: 'STOP_MARKET',
      triggerPrice: request.triggerPrice,
      workingType: 'MARK_PRICE',
      closePosition: true,
      status: 'NEW',
    };
    this.stops.set(order.algoId, order);
    return order;
  }

  async getOpenProtectiveStops(symbol: string) {
    return [...this.stops.values()].filter(
      (order) => order.symbol === symbol && order.status === 'NEW',
    );
  }

  async cancelProtectiveStop(order: ProtectiveOrder) {
    if (!this.stops.delete(order.algoId))
      throw new Error('DRY_RUN 旧保护单不存在');
  }

  async emergencyClose(position: ExchangePosition) {
    const mark = this.marks.get(position.symbol) ?? position.markPrice;
    this.walletBalance +=
      position.quantity *
      (position.side === 'LONG'
        ? mark - position.entryPrice
        : position.entryPrice - mark);
    this.positions.delete(position.symbol);
    for (const [id, order] of this.stops)
      if (order.symbol === position.symbol) this.stops.delete(id);
  }
}
