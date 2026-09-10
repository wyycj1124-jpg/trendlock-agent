import type { AuditEvent, DaemonState, RuntimeConfig } from './types.ts';

const fixed = (value: number | null, digits = 4) =>
  value === null ? 'n/a' : value.toFixed(digits);

export function buildDailyReport(
  dayKey: string,
  state: DaemonState,
  events: AuditEvent[],
  config: RuntimeConfig,
) {
  const opened = events.filter((event) => event.type === 'POSITION_PROTECTED');
  const closed = events.filter((event) => event.type === 'POSITION_CLOSED');
  const replacements = events.filter((event) => event.type === 'STOP_REPLACED');
  const critical = events.filter((event) => event.level === 'CRITICAL');
  const pnl =
    state.dayStartEquity !== null && state.lastEquity !== null
      ? state.lastEquity - state.dayStartEquity
      : null;
  const lines = [
    `# TrendLock 日报 · ${dayKey}`,
    '',
    `- 模式：${state.mode}`,
    `- 状态：${state.status}${state.haltReason ? `（${state.haltReason}）` : ''}`,
    `- 日初权益：${fixed(state.dayStartEquity)} USDT`,
    `- 最新权益：${fixed(state.lastEquity)} USDT`,
    `- 权益变化：${fixed(pnl)} USDT`,
    `- 新开并完成服务器保护：${opened.length}`,
    `- 关闭：${closed.length}`,
    `- 止损提高：${replacements.length}`,
    `- 严重事件：${critical.length}`,
    `- 当前托管仓位：${Object.keys(state.managed).length}/${config.maxSlots}`,
    '',
    '## 当前托管仓位',
    '',
  ];
  const managed = Object.values(state.managed);
  if (!managed.length) lines.push('无。');
  for (const position of managed) {
    lines.push(
      `- ${position.symbol} ${position.side}：均价 ${position.entryPrice}，标记 ${position.markPrice}，保护 ${position.protection.triggerPrice}，阶段 ${position.stopStage}`,
    );
  }
  lines.push('', '## 严重与警告事件', '');
  const notable = events.filter((event) => event.level !== 'INFO');
  if (!notable.length) lines.push('无。');
  for (const event of notable) {
    lines.push(
      `- ${new Date(event.at).toISOString()} · ${event.level} · ${event.symbol ? `${event.symbol} · ` : ''}${event.message}`,
    );
  }
  lines.push(
    '',
    '> 本报告由本地确定性程序生成，不调用大模型，也不构成投资建议。',
    '',
  );
  return lines.join('\n');
}
