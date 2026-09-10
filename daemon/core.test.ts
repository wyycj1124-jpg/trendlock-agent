import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoMarkets } from '../lib/demo.ts';
import { defaults } from '../lib/engine.ts';
import { loadConfig } from './config.ts';
import { TrendLockCore } from './core.ts';
import { DryRunGateway } from './dry-run.ts';
import { floorToStep, quantizeStop } from './math.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'trendlock-test-'));
  const config = loadConfig({
    TRENDLOCK_MODE: 'DRY_RUN',
    TRENDLOCK_STATE_DIR: directory,
  });
  const exchange = new DryRunGateway(50);
  const core = await TrendLockCore.create(config, exchange);
  const candidates = demoMarkets({ ...defaults, accountEquity: 50 });
  for (const candidate of candidates)
    exchange.seedMark(candidate.symbol, candidate.price);
  return { directory, config, exchange, core, candidates };
}

void test('config remains dry-run by default and live requires an exact acknowledgement', () => {
  assert.equal(loadConfig({}).mode, 'DRY_RUN');
  assert.throws(
    () =>
      loadConfig({
        TRENDLOCK_MODE: 'LIVE',
        BINANCE_API_KEY: 'key',
        BINANCE_SECRET_KEY: 'secret',
      }),
    /LIVE 被锁定/,
  );
  assert.throws(
    () => loadConfig({ TRENDLOCK_PER_SLOT_RISK_PCT: '6' }),
    /组合风险/,
  );
});

void test('config rejects credentials containing non-ASCII prompt text', () => {
  assert.throws(
    () =>
      loadConfig({
        TRENDLOCK_MODE: 'TESTNET',
        BINANCE_API_KEY: 'key：copied-prompt',
        BINANCE_SECRET_KEY: 'secret',
      }),
    /BINANCE_API_KEY 只能包含可打印 ASCII/,
  );
});

void test('exchange quantization rounds quantity down and stops away from market', () => {
  assert.equal(floorToStep(1.239, 0.01), 1.23);
  assert.equal(quantizeStop(93.007, 0.01, 'LONG'), 93);
  assert.equal(quantizeStop(106.993, 0.01, 'SHORT'), 107);
});

void test('dry-run opens only trend candidates with verified server-style protection and raises stop', async () => {
  const context = await fixture();
  try {
    const trend = context.candidates.find(
      (candidate) => candidate.side === 'LONG',
    )!;
    const managed = await context.core.openCandidate(trend, Date.now());
    assert.equal(Object.keys(context.core.state.managed).length, 1);
    assert.equal(managed.protection.closePosition, true);
    assert.equal(managed.protection.workingType, 'MARK_PRICE');
    const oldStop = managed.protection.triggerPrice;
    context.exchange.setMark(trend.symbol, managed.entryPrice * 1.052);
    await context.core.monitorOnce();
    const updated = context.core.state.managed[trend.symbol];
    assert.ok(updated.protection.triggerPrice > oldStop);
    const lockedPct =
      (updated.protection.triggerPrice / updated.entryPrice - 1) * 100;
    assert.ok(lockedPct <= 2 && lockedPct > 1.99, `量化后锁盈为 ${lockedPct}%`);
    assert.equal(
      (await context.exchange.getOpenProtectiveStops(trend.symbol)).length,
      1,
    );
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

void test('protection failure emergency-closes the new position and halts', async () => {
  const context = await fixture();
  try {
    const source = context.candidates.find(
      (candidate) => candidate.side === 'SHORT',
    )!;
    const trend = { ...source, score: 91 };
    context.exchange.failNextProtection = true;
    await assert.rejects(
      () => context.core.openCandidate(trend, Date.now()),
      /保护单失败/,
    );
    assert.equal((await context.exchange.getPositions()).length, 0);
    assert.equal(context.core.state.status, 'HALTED');
    assert.match(context.core.state.haltReason!, /紧急减仓平仓/);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

void test('restart never adopts unrelated positions and closes a managed naked position', async () => {
  const context = await fixture();
  try {
    const trend = context.candidates.find(
      (candidate) => candidate.side === 'LONG',
    )!;
    const managed = await context.core.openCandidate(trend, Date.now());
    context.exchange.stops.delete(managed.protection.algoId);
    const restarted = await TrendLockCore.create(
      context.config,
      context.exchange,
    );
    assert.equal(restarted.state.status, 'HALTED');
    assert.equal((await context.exchange.getPositions()).length, 0);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

void test('external position-size changes halt automation but preserve the existing server stop', async () => {
  const context = await fixture();
  try {
    const trend = context.candidates.find(
      (candidate) => candidate.side === 'LONG',
    )!;
    const managed = await context.core.openCandidate(trend, Date.now());
    const actual = context.exchange.positions.get(trend.symbol)!;
    actual.quantity *= 2;
    await context.core.monitorOnce();
    assert.equal(context.core.state.status, 'HALTED');
    assert.equal(
      (await context.exchange.getOpenProtectiveStops(trend.symbol)).some(
        (order) => order.algoId === managed.protection.algoId,
      ),
      true,
    );
    assert.equal((await context.exchange.getPositions(trend.symbol)).length, 1);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

void test('range candidate fails closed in the autonomous core', async () => {
  const context = await fixture();
  try {
    const range = context.candidates.find(
      (candidate) => candidate.side === 'RANGE',
    )!;
    await assert.rejects(
      () => context.core.openCandidate(range, Date.now()),
      /RANGE 网格仍为失败关闭/,
    );
    assert.equal((await context.exchange.getPositions()).length, 0);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});
