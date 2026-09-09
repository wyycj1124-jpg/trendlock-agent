import { defaults } from '../lib/engine.ts';
import { scanFutures } from '../lib/market.ts';
import { buildApprovalQueue } from '../lib/orchestrator.ts';

const accountEquity = Number(process.argv[2]);
if (!Number.isFinite(accountEquity) || accountEquity < 1) {
  throw new Error('Usage: npm run approval:scan -- <account-equity-usdt> [occupied-symbols-csv]');
}

const occupiedSymbols = (process.argv[3] ?? '')
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const rules = { ...defaults, accountEquity };
const scan = await scanFutures(rules);
const queue = buildApprovalQueue({
  candidates: scan.rows,
  rules,
  source: 'BINANCE_PUBLIC_FUTURES_REST',
  asOf: scan.asOf,
  now: scan.completedAt,
  occupiedSymbols,
});

process.stdout.write(`${JSON.stringify({
  ...queue,
  scan: {
    attempted: scan.attempted,
    succeeded: scan.attempted - scan.failed,
    completedAt: scan.completedAt,
  },
}, null, 2)}\n`);
