import { createHmac } from 'node:crypto';
import { decimalPlaces, formatDecimal } from './math.ts';
import type {
  AccountSnapshot,
  EntryFill,
  EntryRequest,
  ExchangeGateway,
  ExchangePosition,
  NormalOpenOrder,
  ProtectiveOrder,
  RuntimeConfig,
  StopRequest,
  SymbolRules,
} from './types.ts';

type Method = 'GET' | 'POST' | 'DELETE';
type Params = Record<string, string | number | boolean | undefined>;

export class BinanceApiError extends Error {
  readonly status: number;
  readonly code?: number;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = 'BinanceApiError';
    this.status = status;
    this.code = code;
  }
}

const number = (value: unknown, field: string, allowZero = false) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`币安字段 ${field} 无效`);
  }
  return parsed;
};

const string = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !value)
    throw new Error(`币安字段 ${field} 无效`);
  return value;
};

const positionSide = (value: unknown): 'BOTH' | 'LONG' | 'SHORT' => {
  if (value === 'BOTH' || value === 'LONG' || value === 'SHORT') return value;
  throw new Error('币安 positionSide 无效');
};

export class BinanceFuturesGateway implements ExchangeGateway {
  readonly mode;
  private readonly baseUrl;
  private readonly apiKey;
  private readonly secretKey;
  private clockOffsetMs = 0;
  private lastClockSyncAt = 0;
  private clockSyncPromise: Promise<void> | undefined;

  constructor(config: RuntimeConfig) {
    if (config.mode === 'DRY_RUN')
      throw new Error('DRY_RUN 应使用模拟交易网关');
    if (!config.apiKey || !config.secretKey)
      throw new Error('缺少币安 API 凭据');
    this.mode = config.mode;
    this.baseUrl = config.restBaseUrl;
    this.apiKey = config.apiKey;
    this.secretKey = config.secretKey;
  }

  private async request<T>(
    method: Method,
    path: string,
    params: Params = {},
    signed = false,
    retryTimestamp = true,
  ): Promise<T> {
    if (signed && Date.now() - this.lastClockSyncAt > 300_000)
      await this.ensureClockFresh();
    const values = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) values.set(key, String(value));
    }
    if (signed) {
      values.set('timestamp', String(Date.now() + this.clockOffsetMs));
      values.set('recvWindow', '15000');
      values.set(
        'signature',
        createHmac('sha256', this.secretKey)
          .update(values.toString())
          .digest('hex'),
      );
    }
    const queryMethod = method === 'GET' || method === 'DELETE';
    const url = `${this.baseUrl}${path}${queryMethod && values.size ? `?${values.toString()}` : ''}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal: AbortSignal.timeout(12_000),
        headers: {
          Accept: 'application/json',
          ...(signed ? { 'X-MBX-APIKEY': this.apiKey } : {}),
          ...(!queryMethod
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        ...(!queryMethod && values.size ? { body: values.toString() } : {}),
      });
    } catch (error) {
      throw new BinanceApiError(
        `币安 ${method} ${path} 网络请求失败：${error instanceof Error ? error.message : '未知错误'}`,
        0,
      );
    }
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { msg: raw.slice(0, 240) };
    }
    if (!response.ok) {
      const data = payload as { code?: unknown; msg?: unknown };
      const code = Number.isFinite(Number(data.code))
        ? Number(data.code)
        : undefined;
      if (signed && code === -1021 && retryTimestamp) {
        await this.ensureClockFresh(true);
        return this.request(method, path, params, true, false);
      }
      const message =
        response.status === 451
          ? '币安限制当前网络地区访问（HTTP 451）；请遵守平台所在地规则，程序不会尝试绕过'
          : typeof data.msg === 'string'
            ? data.msg
            : `Binance Futures HTTP ${response.status}`;
      throw new BinanceApiError(
        `币安 ${method} ${path}${code === undefined ? '' : ` (code ${code})`}：${message}`,
        response.status,
        code,
      );
    }
    return payload as T;
  }

  private async ensureClockFresh(force = false) {
    if (!force && Date.now() - this.lastClockSyncAt <= 300_000) return;
    if (!this.clockSyncPromise) {
      const pending = this.syncClock();
      this.clockSyncPromise = pending;
      const clear = () => {
        if (this.clockSyncPromise === pending)
          this.clockSyncPromise = undefined;
      };
      void pending.then(clear, clear);
    }
    await this.clockSyncPromise;
  }

  private async syncClock() {
    const payload = await this.request<{ serverTime: number }>(
      'GET',
      '/fapi/v1/time',
    );
    const finished = Date.now();
    if (!Number.isFinite(payload.serverTime))
      throw new Error('币安服务器时间无效');
    // Keep signed timestamps conservatively behind the last observed server time.
    // Using the RTT midpoint can put a request >1s into the future on a slow link.
    this.clockOffsetMs = payload.serverTime - finished;
    this.lastClockSyncAt = finished;
  }

  async getServerTime() {
    await this.syncClock();
    return Date.now() + this.clockOffsetMs;
  }

  private parsePosition(
    row: Record<string, unknown>,
    configuration?: Record<string, unknown>,
  ): ExchangePosition | null {
    const signedQuantity = Number(row.positionAmt);
    if (!Number.isFinite(signedQuantity) || signedQuantity === 0) return null;
    const ps = positionSide(row.positionSide);
    const side =
      ps === 'SHORT' || (ps === 'BOTH' && signedQuantity < 0)
        ? 'SHORT'
        : 'LONG';
    return {
      symbol: string(row.symbol, 'symbol'),
      positionSide: ps,
      side,
      signedQuantity,
      quantity: Math.abs(signedQuantity),
      entryPrice: number(row.entryPrice, 'entryPrice'),
      markPrice: number(row.markPrice, 'markPrice'),
      unrealizedPnl: Number(row.unRealizedProfit ?? row.unrealizedProfit ?? 0),
      leverage: number(configuration?.leverage, 'leverage'),
      marginType: string(configuration?.marginType, 'marginType'),
    };
  }

  private configurationMap(rows: Array<Record<string, unknown>>) {
    if (!Array.isArray(rows)) throw new Error('币安交易对配置返回结构无效');
    return new Map(
      rows.map((row) => [string(row.symbol, 'symbolConfig.symbol'), row]),
    );
  }

  private parseProtective(
    row: Record<string, unknown>,
  ): ProtectiveOrder | null {
    const orderType = row.orderType ?? row.type;
    if (orderType !== 'STOP_MARKET') return null;
    if (row.workingType !== 'MARK_PRICE' || row.closePosition !== true)
      return null;
    const side = row.side;
    if (side !== 'BUY' && side !== 'SELL')
      throw new Error('币安保护单 side 无效');
    return {
      symbol: string(row.symbol, 'symbol'),
      algoId: String(row.algoId),
      clientAlgoId: string(row.clientAlgoId, 'clientAlgoId'),
      side,
      positionSide: positionSide(row.positionSide),
      type: 'STOP_MARKET',
      triggerPrice: number(row.triggerPrice, 'triggerPrice'),
      workingType: 'MARK_PRICE',
      closePosition: true,
      status: string(row.algoStatus ?? row.status, 'algoStatus'),
    };
  }

  async getPositions(symbolFilter?: string) {
    const [rows, configurations] = await Promise.all([
      this.request<Array<Record<string, unknown>>>(
        'GET',
        '/fapi/v3/positionRisk',
        { symbol: symbolFilter },
        true,
      ),
      this.request<Array<Record<string, unknown>>>(
        'GET',
        '/fapi/v1/symbolConfig',
        { symbol: symbolFilter },
        true,
      ),
    ]);
    if (!Array.isArray(rows)) throw new Error('币安持仓返回结构无效');
    const configurationBySymbol = this.configurationMap(configurations);
    return rows
      .map((row) =>
        this.parsePosition(row, configurationBySymbol.get(String(row.symbol))),
      )
      .filter((row): row is ExchangePosition => row !== null);
  }

  async getOpenProtectiveStops(symbolFilter: string) {
    const rows = await this.request<Array<Record<string, unknown>>>(
      'GET',
      '/fapi/v1/openAlgoOrders',
      {
        symbol: symbolFilter,
        algoType: 'CONDITIONAL',
      },
      true,
    );
    if (!Array.isArray(rows)) throw new Error('币安条件单返回结构无效');
    return rows
      .map((row) => this.parseProtective(row))
      .filter((row): row is ProtectiveOrder => row !== null);
  }

  async getAccountSnapshot(): Promise<AccountSnapshot> {
    await this.syncClock();
    const [
      balances,
      positions,
      configurations,
      openOrders,
      algoOrders,
      account,
    ] = await Promise.all([
      this.request<Array<Record<string, unknown>>>(
        'GET',
        '/fapi/v3/balance',
        {},
        true,
      ),
      this.request<Array<Record<string, unknown>>>(
        'GET',
        '/fapi/v3/positionRisk',
        {},
        true,
      ),
      this.request<Array<Record<string, unknown>>>(
        'GET',
        '/fapi/v1/symbolConfig',
        {},
        true,
      ),
      this.request<Array<Record<string, unknown>>>(
        'GET',
        '/fapi/v1/openOrders',
        {},
        true,
      ),
      this.request<Array<Record<string, unknown>>>(
        'GET',
        '/fapi/v1/openAlgoOrders',
        { algoType: 'CONDITIONAL' },
        true,
      ),
      this.request<Record<string, unknown>>(
        'GET',
        '/fapi/v1/accountConfig',
        {},
        true,
      ),
    ]);
    const usdt = balances.find((item) => item.asset === 'USDT');
    if (!usdt) throw new Error('币安 U 本位账户没有返回 USDT 余额');
    const configurationBySymbol = this.configurationMap(configurations);
    const parsedPositions = positions
      .map((row) =>
        this.parsePosition(row, configurationBySymbol.get(String(row.symbol))),
      )
      .filter((row): row is ExchangePosition => row !== null);
    const parsedOpenOrders: NormalOpenOrder[] = openOrders.map((row) => {
      const side = row.side;
      if (side !== 'BUY' && side !== 'SELL')
        throw new Error('币安订单 side 无效');
      return {
        symbol: string(row.symbol, 'symbol'),
        orderId: String(row.orderId),
        clientOrderId: string(row.clientOrderId, 'clientOrderId'),
        side,
        positionSide: positionSide(row.positionSide),
        type: string(row.type, 'type'),
        status: string(row.status, 'status'),
        reduceOnly: row.reduceOnly === true,
      };
    });
    const parsedAlgo = algoOrders
      .map((row) => this.parseProtective(row))
      .filter((row): row is ProtectiveOrder => row !== null);
    const walletBalance = number(usdt.balance, 'USDT balance', true);
    const equity =
      walletBalance +
      parsedPositions.reduce(
        (sum, position) => sum + position.unrealizedPnl,
        0,
      );
    return {
      serverTime: Date.now() + this.clockOffsetMs,
      canTrade: account.canTrade === true,
      dualSidePosition: account.dualSidePosition === true,
      walletBalance,
      equity,
      availableBalance: number(
        usdt.availableBalance,
        'USDT availableBalance',
        true,
      ),
      positions: parsedPositions,
      normalOpenOrders: parsedOpenOrders,
      algoOpenOrders: parsedAlgo,
    };
  }

  async getMarkPrice(symbolValue: string) {
    const row = await this.request<Record<string, unknown>>(
      'GET',
      '/fapi/v1/premiumIndex',
      { symbol: symbolValue },
    );
    return {
      price: number(row.markPrice, 'markPrice'),
      time: number(row.time, 'time'),
    };
  }

  async getSymbolRules(symbolValue: string): Promise<SymbolRules> {
    const payload = await this.request<{
      symbols: Array<Record<string, unknown>>;
    }>('GET', '/fapi/v1/exchangeInfo', { symbol: symbolValue });
    const row = payload.symbols?.find((item) => item.symbol === symbolValue);
    if (!row || !Array.isArray(row.filters))
      throw new Error(`未取得 ${symbolValue} 交易规则`);
    const filters = row.filters as Array<Record<string, unknown>>;
    const price = filters.find((item) => item.filterType === 'PRICE_FILTER');
    const lot =
      filters.find((item) => item.filterType === 'MARKET_LOT_SIZE') ??
      filters.find((item) => item.filterType === 'LOT_SIZE');
    const notional =
      filters.find((item) => item.filterType === 'MIN_NOTIONAL') ??
      filters.find((item) => item.filterType === 'NOTIONAL');
    if (!price || !lot) throw new Error(`${symbolValue} 缺少价格或数量过滤器`);
    return {
      symbol: symbolValue,
      tickSize: number(price.tickSize, 'tickSize'),
      stepSize: number(lot.stepSize, 'stepSize'),
      minQuantity: number(lot.minQty, 'minQty'),
      maxQuantity: number(lot.maxQty, 'maxQty'),
      minNotional: number(
        notional?.notional ?? notional?.minNotional ?? 5,
        'minNotional',
      ),
      status: string(row.status, 'status'),
    };
  }

  async setIsolatedMargin(symbolValue: string) {
    try {
      await this.request(
        'POST',
        '/fapi/v1/marginType',
        { symbol: symbolValue, marginType: 'ISOLATED' },
        true,
      );
    } catch (error) {
      if (!(error instanceof BinanceApiError) || error.code !== -4046)
        throw error;
    }
  }

  async setLeverage(symbolValue: string, leverage: number) {
    const response = await this.request<Record<string, unknown>>(
      'POST',
      '/fapi/v1/leverage',
      {
        symbol: symbolValue,
        leverage,
      },
      true,
    );
    if (Number(response.leverage) !== leverage)
      throw new Error('币安返回的杠杆与请求不一致');
  }

  async placeMarketEntry(request: EntryRequest): Promise<EntryFill> {
    const rules = await this.getSymbolRules(request.symbol);
    const response = await this.request<Record<string, unknown>>(
      'POST',
      '/fapi/v1/order',
      {
        symbol: request.symbol,
        side: request.side === 'LONG' ? 'BUY' : 'SELL',
        positionSide: request.positionSide,
        type: 'MARKET',
        quantity: formatDecimal(
          request.quantity,
          decimalPlaces(rules.stepSize),
        ),
        newClientOrderId: request.clientOrderId,
        newOrderRespType: 'RESULT',
      },
      true,
    );
    for (let attempt = 0; attempt < 6; attempt++) {
      const match = (await this.getPositions(request.symbol)).find(
        (position) =>
          position.positionSide === request.positionSide &&
          position.side === request.side,
      );
      if (match) {
        return {
          symbol: request.symbol,
          side: request.side,
          positionSide: request.positionSide,
          quantity: match.quantity,
          entryPrice: match.entryPrice,
          orderId: String(response.orderId),
          clientOrderId: string(
            response.clientOrderId ?? request.clientOrderId,
            'clientOrderId',
          ),
        };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    }
    throw new Error('市场单已提交但未能读回真实持仓；必须立即对账');
  }

  async placeProtectiveStop(request: StopRequest) {
    const rules = await this.getSymbolRules(request.symbol);
    const response = await this.request<Record<string, unknown>>(
      'POST',
      '/fapi/v1/algoOrder',
      {
        algoType: 'CONDITIONAL',
        symbol: request.symbol,
        side: request.side === 'LONG' ? 'SELL' : 'BUY',
        positionSide: request.positionSide,
        type: 'STOP_MARKET',
        triggerPrice: formatDecimal(
          request.triggerPrice,
          decimalPlaces(rules.tickSize),
        ),
        workingType: 'MARK_PRICE',
        closePosition: true,
        clientAlgoId: request.clientAlgoId,
        newOrderRespType: 'RESULT',
      },
      true,
    );
    const parsed = this.parseProtective(response);
    if (!parsed) throw new Error('币安未返回可验证的全仓位 STOP_MARKET 保护单');
    const verified = (await this.getOpenProtectiveStops(request.symbol)).find(
      (order) =>
        order.clientAlgoId === request.clientAlgoId && order.status === 'NEW',
    );
    if (!verified) throw new Error('新保护单未出现在币安条件挂单中');
    return verified;
  }

  async cancelProtectiveStop(order: ProtectiveOrder) {
    await this.request(
      'DELETE',
      '/fapi/v1/algoOrder',
      { algoId: order.algoId },
      true,
    );
  }

  async emergencyClose(position: ExchangePosition, clientOrderId: string) {
    const rules = await this.getSymbolRules(position.symbol);
    await this.request(
      'POST',
      '/fapi/v1/order',
      {
        symbol: position.symbol,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        positionSide: position.positionSide,
        type: 'MARKET',
        quantity: formatDecimal(
          position.quantity,
          decimalPlaces(rules.stepSize),
        ),
        ...(position.positionSide === 'BOTH' ? { reduceOnly: true } : {}),
        newClientOrderId: clientOrderId,
        newOrderRespType: 'RESULT',
      },
      true,
    );
  }
}
