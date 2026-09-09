import type { Candidate, Rules } from './engine.ts';
import { stageCandidate } from './plans.ts';

export const APPROVAL_MIN_SCORE = 90;
export const APPROVAL_MAX_SLOTS = 2;

export type ApprovalProposal = {
  schema: 'trendlock.approval/v1';
  id: string;
  rank: number;
  symbol: string;
  signal: 'LONG' | 'SHORT' | 'RANGE';
  orderMode: 'TREND_ENTRY' | 'LONG_GRID';
  score: number;
  reason: string;
  riskPct: number;
  riskBudget: number;
  notional: number;
  margin: number;
  indicativeEntry: number;
  initialStopPrice: number;
  status: 'AWAITING_USER_CONFIRMATION';
  plan: ReturnType<typeof stageCandidate>;
};

export type ApprovalQueue = {
  schema: 'trendlock.approval-queue/v1';
  source: string;
  asOf: number;
  minScore: number;
  maxSlots: number;
  occupiedSymbols: string[];
  openSlots: number;
  portfolioRiskPct: number;
  perSlotRiskPct: number;
  proposals: ApprovalProposal[];
  blockedReason: string | null;
  executionSupport: {
    userConfirmationRequired: true;
    protectiveConditionalOrder: false;
    nativeGridOrder: false;
  };
};

type QueueInput = {
  candidates: Candidate[];
  rules: Rules;
  source: string;
  asOf: number;
  now?: number;
  stale?: boolean;
  occupiedSymbols?: string[];
  minScore?: number;
  maxSlots?: number;
};

const uniqueSymbols = (symbols: string[]) => [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];

export function buildApprovalQueue({
  candidates,
  rules,
  source,
  asOf,
  now = Date.now(),
  stale = false,
  occupiedSymbols = [],
  minScore = APPROVAL_MIN_SCORE,
  maxSlots = APPROVAL_MAX_SLOTS,
}: QueueInput): ApprovalQueue {
  if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 2) throw new Error('审批槽位仅支持 1–2 个');
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 99) throw new Error('最低评分必须在 0–99');
  const occupied = uniqueSymbols(occupiedSymbols);
  const openSlots = Math.max(0, maxSlots - occupied.length);
  const perSlotRiskPct = rules.riskPct / maxSlots;
  const expired = stale || (source !== 'SYNTHETIC' && (now - asOf > 120_000 || asOf - now > 5_000));
  const blockedReason = expired
    ? '行情证据已过期，必须重新扫描'
    : openSlots === 0
      ? '两个交易槽位都已占用'
      : null;
  const queue: ApprovalQueue = {
    schema: 'trendlock.approval-queue/v1',
    source,
    asOf,
    minScore,
    maxSlots,
    occupiedSymbols: occupied,
    openSlots,
    portfolioRiskPct: rules.riskPct,
    perSlotRiskPct,
    proposals: [],
    blockedReason,
    executionSupport: {
      userConfirmationRequired: true,
      protectiveConditionalOrder: false,
      nativeGridOrder: false,
    },
  };
  if (blockedReason) return queue;

  const occupiedSet = new Set(occupied);
  const eligible = candidates
    .filter((candidate) => candidate.side !== 'NO_TRADE' && candidate.score >= minScore && !occupiedSet.has(candidate.symbol))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, openSlots);
  const proposalRules = { ...rules, riskPct: perSlotRiskPct };
  queue.proposals = eligible.flatMap((candidate, index) => {
    try {
      const plan = stageCandidate(candidate, proposalRules, source, asOf, now, false);
      let orderMode: ApprovalProposal['orderMode'];
      let riskBudget: number;
      let notional: number;
      let margin: number;
      let initialStopPrice: number;
      if (plan.kind === 'TREND_PLAN' && plan.risk && plan.protection) {
        orderMode = 'TREND_ENTRY';
        riskBudget = plan.risk.maxLoss;
        notional = plan.risk.notional;
        margin = plan.risk.margin;
        initialStopPrice = plan.protection.stopPrice;
      } else if (plan.kind === 'LONG_GRID_PLAN' && plan.grid && plan.riskBudget !== undefined && plan.notional !== undefined && plan.margin !== undefined) {
        orderMode = 'LONG_GRID';
        riskBudget = plan.riskBudget;
        notional = plan.notional;
        margin = plan.margin;
        initialStopPrice = plan.grid.lowerHardStop;
      } else {
        return [];
      }
      return [{
        schema: 'trendlock.approval/v1' as const,
        id: `${asOf}-${candidate.symbol}-${candidate.side}`,
        rank: index + 1,
        symbol: candidate.symbol,
        signal: candidate.side as 'LONG' | 'SHORT' | 'RANGE',
        orderMode,
        score: candidate.score,
        reason: candidate.reason,
        riskPct: perSlotRiskPct,
        riskBudget,
        notional,
        margin,
        indicativeEntry: candidate.price,
        initialStopPrice,
        status: 'AWAITING_USER_CONFIRMATION' as const,
        plan,
      }];
    } catch {
      return [];
    }
  });
  if (!queue.proposals.length) queue.blockedReason = `当前没有评分达到 ${minScore} 的候选`;
  return queue;
}

export function buildApprovalPreflightPrompt(queue: ApprovalQueue) {
  if (!queue.proposals.length) throw new Error(queue.blockedReason ?? `当前没有评分达到 ${queue.minScore} 的候选`);
  const proposalLines = queue.proposals.map((proposal) => [
    `- proposalId: ${proposal.id}`,
    `  symbol: ${proposal.symbol}`,
    `  signal: ${proposal.signal}`,
    `  orderMode: ${proposal.orderMode}`,
    `  score: ${proposal.score}`,
    `  riskBudget: ${proposal.riskBudget.toFixed(8)} USDT (${proposal.riskPct.toFixed(2)}% of equity)`,
    `  indicativeNotional: ${proposal.notional.toFixed(8)} USDT`,
    `  indicativeMargin: ${proposal.margin.toFixed(8)} USDT`,
    `  indicativeEntry: ${proposal.indicativeEntry}`,
    `  initialStopPrice: ${proposal.initialStopPrice}`,
  ].join('\n')).join('\n');
  return `使用 Binance MCP 对以下 TrendLock 候选执行只读预检，不要立即执行任何写操作。\n\n${proposalLines}\n\n必须先读取 Agentic 子账户的 U 本位余额、非零持仓、全部未成交委托、持仓模式、交易对规则和当前标记价格。最多允许两个不同交易对的活跃敞口；已有持仓或开仓委托占用槽位，禁止同币重复开仓。候选评分必须不低于 ${queue.minScore}，信号超过两分钟即作废。组合总风险预算为账户权益 ${queue.portfolioRiskPct.toFixed(2)}%，按两个槽位平均分配为每单 ${queue.perSlotRiskPct.toFixed(2)}%。杠杆不得超过 3 倍，只允许逐仓，禁止自动追加保证金、亏损加仓或将亏损趋势单转成网格。\n\n先按交易所价格精度、数量步长和最小名义价值重新量化，并展示完整确认卡：交易对、方向、positionSide、订单类型、数量、预估成交价、保证金、杠杆、初始服务器止损和最坏情形预算。此消息只授权读取和生成确认卡，不授权修改保证金模式、杠杆、下单、撤单或转账。当前 MCP 的 U 本位新订单工具未暴露 stopPrice/closePosition，且未提供原生合约网格工具；若仍无法在同一受控流程中创建并读回覆盖全部持仓的服务器保护单，必须返回 EXECUTION_BLOCKED，不得先开仓。`;
}
