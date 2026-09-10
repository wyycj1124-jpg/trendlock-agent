import type { Candidate } from '../lib/engine.ts';

export type RunMode = 'DRY_RUN' | 'TESTNET' | 'LIVE';
export type TrendSide = 'LONG' | 'SHORT';
export type PositionSide = 'BOTH' | TrendSide;

export type RuntimeConfig = {
  mode: RunMode;
  restBaseUrl: string;
  apiKey?: string;
  secretKey?: string;
  stateDir: string;
  pollMs: number;
  scanInterval: '1h';
  poolSize: number;
  minScore: number;
  maxSlots: number;
  portfolioRiskPct: number;
  perSlotRiskPct: number;
  leverage: number;
  initialStopPct: number;
  maxEntryDriftPct: number;
  maxDailyDrawdownPct: number;
  maxConsecutiveLosses: number;
  minTurnover: number;
  maxSpreadBps: number;
  minVolumeRatio: number;
  allowedSymbols: string[];
};

export type ExchangePosition = {
  symbol: string;
  positionSide: PositionSide;
  side: TrendSide;
  quantity: number;
  signedQuantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  marginType: string;
};

export type NormalOpenOrder = {
  symbol: string;
  orderId: string;
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  positionSide: PositionSide;
  type: string;
  status: string;
  reduceOnly: boolean;
};

export type ProtectiveOrder = {
  symbol: string;
  algoId: string;
  clientAlgoId: string;
  side: 'BUY' | 'SELL';
  positionSide: PositionSide;
  type: 'STOP_MARKET';
  triggerPrice: number;
  workingType: 'MARK_PRICE';
  closePosition: true;
  status: string;
};

export type AccountSnapshot = {
  serverTime: number;
  canTrade: boolean;
  dualSidePosition: boolean;
  walletBalance: number;
  equity: number;
  availableBalance: number;
  positions: ExchangePosition[];
  normalOpenOrders: NormalOpenOrder[];
  algoOpenOrders: ProtectiveOrder[];
};

export type SymbolRules = {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQuantity: number;
  maxQuantity: number;
  minNotional: number;
  status: string;
};

export type EntryRequest = {
  symbol: string;
  side: TrendSide;
  positionSide: PositionSide;
  quantity: number;
  clientOrderId: string;
};

export type EntryFill = {
  symbol: string;
  side: TrendSide;
  positionSide: PositionSide;
  quantity: number;
  entryPrice: number;
  orderId: string;
  clientOrderId: string;
};

export type StopRequest = {
  symbol: string;
  side: TrendSide;
  positionSide: PositionSide;
  triggerPrice: number;
  clientAlgoId: string;
};

export interface ExchangeGateway {
  readonly mode: RunMode;
  getServerTime(): Promise<number>;
  getAccountSnapshot(): Promise<AccountSnapshot>;
  getPositions(symbol?: string): Promise<ExchangePosition[]>;
  getMarkPrice(symbol: string): Promise<{ price: number; time: number }>;
  getSymbolRules(symbol: string): Promise<SymbolRules>;
  setIsolatedMargin(symbol: string): Promise<void>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  placeMarketEntry(request: EntryRequest): Promise<EntryFill>;
  placeProtectiveStop(request: StopRequest): Promise<ProtectiveOrder>;
  getOpenProtectiveStops(symbol: string): Promise<ProtectiveOrder[]>;
  cancelProtectiveStop(order: ProtectiveOrder): Promise<void>;
  emergencyClose(
    position: ExchangePosition,
    clientOrderId: string,
  ): Promise<void>;
}

export type ManagedPosition = {
  symbol: string;
  side: TrendSide;
  positionSide: PositionSide;
  quantity: number;
  entryPrice: number;
  extremePrice: number;
  markPrice: number;
  atrPct: number;
  scoreAtEntry: number;
  signalTime: number;
  entryOrderId: string;
  entryClientOrderId: string;
  protection: ProtectiveOrder;
  stopStage: 0 | 1 | 2 | 3 | 4;
  openedAt: number;
  updatedAt: number;
};

export type PendingAction = {
  kind: 'OPEN_TREND';
  symbol: string;
  side: TrendSide;
  positionSide: PositionSide;
  entryClientOrderId: string;
  stopClientAlgoId: string;
  candidate: Pick<
    Candidate,
    'symbol' | 'side' | 'score' | 'price' | 'atrPct' | 'signalTime'
  >;
  step:
    | 'INTENT_SAVED'
    | 'ENTRY_SUBMITTED'
    | 'ENTRY_CONFIRMED'
    | 'PROTECTION_SUBMITTED';
  createdAt: number;
};

export type DaemonState = {
  schema: 'trendlock.daemon/v1';
  mode: RunMode;
  status: 'RUNNING' | 'HALTED';
  haltReason: string | null;
  createdAt: number;
  updatedAt: number;
  lastTickAt: number | null;
  lastScanCandleClose: number | null;
  lastScanAt: number | null;
  lastScanAttemptAt: number | null;
  dayKey: string;
  dayStartEquity: number | null;
  lastEquity: number | null;
  consecutiveLosses: number;
  consecutiveReadFailures: number;
  managed: Record<string, ManagedPosition>;
  pendingAction: PendingAction | null;
};

export type AuditLevel = 'INFO' | 'WARN' | 'CRITICAL';
export type AuditEvent = {
  schema: 'trendlock.audit/v1';
  id: string;
  at: number;
  level: AuditLevel;
  type: string;
  message: string;
  symbol?: string;
  data?: Record<string, unknown>;
};
