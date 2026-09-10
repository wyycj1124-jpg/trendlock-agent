import { resolve } from 'node:path';
import type { RunMode, RuntimeConfig } from './types.ts';

const LIVE_ACK = 'I_ACCEPT_AUTONOMOUS_FUTURES_RISK';
const URLS: Record<RunMode, string> = {
  DRY_RUN: 'https://fapi.binance.com',
  TESTNET: 'https://demo-fapi.binance.com',
  LIVE: 'https://fapi.binance.com',
};

type Environment = Readonly<Record<string, string | undefined>>;

function numberEnv(
  env: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} 必须在 ${min}–${max} 之间`);
  }
  return value;
}

function integerEnv(
  env: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = numberEnv(env, name, fallback, min, max);
  if (!Number.isInteger(value)) throw new Error(`${name} 必须为整数`);
  return value;
}

function symbolsEnv(value: string | undefined) {
  if (!value?.trim()) return [];
  const symbols = [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (symbols.some((symbol) => !/^[A-Z0-9]{5,24}$/.test(symbol))) {
    throw new Error('TRENDLOCK_ALLOWED_SYMBOLS 包含无效交易对');
  }
  return symbols;
}

export function loadConfig(env: Environment = process.env): RuntimeConfig {
  const mode = (env.TRENDLOCK_MODE ?? 'DRY_RUN').toUpperCase() as RunMode;
  if (!['DRY_RUN', 'TESTNET', 'LIVE'].includes(mode)) {
    throw new Error('TRENDLOCK_MODE 仅支持 DRY_RUN、TESTNET、LIVE');
  }
  const maxSlots = integerEnv(env, 'TRENDLOCK_MAX_SLOTS', 2, 1, 2);
  const portfolioRiskPct = numberEnv(
    env,
    'TRENDLOCK_PORTFOLIO_RISK_PCT',
    10,
    0.1,
    10,
  );
  const perSlotRiskPct = numberEnv(
    env,
    'TRENDLOCK_PER_SLOT_RISK_PCT',
    5,
    0.05,
    10,
  );
  if (perSlotRiskPct * maxSlots > portfolioRiskPct + 1e-9) {
    throw new Error('单槽风险 × 槽位数不能超过组合风险上限');
  }
  const apiKey = env.BINANCE_API_KEY?.trim();
  const secretKey = env.BINANCE_SECRET_KEY?.trim();
  if (mode !== 'DRY_RUN' && (!apiKey || !secretKey)) {
    throw new Error(
      `${mode} 模式需要本机 BINANCE_API_KEY 与 BINANCE_SECRET_KEY`,
    );
  }
  if (mode === 'LIVE' && env.TRENDLOCK_LIVE_ACK !== LIVE_ACK) {
    throw new Error(
      `LIVE 被锁定；确认承担自动合约风险后，本机设置 TRENDLOCK_LIVE_ACK=${LIVE_ACK}`,
    );
  }
  return {
    mode,
    restBaseUrl: URLS[mode],
    apiKey,
    secretKey,
    stateDir: resolve(env.TRENDLOCK_STATE_DIR?.trim() || '.trendlock'),
    pollMs: integerEnv(env, 'TRENDLOCK_POLL_MS', 5_000, 1_000, 60_000),
    scanInterval: '1h',
    poolSize: integerEnv(env, 'TRENDLOCK_POOL_SIZE', 36, 8, 80),
    minScore: integerEnv(env, 'TRENDLOCK_MIN_SCORE', 90, 0, 99),
    maxSlots,
    portfolioRiskPct,
    perSlotRiskPct,
    leverage: integerEnv(env, 'TRENDLOCK_LEVERAGE', 3, 1, 3),
    initialStopPct: numberEnv(env, 'TRENDLOCK_INITIAL_STOP_PCT', 7, 1, 30),
    maxEntryDriftPct: numberEnv(
      env,
      'TRENDLOCK_MAX_ENTRY_DRIFT_PCT',
      1,
      0.05,
      5,
    ),
    maxDailyDrawdownPct: numberEnv(
      env,
      'TRENDLOCK_MAX_DAILY_DRAWDOWN_PCT',
      10,
      0.1,
      30,
    ),
    maxConsecutiveLosses: integerEnv(
      env,
      'TRENDLOCK_MAX_CONSECUTIVE_LOSSES',
      2,
      1,
      10,
    ),
    minTurnover: numberEnv(env, 'TRENDLOCK_MIN_TURNOVER', 20_000_000, 0, 1e12),
    maxSpreadBps: numberEnv(env, 'TRENDLOCK_MAX_SPREAD_BPS', 8, 0.1, 100),
    minVolumeRatio: numberEnv(env, 'TRENDLOCK_MIN_VOLUME_RATIO', 1.2, 0.2, 10),
    allowedSymbols: symbolsEnv(env.TRENDLOCK_ALLOWED_SYMBOLS),
  };
}

export function publicConfig(config: RuntimeConfig) {
  const { apiKey: _apiKey, secretKey: _secretKey, ...safe } = config;
  return safe;
}

export { LIVE_ACK };
