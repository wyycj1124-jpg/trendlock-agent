import { demoMarkets } from '../lib/demo.ts';
import { scanFutures } from '../lib/market.ts';
import type { Candidate, Rules } from '../lib/engine.ts';
import { TrendLockCore } from './core.ts';
import { DryRunGateway } from './dry-run.ts';
import type { ExchangeGateway, RuntimeConfig } from './types.ts';

const HOUR_MS = 3_600_000;
const SCAN_RETRY_MS = 300_000;

const rules = (config: RuntimeConfig): Rules => ({
  interval: '1h',
  poolSize: config.poolSize,
  minTurnover: config.minTurnover,
  maxSpreadBps: config.maxSpreadBps,
  minVolumeRatio: config.minVolumeRatio,
  accountEquity: 50,
  riskPct: config.portfolioRiskPct,
  leverage: config.leverage,
  initialStopPct: config.initialStopPct,
  gridStepPct: 3,
});

function seedDryRun(exchange: ExchangeGateway, candidates: Candidate[]) {
  if (!(exchange instanceof DryRunGateway)) return;
  for (const candidate of candidates)
    exchange.seedMark(candidate.symbol, candidate.price);
}

export async function scanPublic(
  config: RuntimeConfig,
  exchange: ExchangeGateway,
) {
  const result = await scanFutures(rules(config));
  seedDryRun(exchange, result.rows);
  return result;
}

export async function runSyntheticCycle(core: TrendLockCore) {
  const candidates = demoMarkets(rules(core.config));
  seedDryRun(core.exchange, candidates);
  return core.scanAndOpen(candidates, Date.now());
}

export async function runCycle(core: TrendLockCore, forceScan = false) {
  await core.monitorOnce();
  if (core.state.haltReason !== null) return;
  await core.refreshRisk();
  if (core.state.haltReason !== null) return;
  const serverTime = await core.exchange.getServerTime();
  const latestClosedHour = Math.floor(serverTime / HOUR_MS) * HOUR_MS - 1;
  if (
    !forceScan &&
    core.state.lastScanCandleClose !== null &&
    core.state.lastScanCandleClose >= latestClosedHour
  )
    return;
  if (
    !forceScan &&
    core.state.lastScanAttemptAt !== null &&
    Date.now() - core.state.lastScanAttemptAt < SCAN_RETRY_MS
  )
    return;
  await core.recordScanAttempt();
  try {
    const result = await scanPublic(core.config, core.exchange);
    await core.scanAndOpen(result.rows, result.completedAt);
  } catch (error) {
    await core.store.audit(
      'WARN',
      'SCAN_FAILED',
      error instanceof Error ? error.message : '未知扫描错误',
    );
  }
}

export async function runForever(core: TrendLockCore) {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await core.store.audit(
    'INFO',
    'SERVICE_STARTED',
    `本地守护进程启动：${core.config.mode}`,
  );
  let lastRiskRefreshAt = 0;
  while (!stopped) {
    try {
      await core.monitorOnce();
      const now = Date.now();
      if (now - lastRiskRefreshAt >= 60_000) {
        await core.refreshRisk();
        lastRiskRefreshAt = now;
      }
      if (core.state.status === 'RUNNING') {
        const serverTime = await core.exchange.getServerTime();
        const latestClosedHour = Math.floor(serverTime / HOUR_MS) * HOUR_MS - 1;
        const needsScan =
          core.state.lastScanCandleClose === null ||
          core.state.lastScanCandleClose < latestClosedHour;
        const retryReady =
          core.state.lastScanAttemptAt === null ||
          now - core.state.lastScanAttemptAt >= SCAN_RETRY_MS;
        if (needsScan && retryReady) {
          await core.recordScanAttempt(now);
          try {
            const result = await scanPublic(core.config, core.exchange);
            await core.scanAndOpen(result.rows, result.completedAt);
          } catch (error) {
            await core.store.audit(
              'WARN',
              'SCAN_FAILED',
              error instanceof Error ? error.message : '未知扫描错误',
            );
          }
        }
      }
    } catch (error) {
      await core.store.audit(
        'WARN',
        'SERVICE_CYCLE_FAILED',
        error instanceof Error ? error.message : '未知循环错误',
      );
    }
    if (!stopped)
      await new Promise((resolve) => setTimeout(resolve, core.config.pollMs));
  }
  await core.report();
  await core.store.audit(
    'INFO',
    'SERVICE_STOPPED',
    '收到系统停止信号，守护进程已退出；服务器已有保护单不受影响',
  );
}
