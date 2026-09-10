import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEvent, AuditLevel, DaemonState, RunMode } from './types.ts';

export function localDayKey(at = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function initialState(mode: RunMode, now = Date.now()): DaemonState {
  return {
    schema: 'trendlock.daemon/v1',
    mode,
    status: 'RUNNING',
    haltReason: null,
    createdAt: now,
    updatedAt: now,
    lastTickAt: null,
    lastScanCandleClose: null,
    lastScanAt: null,
    lastScanAttemptAt: null,
    dayKey: localDayKey(now),
    dayStartEquity: null,
    lastEquity: null,
    consecutiveLosses: 0,
    consecutiveReadFailures: 0,
    managed: {},
    pendingAction: null,
  };
}

export class StateStore {
  readonly root: string;
  readonly statePath: string;
  readonly auditPath: string;
  readonly reportsDir: string;

  constructor(root: string) {
    this.root = root;
    this.statePath = join(root, 'state.json');
    this.auditPath = join(root, 'audit.jsonl');
    this.reportsDir = join(root, 'reports');
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await mkdir(this.reportsDir, { recursive: true, mode: 0o700 });
  }

  async load(mode: RunMode): Promise<DaemonState> {
    await this.init();
    try {
      const parsed = JSON.parse(
        await readFile(this.statePath, 'utf8'),
      ) as DaemonState;
      if (parsed.schema !== 'trendlock.daemon/v1')
        throw new Error('状态文件版本不兼容');
      if (parsed.mode !== mode)
        throw new Error(`状态属于 ${parsed.mode}，不能用 ${mode} 打开`);
      return {
        ...initialState(mode, parsed.createdAt),
        ...parsed,
        managed: parsed.managed ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const state = initialState(mode);
      await this.save(state);
      return state;
    }
  }

  async save(state: DaemonState) {
    await this.init();
    const next = { ...state, updatedAt: Date.now() };
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.statePath);
    await chmod(this.statePath, 0o600);
    return next;
  }

  async audit(
    level: AuditLevel,
    type: string,
    message: string,
    input: {
      symbol?: string;
      data?: Record<string, unknown>;
      at?: number;
    } = {},
  ) {
    await this.init();
    const event: AuditEvent = {
      schema: 'trendlock.audit/v1',
      id: randomUUID(),
      at: input.at ?? Date.now(),
      level,
      type,
      message,
      ...(input.symbol ? { symbol: input.symbol } : {}),
      ...(input.data ? { data: input.data } : {}),
    };
    await appendFile(this.auditPath, `${JSON.stringify(event)}\n`, {
      mode: 0o600,
    });
    await chmod(this.auditPath, 0o600);
    return event;
  }

  async events(dayKey?: string): Promise<AuditEvent[]> {
    try {
      const raw = await readFile(this.auditPath, 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEvent)
        .filter((event) => !dayKey || localDayKey(event.at) === dayKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeReport(dayKey: string, markdown: string) {
    await this.init();
    const path = join(this.reportsDir, `${dayKey}.md`);
    await writeFile(path, markdown, { mode: 0o600 });
    return path;
  }
}
