import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BinanceFuturesGateway } from './binance.ts';
import { loadConfig, publicConfig } from './config.ts';
import { TrendLockCore } from './core.ts';
import { DryRunGateway } from './dry-run.ts';
import { runCycle, runForever, runSyntheticCycle } from './service.ts';
import { StateStore } from './store.ts';
import { runTestnetProbe } from './probe.ts';

const command = process.argv[2] ?? 'doctor';

function exchangeFor(config: ReturnType<typeof loadConfig>) {
  return config.mode === 'DRY_RUN'
    ? new DryRunGateway(50)
    : new BinanceFuturesGateway(config);
}

async function main() {
  if (command === 'smoke') {
    const temporary = await mkdtemp(join(tmpdir(), 'trendlock-smoke-'));
    try {
      const config = loadConfig({
        ...process.env,
        TRENDLOCK_MODE: 'DRY_RUN',
        TRENDLOCK_STATE_DIR: temporary,
      });
      const exchange = new DryRunGateway(50);
      const core = await TrendLockCore.create(config, exchange);
      const opened = await runSyntheticCycle(core);
      for (const position of opened) {
        const favorable =
          position.side === 'LONG'
            ? position.entryPrice * 1.052
            : position.entryPrice * 0.948;
        exchange.setMark(position.symbol, favorable);
      }
      await core.monitorOnce();
      await core.refreshRisk();
      const report = await core.report();
      process.stdout.write(
        `${JSON.stringify({ mode: config.mode, opened: opened.map((position) => position.symbol), status: core.state.status }, null, 2)}\n\n${report.markdown}\n`,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return;
  }

  const config = loadConfig();
  const exchange = exchangeFor(config);
  if (command === 'doctor') {
    const snapshot = await exchange.getAccountSnapshot();
    process.stdout.write(
      `${JSON.stringify(
        {
          config: publicConfig(config),
          account: {
            canTrade: snapshot.canTrade,
            dualSidePosition: snapshot.dualSidePosition,
            walletBalance: snapshot.walletBalance,
            equity: snapshot.equity,
            availableBalance: snapshot.availableBalance,
            positions: snapshot.positions.map((position) => ({
              symbol: position.symbol,
              side: position.side,
              quantity: position.quantity,
              protectedByTrendLock: snapshot.algoOpenOrders.some(
                (order) =>
                  order.symbol === position.symbol &&
                  order.clientAlgoId.startsWith('TL'),
              ),
            })),
            normalOpenOrders: snapshot.normalOpenOrders.length,
            protectiveAlgoOrders: snapshot.algoOpenOrders.length,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === 'probe') {
    const result = await runTestnetProbe(exchange, {
      acknowledgement: process.env.TRENDLOCK_TESTNET_PROBE_ACK,
      symbol: process.env.TRENDLOCK_PROBE_SYMBOL,
      notional:
        process.env.TRENDLOCK_PROBE_NOTIONAL === undefined
          ? undefined
          : Number(process.env.TRENDLOCK_PROBE_NOTIONAL),
      leverage: config.leverage,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'resume') {
    if (process.env.TRENDLOCK_RESUME_ACK !== 'I_HAVE_RECONCILED_ACCOUNT') {
      throw new Error(
        '恢复被锁定；核验真实持仓和保护单后设置 TRENDLOCK_RESUME_ACK=I_HAVE_RECONCILED_ACCOUNT',
      );
    }
    const store = new StateStore(config.stateDir);
    const state = await store.load(config.mode);
    if (state.status !== 'HALTED')
      throw new Error('当前状态不是 HALTED，无需恢复');
    state.status = 'RUNNING';
    state.haltReason = null;
    state.consecutiveReadFailures = 0;
    await store.save(state);
    await store.audit(
      'WARN',
      'MANUAL_RESUME',
      '用户声明已完成账户对账，正在重新运行启动校验',
    );
  }

  const core = await TrendLockCore.create(config, exchange);
  if (command === 'resume') {
    process.stdout.write(
      `恢复校验完成：${core.state.status}${core.state.haltReason ? ` · ${core.state.haltReason}` : ''}\n`,
    );
    return;
  }
  if (command === 'once') {
    await runCycle(core, process.argv.includes('--force-scan'));
    const report = await core.report();
    process.stdout.write(`${report.markdown}\n报告：${report.path}\n`);
    return;
  }
  if (command === 'start') {
    process.stdout.write(
      `TrendLock ${config.mode} 启动；状态目录 ${config.stateDir}\n`,
    );
    await runForever(core);
    return;
  }
  if (command === 'report') {
    const report = await core.report(process.argv[3]);
    process.stdout.write(`${report.markdown}\n报告：${report.path}\n`);
    return;
  }
  throw new Error(
    `未知命令 ${command}；支持 doctor、probe、smoke、once、start、report、resume`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `TrendLock 失败：${error instanceof Error ? error.message : '未知错误'}\n`,
  );
  process.exitCode = 1;
});
