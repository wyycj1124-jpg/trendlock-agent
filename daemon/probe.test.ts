import assert from 'node:assert/strict';
import test from 'node:test';
import { DryRunGateway } from './dry-run.ts';
import { runTestnetProbe, TESTNET_PROBE_ACK } from './probe.ts';
import type { ExchangeGateway } from './types.ts';

function fakeTestnet() {
  const exchange = new DryRunGateway(5_000);
  exchange.seedMark('ETHUSDT', 3_000);
  Object.defineProperty(exchange, 'mode', { value: 'TESTNET' });
  return exchange as unknown as ExchangeGateway;
}

void test('testnet probe opens, protects, tightens and leaves a clean account', async () => {
  const exchange = fakeTestnet();
  const result = await runTestnetProbe(exchange, {
    acknowledgement: TESTNET_PROBE_ACK,
  });
  assert.equal(result.mode, 'TESTNET');
  assert.equal(result.symbol, 'ETHUSDT');
  assert.equal(result.closed, true);
  assert.equal(result.clean, true);
  assert.ok(result.initialStop < result.tighterStop);
  assert.equal((await exchange.getPositions()).length, 0);
  assert.equal((await exchange.getOpenProtectiveStops('ETHUSDT')).length, 0);
});

void test('testnet probe refuses dry-run and missing acknowledgement', async () => {
  const dryRun = new DryRunGateway(5_000);
  await assert.rejects(
    runTestnetProbe(dryRun, { acknowledgement: TESTNET_PROBE_ACK }),
    /只能在 TESTNET/,
  );
  await assert.rejects(runTestnetProbe(fakeTestnet()), /探针被锁定/);
});
