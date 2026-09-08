import { readFile } from 'node:fs/promises';
import { importEvidence } from '../lib/evidence.ts';
import { defaults } from '../lib/engine.ts';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/evaluate-evidence.ts evidence.json [rules.json]');
const rules = process.argv[3] ? { ...defaults, ...JSON.parse(await readFile(process.argv[3], 'utf8')) } : defaults;
const result = importEvidence(JSON.parse(await readFile(path, 'utf8')), rules);
process.stdout.write(JSON.stringify({ schema: 'trendlock.analysis/v1', rules, ...result }, null, 2) + '\n');
