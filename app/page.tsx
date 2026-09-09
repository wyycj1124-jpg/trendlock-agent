'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Braces,
  Check,
  ChevronRight,
  CircleDollarSign,
  Copy,
  Download,
  Gauge,
  LockKeyhole,
  PauseCircle,
  Play,
  Radar,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Waves,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  calculateGrid,
  calculateRisk,
  defaults,
  parseIntent,
  type Candidate,
  type Rules,
} from '@/lib/engine';
import { demoMarkets, demoTime } from '@/lib/demo';
import { fetchMarkPrice, scanFutures } from '@/lib/market';
import { importEvidence } from '@/lib/evidence';
import { advancePaper, stageCandidate, startPaper, type PaperState } from '@/lib/plans';
import {
  applyAutopilotTick,
  haltAutopilot,
  nextDemoPrice,
  recoverAutopilot,
  startAutopilot,
  stopAutopilot,
  unrealizedPnl,
  type AutopilotState,
} from '@/lib/automation';
import {
  buildMcpReplacementPrompt,
  haltSupervisor,
  observeSupervisor,
  recordStopReplacement,
  recoverSupervisor,
  startSupervisor,
  type SupervisorState,
} from '@/lib/supervisor';

type Mode = 'demo' | 'live' | 'import';
type Draft = { accountEquity: string; riskPct: string; leverage: string; initialStopPct: string; gridStepPct: string };
type SupervisorDraft = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  entryPrice: string;
  quantity: string;
  currentStopPrice: string;
};
const draftOf = (rules: Rules): Draft => ({ accountEquity: String(rules.accountEquity), riskPct: String(rules.riskPct), leverage: String(rules.leverage), initialStopPct: String(rules.initialStopPct), gridStepPct: String(rules.gridStepPct) });
const paperFor = (candidate?: Candidate, initialStop = 7) => candidate && (candidate.side === 'LONG' || candidate.side === 'SHORT') ? startPaper(candidate.side, candidate.price, initialStop) : null;

const price = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: value < 1 ? 6 : 2 });
const money = (value: number) => value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : `$${(value / 1e6).toFixed(1)}M`;
const AUTOPILOT_STORAGE = 'trendlock.paper-autopilot.v1';
const SUPERVISOR_STORAGE = 'trendlock.supervisor.v1';

function PriceChart({ candidate }: { candidate: Candidate }) {
  const bars = candidate.candles.slice(-42);
  if (!bars.length) return <div className="chart-empty">没有可展示的已收盘K线</div>;
  const values = bars.map((bar) => bar.close);
  const minimum = Math.min(...bars.map((bar) => bar.low), candidate.ema20 || Infinity, candidate.ema50 || Infinity);
  const maximum = Math.max(...bars.map((bar) => bar.high), candidate.ema20, candidate.ema50);
  const y = (value: number) => 188 - ((value - minimum) / (maximum - minimum || 1)) * 158;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 520},${y(value)}`).join(' ');
  const volumeMax = Math.max(...bars.map((bar) => bar.volume), 1);
  return (
    <svg className="price-chart" viewBox="0 0 520 220" aria-label={`${candidate.symbol} 最近42根已收盘K线趋势证据`}>
      <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f2ba38" stopOpacity=".25" /><stop offset="1" stopColor="#f2ba38" stopOpacity="0" /></linearGradient></defs>
      {[35, 85, 135, 185].map((line) => <line key={line} x1="0" x2="520" y1={line} y2={line} className="grid-line" />)}
      {bars.map((bar, index) => <rect key={bar.openTime} x={(index / bars.length) * 520} y={210 - (bar.volume / volumeMax) * 20} width={Math.max(2, 520 / bars.length - 2)} height={(bar.volume / volumeMax) * 20} className="volume-bar" />)}
      <polygon points={`0,190 ${points} 520,190`} fill="url(#chart-fill)" />
      <polyline points={points} className={`chart-line ${candidate.side.toLowerCase()}`} />
      {candidate.ema20 > 0 && <line x1="0" x2="520" y1={y(candidate.ema20)} y2={y(candidate.ema20)} className="ema-line ema20" />}
      {candidate.ema50 > 0 && <line x1="0" x2="520" y1={y(candidate.ema50)} y2={y(candidate.ema50)} className="ema-line ema50" />}
      <text x="7" y="14" className="chart-caption">CLOSE · 当前 EMA20 / EMA50 参考线</text>
      <circle cx="520" cy={y(values.at(-1)!)} r="4.5" className="chart-dot" />
    </svg>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('demo');
  const [rules, setRules] = useState<Rules>(defaults);
  const [draft, setDraft] = useState<Draft>(() => draftOf(defaults));
  const [rows, setRows] = useState<Candidate[]>(() => demoMarkets(defaults));
  const [selectedSymbol, setSelectedSymbol] = useState(rows[0]?.symbol ?? 'AVAXUSDT');
  const [prompt, setPrompt] = useState('扫描 1 小时 U 本位永续，识别趋势多空与震荡；单笔风险 10%，硬止损 7%，3 倍杠杆，网格 3%。');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: defaults.poolSize });
  const [error, setError] = useState('');
  const [asOf, setAsOf] = useState(demoTime);
  const [source, setSource] = useState('SYNTHETIC');
  const [stale, setStale] = useState(false);
  const [paper, setPaper] = useState<PaperState | null>(() => paperFor(rows[0]));
  const [plan, setPlan] = useState<ReturnType<typeof stageCandidate> | null>(null);
  const [agentEvidence, setAgentEvidence] = useState<ReturnType<typeof importEvidence> | null>(null);
  const [autopilot, setAutopilot] = useState<AutopilotState | null>(null);
  const [autopilotReady, setAutopilotReady] = useState(false);
  const [quoteFailures, setQuoteFailures] = useState(0);
  const [supervisor, setSupervisor] = useState<SupervisorState | null>(null);
  const [supervisorDraft, setSupervisorDraft] = useState<SupervisorDraft>({
    symbol: rows[0]?.symbol ?? '',
    side: rows[0]?.side === 'SHORT' ? 'SHORT' : 'LONG',
    positionSide: 'BOTH',
    entryPrice: '',
    quantity: '',
    currentStopPrice: '',
  });
  const [supervisorReady, setSupervisorReady] = useState(false);
  const [supervisorStarting, setSupervisorStarting] = useState(false);
  const [supervisorQuoteFailures, setSupervisorQuoteFailures] = useState(0);
  const [copiedSupervisorPrice, setCopiedSupervisorPrice] = useState<number | null>(null);
  const scanLock = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);
  const [trace, setTrace] = useState([
    '生成 8 组合成行情',
    '核验成交额、价差与量比',
    '按已收盘K线计算市况',
    '等待用户生成计划草稿',
  ]);
  const selected = rows.find((row) => row.symbol === selectedSymbol) ?? rows[0];
  const trendSide = selected?.side === 'SHORT' ? 'SHORT' : 'LONG';
  const entry = selected?.price || 1;
  const stop = paper?.stop ?? null;
  const scenarioPct = paper?.marks.at(-1) ?? 0;
  const risk = useMemo(() => calculateRisk(rules, Math.max(entry, 0.000001)), [entry, rules]);
  const grid = selected ? calculateGrid(selected, rules.gridStepPct) : null;
  const draftChanged = JSON.stringify(draft) !== JSON.stringify(draftOf(rules));
  const stamp = new Date(asOf).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' UTC+8';
  const actions = useRef({
    read: () => ({}),
    simulate: (_pct: number) => ({}),
    stage: () => ({}),
    startPaperAutopilot: () => ({}),
    stopPaperAutopilot: () => ({}),
  });

  const autoUnrealized = autopilot ? unrealizedPnl(autopilot) : 0;
  const autoProtection = autopilot?.kind === 'TREND' ? autopilot.paper.stop : null;
  const autoInventory = autopilot?.kind === 'GRID'
    ? autopilot.lots.filter((lot) => lot.status === 'OPEN').length
    : 0;
  const supervisorActive = supervisor?.status === 'MONITORING' || supervisor?.status === 'WAITING_CONFIRMATION';
  const supervisorMovePct = supervisor
    ? (supervisor.side === 'LONG' ? supervisor.markPrice / supervisor.entryPrice - 1 : 1 - supervisor.markPrice / supervisor.entryPrice) * 100
    : null;

  useEffect(() => {
    if (source === 'SYNTHETIC') return;
    const checkAge = () => {
      if (Date.now() - asOf > 120_000 || asOf - Date.now() > 5_000) { setStale(true); setPlan(null); }
    };
    checkAge();
    const timer = setInterval(checkAge, 5_000);
    return () => clearInterval(timer);
  }, [asOf, source]);

  useEffect(() => {
    let cancelled = false;
    let recovered: AutopilotState | null = null;
    try {
      const stored = window.localStorage.getItem(AUTOPILOT_STORAGE);
      if (stored) {
        const parsed = JSON.parse(stored) as AutopilotState;
        if (parsed?.schema === 'trendlock.autopilot/v1') recovered = recoverAutopilot(parsed);
      }
    } catch {
      window.localStorage.removeItem(AUTOPILOT_STORAGE);
    }
    queueMicrotask(() => {
      if (cancelled) return;
      if (recovered) setAutopilot(recovered);
      setAutopilotReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!autopilotReady) return;
    if (autopilot) window.localStorage.setItem(AUTOPILOT_STORAGE, JSON.stringify(autopilot));
    else window.localStorage.removeItem(AUTOPILOT_STORAGE);
  }, [autopilot, autopilotReady]);

  useEffect(() => {
    if (!autopilot || autopilot.status !== 'RUNNING') return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = source === 'SYNTHETIC'
          ? { markPrice: nextDemoPrice(autopilot), time: Math.max(Date.now(), autopilot.lastTickAt + 1) }
          : await fetchMarkPrice(autopilot.symbol);
        if (cancelled) return;
        setAutopilot((current) => current?.status === 'RUNNING' && current.symbol === autopilot.symbol
          ? applyAutopilotTick(current, next.markPrice, Math.max(next.time, current.lastTickAt + 1))
          : current);
        setQuoteFailures(0);
      } catch {
        if (cancelled) return;
        setQuoteFailures((current) => {
          const next = current + 1;
          if (next >= 3) setAutopilot((state) => state ? haltAutopilot(state, Date.now(), '连续三次读取行情失败') : state);
          return next;
        });
      }
    }, source === 'SYNTHETIC' ? 1_200 : 5_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [autopilot, source]);

  useEffect(() => {
    let cancelled = false;
    let recovered: SupervisorState | null = null;
    try {
      const stored = window.localStorage.getItem(SUPERVISOR_STORAGE);
      if (stored) {
        const parsed = JSON.parse(stored) as SupervisorState;
        if (parsed?.schema === 'trendlock.supervisor/v1') recovered = recoverSupervisor(parsed);
      }
    } catch {
      window.localStorage.removeItem(SUPERVISOR_STORAGE);
    }
    queueMicrotask(() => {
      if (cancelled) return;
      if (recovered) setSupervisor(recovered);
      setSupervisorReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!supervisorReady) return;
    if (supervisor) window.localStorage.setItem(SUPERVISOR_STORAGE, JSON.stringify(supervisor));
    else window.localStorage.removeItem(SUPERVISOR_STORAGE);
  }, [supervisor, supervisorReady]);

  useEffect(() => {
    if (!supervisorActive || !supervisor) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await fetchMarkPrice(supervisor.symbol);
        if (cancelled) return;
        setSupervisor((current) => current &&
          (current.status === 'MONITORING' || current.status === 'WAITING_CONFIRMATION') &&
          current.symbol === supervisor.symbol
          ? observeSupervisor(current, next.markPrice, Math.max(next.time, current.lastTickAt + 1))
          : current);
        setSupervisorQuoteFailures(0);
      } catch {
        if (cancelled) return;
        setSupervisorQuoteFailures((current) => {
          const next = current + 1;
          if (next >= 3) {
            setSupervisor((state) => state && (state.status === 'MONITORING' || state.status === 'WAITING_CONFIRMATION')
              ? haltSupervisor(state, Date.now(), '连续三次读取公开标记价格失败')
              : state);
          }
          return next;
        });
      }
    }, 5_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [supervisor, supervisorActive]);

  function selectCandidate(symbol: string) {
    setSelectedSymbol(symbol);
    setPaper(paperFor(rows.find((row) => row.symbol === symbol), rules.initialStopPct));
    setPlan(null);
  }

  function simulate(pct: number) {
    if (!paper || !selected) throw new Error('当前候选不是趋势交易');
    const next = advancePaper(paper, pct, rules.initialStopPct);
    flushSync(() => setPaper(next));
    return { symbol: selected.symbol, status: next.status, stop: next.stop, exitReference: next.exitReference };
  }

  function stagePlan() {
    if (!selected || running || draftChanged) throw new Error('请先完成扫描并应用参数');
    const next = stageCandidate(selected, rules, source, asOf, Date.now(), stale);
    flushSync(() => { setPlan(next); setError(''); });
    return next;
  }

  function startPaperAutomation() {
    if (!selected || running || draftChanged) throw new Error('请先完成扫描并应用参数');
    if (source !== 'SYNTHETIC' && stale) throw new Error('行情证据已过期，请重新扫描');
    if (autopilot?.status === 'RUNNING') throw new Error('已有一个自动化实例正在运行');
    const next = startAutopilot(selected, rules);
    flushSync(() => { setAutopilot(next); setQuoteFailures(0); setError(''); });
    return next;
  }

  function stopPaperAutomation() {
    if (!autopilot) throw new Error('当前没有自动化实例');
    const next = stopAutopilot(autopilot);
    flushSync(() => setAutopilot(next));
    return next;
  }

  function updateSupervisorDraft(key: keyof SupervisorDraft, value: string) {
    setSupervisorDraft((current) => ({ ...current, [key]: value }));
  }

  function prefillSupervisor() {
    if (!selected || (selected.side !== 'LONG' && selected.side !== 'SHORT')) {
      throw new Error('请选择 LONG 或 SHORT 趋势候选');
    }
    const stopPrice = selected.price * (selected.side === 'LONG'
      ? 1 - rules.initialStopPct / 100
      : 1 + rules.initialStopPct / 100);
    setSupervisorDraft({
      symbol: selected.symbol,
      side: selected.side,
      positionSide: 'BOTH',
      entryPrice: String(selected.price),
      quantity: String(Number(risk.quantity.toPrecision(8))),
      currentStopPrice: String(Number(stopPrice.toPrecision(8))),
    });
    setError('');
  }

  async function startLiveSupervisor() {
    if (supervisorActive) throw new Error('已有一个监督任务正在运行');
    setSupervisorStarting(true);
    try {
      const symbol = supervisorDraft.symbol.trim().toUpperCase();
      const quote = await fetchMarkPrice(symbol);
      const next = startSupervisor({
        symbol,
        side: supervisorDraft.side,
        positionSide: supervisorDraft.positionSide,
        entryPrice: Number(supervisorDraft.entryPrice),
        quantity: Number(supervisorDraft.quantity),
        currentStopPrice: Number(supervisorDraft.currentStopPrice),
        markPrice: quote.markPrice,
        initialStopPct: rules.initialStopPct,
      }, quote.time);
      flushSync(() => {
        setSupervisor(next);
        setSupervisorQuoteFailures(0);
        setCopiedSupervisorPrice(null);
        setError('');
      });
    } finally {
      setSupervisorStarting(false);
    }
  }

  function stopLiveSupervisor() {
    if (!supervisor) throw new Error('当前没有监督任务');
    setSupervisor(haltSupervisor(supervisor));
  }

  async function copySupervisorPrompt() {
    if (!supervisor?.pendingAction) throw new Error('当前没有待确认改单');
    const requested = supervisor.pendingAction.requestedTriggerPrice;
    await navigator.clipboard.writeText(buildMcpReplacementPrompt(supervisor));
    setCopiedSupervisorPrice(requested);
    setError('');
  }

  function recordSupervisorReplacement() {
    if (!supervisor?.pendingAction) throw new Error('当前没有待确认改单');
    const requested = supervisor.pendingAction.requestedTriggerPrice;
    setSupervisor(recordStopReplacement(supervisor, requested, Math.max(Date.now(), supervisor.lastTickAt + 1)));
    setCopiedSupervisorPrice(null);
    setError('');
  }

  useEffect(() => {
    actions.current = {
      read: () => ({
        mode,
        source, asOf, stale, rules,
        selected: selected ? { symbol: selected.symbol, side: selected.side, score: selected.score, reason: selected.reason } : null,
        paper,
        risk,
        grid,
        plan,
        autopilot,
        agentOs: agentEvidence?.agentOs ?? { verified: false, note: '未进行 Agent OS 连接验证' },
      }),
      simulate,
      stage: stagePlan,
      startPaperAutopilot: startPaperAutomation,
      stopPaperAutopilot: stopPaperAutomation,
    };
  });

  useEffect(() => {
    type Tool = {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => unknown;
    };
    const context = (document as Document & { modelContext?: { registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Tool) => {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined); } catch { /* unsupported draft implementation */ }
    };
    register({
      name: 'read_trendlock_plan',
      title: '读取当前TrendLock计划',
      description: '读取页面当前选中的候选、市场状态、风险预算与止损或网格计划。不会下单。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('Expected an empty object');
        return actions.current.read();
      },
    });
    register({
      name: 'start_trendlock_paper_autopilot',
      title: '启动TrendLock模拟自动化',
      description: '为页面当前选中的合格候选启动PAPER自动运行。只模拟成交和风控，不连接账户、不下单。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('Expected an empty object');
        return actions.current.startPaperAutopilot();
      },
    });
    register({
      name: 'stop_trendlock_paper_autopilot',
      title: '停止TrendLock模拟自动化',
      description: '停止并冻结页面内的PAPER自动化状态。不会操作币安账户。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('Expected an empty object');
        return actions.current.stopPaperAutopilot();
      },
    });
    register({
      name: 'simulate_trendlock_profit',
      title: '模拟阶梯止损',
      description: '在页面沙盒中模拟选中趋势仓位达到指定有利涨跌幅，并同步更新阶梯止损。不会连接账户或下单。',
      inputSchema: { type: 'object', properties: { favorablePct: { type: 'number', minimum: -30, maximum: 60 } }, required: ['favorablePct'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input !== 'object' || !('favorablePct' in input) || typeof input.favorablePct !== 'number' || Object.keys(input).length !== 1) throw new Error('Expected favorablePct number');
        return actions.current.simulate(input.favorablePct);
      },
    });
    register({
      name: 'stage_trendlock_trade_plan',
      title: '生成待确认交易计划',
      description: '把当前合格候选生成页面内待确认计划。只改变演示状态，不连接账户、不执行交易。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('Expected an empty object');
        return actions.current.stage();
      },
    });
    return () => lifecycle.abort();
  }, []);

  async function runScan(target: Mode = mode) {
    if (scanLock.current) return;
    if (autopilot?.status === 'RUNNING') {
      setError('请先停止并冻结当前自动化实例，再重新扫描或切换数据源');
      return;
    }
    if (target === 'import') { importInput.current?.click(); return; }
    scanLock.current = true;
    setRunning(true);
    setError('');
    setPlan(null);
    try {
      const fromDraft = { ...rules, accountEquity: Number(draft.accountEquity), riskPct: Number(draft.riskPct), leverage: Number(draft.leverage), initialStopPct: Number(draft.initialStopPct), gridStepPct: Number(draft.gridStepPct) };
      const nextRules = parseIntent(prompt, fromDraft);
      let next: Candidate[];
      if (target === 'demo') {
        next = demoMarkets(nextRules);
        setAsOf(demoTime);
        setSource('SYNTHETIC');
        setTrace(['提取已支持的规则字段', '生成可复现合成K线', '计算 LONG / SHORT / RANGE / NO_TRADE', '等待生成计划草稿']);
      } else {
        const result = await scanFutures(nextRules, (done, total) => setProgress({ done, total }));
        next = result.rows;
        setAsOf(result.asOf);
        setSource('BINANCE_PUBLIC_FUTURES_REST');
        setTrace(['GET exchangeInfo + time', 'GET ticker/24hr + bookTicker + premiumIndex', `K线成功 ${result.attempted - result.failed} / ${result.attempted}`, '本地规则计算（非 MCP）']);
      }
      const first = next.find((row) => row.side !== 'NO_TRADE') ?? next[0];
      setRows(next);
      setRules(nextRules);
      setDraft(draftOf(nextRules));
      setSelectedSymbol(first?.symbol ?? '');
      setPaper(paperFor(first, nextRules.initialStopPct));
      setAgentEvidence(null);
      setStale(false);
      setMode(target);
    } catch (cause) {
      setStale(true);
      setError(`${(cause as Error).message}。已保留上一轮结果，不代表当前行情。`);
    } finally {
      setRunning(false);
      scanLock.current = false;
    }
  }

  function updateRule(key: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setPlan(null);
  }

  function applyDraft() {
    try {
      const next = parseIntent('', { ...rules, accountEquity: Number(draft.accountEquity), riskPct: Number(draft.riskPct), leverage: Number(draft.leverage), initialStopPct: Number(draft.initialStopPct), gridStepPct: Number(draft.gridStepPct) });
      setRules(next); setDraft(draftOf(next)); setPlan(null); setError('');
      setPrompt(`扫描 ${next.interval} 趋势与震荡；单笔风险 ${next.riskPct}%，硬止损 ${next.initialStopPct}%，${next.leverage} 倍杠杆，网格 ${next.gridStepPct}%。`);
    } catch (cause) { setError((cause as Error).message); }
  }

  async function uploadEvidence(file?: File) {
    if (!file || scanLock.current) return;
    scanLock.current = true; setRunning(true); setPlan(null);
    try {
      if (file.size > 5_000_000) throw new Error('文件上限 5 MB');
      const data = importEvidence(JSON.parse(await file.text()), rules);
      const first = data.rows.find((row) => row.side !== 'NO_TRADE') ?? data.rows[0];
      setRows(data.rows); setAsOf(data.asOf); setSource(data.source); setSelectedSymbol(first.symbol);
      setPaper(paperFor(first, rules.initialStopPct)); setMode('import'); setAgentEvidence(data);
      setTrace([`导入 ${data.rows.length} 个行情快照`, `声明来源：${data.agentOs.transport}（未验签）`, `含 ${data.tools.length} 条调用记录`, '重新计算全部规则，不信任外部评分']);
      setStale(data.source !== 'SYNTHETIC' && (Date.now() - data.asOf > 120_000 || data.asOf - Date.now() > 5_000));
      setError('');
    } catch { setStale(true); setError('导入失败：请检查原始行情契约、字段和 5 MB 限制。上一轮结果已标记失效。'); }
    finally { scanLock.current = false; setRunning(false); if (importInput.current) importInput.current.value = ''; }
  }

  function downloadPlan() {
    const payload = actions.current.read();
    const blob = new Blob([JSON.stringify({ schema: 'trendlock.analysis/v1', generatedAt: new Date().toISOString(), ...payload, candidates: rows, trace, tools: agentEvidence?.tools ?? [] }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'trendlock-plan.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const visibleRows = rows;
  const counts = {
    long: rows.filter((row) => row.side === 'LONG').length,
    short: rows.filter((row) => row.side === 'SHORT').length,
    range: rows.filter((row) => row.side === 'RANGE').length,
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><ShieldCheck /></div>
        <div className="brand-copy"><strong>TRENDLOCK</strong><span>趋势锁盈智能体</span></div>
        <nav aria-label="产品状态">
          <span className="status-pill">PAPER 自动化 · 已启用</span>
          <span className="status-pill muted"><LockKeyhole /> MCP 实盘仍需逐次确认</span>
        </nav>
      </header>

      <section className="command-bar">
        <div className="mode-switch" aria-label="数据模式">
          <button disabled={running || autopilot?.status === 'RUNNING'} className={mode === 'demo' ? 'active' : ''} onClick={() => void runScan('demo')}>合成演示</button>
          <button disabled={running || autopilot?.status === 'RUNNING'} className={mode === 'live' ? 'active' : ''} onClick={() => void runScan('live')}>公开行情</button>
        </div>
        <div className="command-icon"><Sparkles /></div>
        <label htmlFor="agent-command" className="sr-only">输入智能体任务</label>
        <Input id="agent-command" value={prompt} disabled={running || autopilot?.status === 'RUNNING'} onChange={(event) => setPrompt(event.target.value)} className="command-input" />
        <Button className="scan-button" onClick={() => void runScan()} disabled={running || autopilot?.status === 'RUNNING'}>
          {running ? <RefreshCw className="spin" /> : <Radar />}{running ? `${progress.done}/${progress.total}` : '运行扫描'}
        </Button>
      </section>
      <div className="command-help">规则解析器支持周期、账户风险、硬止损、杠杆、量比和格距；未接入大模型。修改文字后需重新扫描。<Button variant="ghost" size="sm" disabled={running || draftChanged || autopilot?.status === 'RUNNING'} onClick={() => importInput.current?.click()}>导入 Agent 行情 JSON</Button><Input ref={importInput} className="hidden" type="file" accept="application/json,.json" aria-label="导入Agent原始行情" onChange={(event) => void uploadEvidence(event.target.files?.[0])} /></div>
      {error && <div className="error-banner" role="alert"><X />{error}</div>}
      <div className="source-banner"><span className={source === 'SYNTHETIC' ? 'demo-source' : 'live-source'}>{source}</span><span>{stamp}</span><span>{stale ? '证据已失效 · 禁止生成计划' : source === 'SYNTHETIC' ? '合成行情 · 非回测 · 非实时信号' : '行情快照 · 两分钟后失效'}</span></div>

      <section className="summary-strip" aria-label="扫描摘要">
        <div><Activity /><span>扫描池</span><strong>{String(rows.length).padStart(2, '0')}</strong><small>U本位永续</small></div>
        <div><ArrowUpRight /><span>趋势做多</span><strong>{String(counts.long).padStart(2, '0')}</strong><small>满足硬条件</small></div>
        <div><ArrowDownRight /><span>趋势做空</span><strong>{String(counts.short).padStart(2, '0')}</strong><small>满足硬条件</small></div>
        <div><Waves /><span>震荡候选</span><strong>{String(counts.range).padStart(2, '0')}</strong><small>仅生成网格计划</small></div>
        <div className={`risk-ok ${rules.riskPct >= 5 ? 'high-risk' : ''}`}><ShieldCheck /><span>{rules.riskPct >= 5 ? '高风险预算' : '单笔预算'}</span><strong>{rules.riskPct.toFixed(2)}%</strong><small>风险预算 {risk.maxLoss.toFixed(0)} U</small></div>
      </section>

      <section className="autopilot-panel panel" aria-label="自动化试运行">
        <div className="autopilot-heading">
          <div><Radio /><span>自动化试运行</span><small>PAPER ONLY</small></div>
          <span className={`autopilot-status ${(autopilot?.status ?? 'IDLE').toLowerCase()}`}>
            <i />{autopilot?.status ?? 'IDLE'}
          </span>
        </div>
        <div className="autopilot-body">
          <div className="autopilot-copy">
            <strong>{autopilot ? `${autopilot.symbol} · ${autopilot.side}` : selected ? `${selected.symbol} · ${selected.side}` : '等待候选'}</strong>
            <p>{autopilot?.status === 'RUNNING'
              ? source === 'SYNTHETIC' ? '正在自动播放行情并执行虚拟成交、阶梯保护或网格循环。' : '每5秒读取币安公开标记价格；断线、刷新或连续失败会自动熔断。'
              : '先扫描并选择候选，再启动模拟自动化。它不会读取余额或向币安发送订单。'}</p>
            <div className="autopilot-actions">
              <Button onClick={() => { try { startPaperAutomation(); } catch (cause) { setError((cause as Error).message); } }} disabled={!selected || selected.side === 'NO_TRADE' || running || stale || draftChanged || autopilot?.status === 'RUNNING'}><Play />启动 PAPER 自动化</Button>
              <Button variant="secondary" onClick={() => { try { stopPaperAutomation(); } catch (cause) { setError((cause as Error).message); } }} disabled={!autopilot || autopilot.status !== 'RUNNING'}><PauseCircle />停止并冻结</Button>
            </div>
          </div>
          <div className="autopilot-metrics">
            <div><span>模拟成交均价</span><strong>{autopilot?.kind === 'TREND' ? price(autopilot.entryPrice) : autopilot ? '分层限价' : '—'}</strong></div>
            <div><span>当前标记价格</span><strong>{autopilot ? price(autopilot.markPrice) : '—'}</strong></div>
            <div><span>{autopilot?.kind === 'GRID' ? '已买入格数' : '当前保护价'}</span><strong>{autopilot?.kind === 'GRID' ? `${autoInventory} 格` : autoProtection ? price(autoProtection.stopPrice) : '—'}</strong></div>
            <div><span>{autopilot?.kind === 'GRID' ? '已实现损益' : '下一触发档'}</span><strong>{autopilot?.kind === 'GRID' ? `${autopilot.realizedPnl.toFixed(2)} U` : autoProtection?.nextTriggerPct ? `+${autoProtection.nextTriggerPct}%` : '—'}</strong></div>
            <div><span>浮动损益</span><strong className={autoUnrealized >= 0 ? 'positive' : 'negative'}>{autoUnrealized >= 0 ? '+' : ''}{autoUnrealized.toFixed(2)} U</strong></div>
            <div><span>行情读取失败</span><strong>{quoteFailures}/3</strong></div>
          </div>
          <div className="autopilot-log">
            <strong>最近事件</strong>
            <ol>{(autopilot?.events ?? ['尚未启动']).slice(-5).reverse().map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ol>
          </div>
          <div className="mcp-boundary"><LockKeyhole /><p><strong>MCP 辅助执行边界</strong>网页可自动监控与生成下一步，但不能绕过 Binance 的确认。实盘开仓、换止损、撤单和平仓仍需在当前 Codex 对话逐次核验并确认。</p></div>
        </div>
      </section>

      <section className="supervisor-panel panel" aria-label="MCP监督执行">
        <div className="autopilot-heading supervisor-heading">
          <div><ShieldCheck /><span>MCP 监督执行</span><small>USER CONFIRM</small></div>
          <span className={`autopilot-status ${(supervisor?.status ?? 'IDLE').toLowerCase()}`}>
            <i />{supervisor?.status ?? 'IDLE'}
          </span>
        </div>
        <div className="supervisor-intro">
          <div>
            <strong>成交后只盯持仓交易对，不重扫整个市场</strong>
            <p>每 5 秒读取公开标记价格；达到 +5%、+8% 及后续每 +3% 档位时，暂停在待确认状态并生成 MCP 改单指令。页面不持有账户授权，也不会自行下单。</p>
          </div>
          <Button variant="secondary" onClick={() => { try { prefillSupervisor(); } catch (cause) { setError((cause as Error).message); } }} disabled={supervisorActive}>用当前计划预填</Button>
        </div>
        <div className="supervisor-form">
          <label htmlFor="supervisor-symbol">交易对<Input id="supervisor-symbol" value={supervisorDraft.symbol} disabled={supervisorActive || supervisorStarting} onChange={(event) => updateSupervisorDraft('symbol', event.target.value.toUpperCase())} /></label>
          <label htmlFor="supervisor-side">真实持仓方向<select id="supervisor-side" value={supervisorDraft.side} disabled={supervisorActive || supervisorStarting} onChange={(event) => updateSupervisorDraft('side', event.target.value as SupervisorDraft['side'])}><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></label>
          <label htmlFor="supervisor-position-side">持仓模式字段<select id="supervisor-position-side" value={supervisorDraft.positionSide} disabled={supervisorActive || supervisorStarting} onChange={(event) => updateSupervisorDraft('positionSide', event.target.value as SupervisorDraft['positionSide'])}><option value="BOTH">BOTH（单向）</option><option value="LONG">LONG（双向）</option><option value="SHORT">SHORT（双向）</option></select></label>
          <label htmlFor="supervisor-entry">真实加权开仓均价<Input id="supervisor-entry" type="number" min="0" step="any" value={supervisorDraft.entryPrice} disabled={supervisorActive || supervisorStarting} onChange={(event) => updateSupervisorDraft('entryPrice', event.target.value)} /></label>
          <label htmlFor="supervisor-quantity">真实持仓数量<Input id="supervisor-quantity" type="number" min="0" step="any" value={supervisorDraft.quantity} disabled={supervisorActive || supervisorStarting} onChange={(event) => updateSupervisorDraft('quantity', event.target.value)} /></label>
          <label htmlFor="supervisor-stop">币安现有服务器止损<Input id="supervisor-stop" type="number" min="0" step="any" value={supervisorDraft.currentStopPrice} disabled={supervisorActive || supervisorStarting} onChange={(event) => updateSupervisorDraft('currentStopPrice', event.target.value)} /></label>
        </div>
        <div className="supervisor-actions">
          <Button onClick={() => void startLiveSupervisor().catch((cause) => setError((cause as Error).message))} disabled={supervisorActive || supervisorStarting}><Play />{supervisorStarting ? '读取标记价格…' : '开始监督监控'}</Button>
          <Button variant="secondary" onClick={() => { try { stopLiveSupervisor(); } catch (cause) { setError((cause as Error).message); } }} disabled={!supervisorActive}><PauseCircle />停止监控</Button>
          <p><LockKeyhole />“当前计划预填”只是草稿。开始前必须改成 MCP 读回的真实成交均价、数量和已存在的服务器保护单。</p>
        </div>
        <div className="supervisor-dashboard">
          <div className="autopilot-metrics supervisor-metrics">
            <div><span>当前标记价格</span><strong>{supervisor ? price(supervisor.markPrice) : '—'}</strong></div>
            <div><span>相对均价有利变化</span><strong className={(supervisorMovePct ?? 0) >= 0 ? 'positive' : 'negative'}>{supervisorMovePct === null ? '—' : `${supervisorMovePct >= 0 ? '+' : ''}${supervisorMovePct.toFixed(2)}%`}</strong></div>
            <div><span>已核验服务器止损</span><strong>{supervisor ? price(supervisor.currentStopPrice) : '—'}</strong></div>
            <div><span>当前锁定目标</span><strong>{supervisor ? `${supervisor.currentStopReturnPct >= 0 ? '+' : ''}${supervisor.currentStopReturnPct.toFixed(2)}%` : '—'}</strong></div>
            <div><span>下一触发档</span><strong>{supervisor?.nextTriggerPct ? `+${supervisor.nextTriggerPct}%` : '—'}</strong></div>
            <div><span>行情读取失败</span><strong>{supervisorQuoteFailures}/3</strong></div>
          </div>
          <div className="supervisor-log">
            <strong>监督事件</strong>
            <ol>{(supervisor?.events ?? ['尚未创建真实持仓监督任务']).slice(-6).reverse().map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ol>
          </div>
        </div>
        {supervisor?.pendingAction && (
          <div className="confirmation-card">
            <div><Radio /><p><strong>待你确认改单</strong><span>旧保护 {price(supervisor.pendingAction.previousTriggerPrice)} → 新保护 {price(supervisor.pendingAction.requestedTriggerPrice)} · 锁定 {supervisor.pendingAction.requestedLockPct.toFixed(2)}%</span></p></div>
            <div className="confirmation-actions">
              <Button onClick={() => void copySupervisorPrompt().catch((cause) => setError((cause as Error).message))}><Copy />{copiedSupervisorPrice === supervisor.pendingAction.requestedTriggerPrice ? '指令已复制' : '复制 Binance MCP 指令'}</Button>
              <Button variant="secondary" onClick={recordSupervisorReplacement}>我已执行并读回核验</Button>
            </div>
            <details><summary>查看完整待确认指令</summary><pre>{buildMcpReplacementPrompt(supervisor)}</pre></details>
          </div>
        )}
        {supervisor?.status === 'RECONCILIATION_REQUIRED' && <div className="reconciliation-note"><X /><p><strong>停止推断，必须对账</strong>标记价格已越过页面记录的止损。请在 Codex 中读取真实持仓和当前挂单；不要假定成交，也不要盲目重试。</p></div>}
        {supervisor?.status === 'HALTED' && <div className="reconciliation-note"><PauseCircle /><p><strong>本地监控已停止</strong>币安上已经存在的服务器止损不会因此消失；重新开始前，请先用 MCP 读回最新持仓和保护单，再更新上方字段。</p></div>}
      </section>

      <div className="workspace">
        <aside className="candidate-panel panel">
          <div className="panel-title"><div><Radar /><span>机会队列</span></div><small>按证据评分</small></div>
          <div className="candidate-list">
            {visibleRows.map((candidate) => (
              <button disabled={running || autopilot?.status === 'RUNNING'} className={selected?.symbol === candidate.symbol ? 'candidate active' : 'candidate'} key={candidate.symbol} onClick={() => selectCandidate(candidate.symbol)}>
                <span className={`side ${candidate.side.toLowerCase()}`}>{candidate.side}</span>
                <span className="candidate-main"><strong>{candidate.symbol.replace('USDT', '')}<small>/USDT</small></strong><em>{candidate.reason}</em></span>
                <span className="candidate-score"><b>{candidate.score}</b><small>SCORE</small></span>
                <ChevronRight className="candidate-arrow" />
              </button>
            ))}
            {!visibleRows.length && <p className="empty-state">没有通过硬风控的候选。零结果也是有效结果。</p>}
          </div>
          <div className="rule-controls">
            <label htmlFor="equity">假设权益 U<Input disabled={running || autopilot?.status === 'RUNNING'} id="equity" type="number" value={draft.accountEquity} min={1} onChange={(event) => updateRule('accountEquity', event.target.value)} /></label>
            <label htmlFor="risk-percent">单笔账户风险 %<Input disabled={running || autopilot?.status === 'RUNNING'} id="risk-percent" type="number" value={draft.riskPct} min={0.05} max={10} step={0.05} onChange={(event) => updateRule('riskPct', event.target.value)} /></label>
            <label htmlFor="leverage">杠杆（上限 3）<Input disabled={running || autopilot?.status === 'RUNNING'} id="leverage" type="number" value={draft.leverage} min={1} max={3} onChange={(event) => updateRule('leverage', event.target.value)} /></label>
            <label htmlFor="initial-stop">初始硬止损 %<Input disabled={running || autopilot?.status === 'RUNNING'} id="initial-stop" type="number" value={draft.initialStopPct} min={1} max={30} step={0.5} onChange={(event) => updateRule('initialStopPct', event.target.value)} /></label>
            <label htmlFor="grid-step">网格间距 %<Input disabled={running || autopilot?.status === 'RUNNING'} id="grid-step" type="number" value={draft.gridStepPct} min={0.2} max={10} step={0.1} onChange={(event) => updateRule('gridStepPct', event.target.value)} /></label>
            <Button className="apply-rules" variant="secondary" disabled={running || autopilot?.status === 'RUNNING' || !draftChanged} onClick={applyDraft}>{draftChanged ? '应用参数' : '参数已应用'}</Button>
          </div>
          <div className="source-note"><Braces /><p><strong>规则证据，不是胜率</strong>评分用于队列排序。低价不等于低风险，市况识别也可能失效。</p></div>
        </aside>

        {selected && <section className="market-panel panel">
          <div className="market-heading">
            <div><span className={`side ${selected.side.toLowerCase()}`}>{selected.side}</span><h1>{selected.symbol.replace('USDT', '')}<small>/ USDT PERP · FUNDING {(selected.fundingRate * 100).toFixed(4)}%</small></h1></div>
            <div className="quote"><strong>{price(selected.price)}</strong><span className={selected.change24h >= 0 ? 'positive' : 'negative'}>{selected.change24h >= 0 ? '+' : ''}{selected.change24h.toFixed(2)}%</span></div>
          </div>
          <PriceChart candidate={selected} />
          <div className="evidence-grid">
            {selected.evidence.map((item) => <div key={item.label} className={item.pass ? '' : 'failed'}><span>{item.pass ? <Check /> : <X />}{item.label}</span><strong>{item.value}</strong><small>{item.pass ? 'PASS' : 'FAIL'}</small></div>)}
          </div>
          <div className="market-meta"><span>ATR {selected.atrPct.toFixed(2)}%</span><span>量比 {selected.volumeRatio.toFixed(2)}×</span><span>24h {money(selected.turnover24h)}</span><span>价差 {selected.spreadBps.toFixed(2)} bps</span></div>
          <div className="market-explanation"><strong>{selected.reason}</strong><p>当前规则：{rules.interval} · 最低成交额 {money(rules.minTurnover)} · 价差 ≤ {rules.maxSpreadBps} bps · 量比 ≥ {rules.minVolumeRatio}×。EMA 与 ATR 是历史证据，不保证趋势延续。</p></div>
        </section>}

        <aside className="execution-column">
          <section className="panel stop-panel">
            <div className="panel-title"><div><Gauge /><span>{selected?.side === 'RANGE' ? '网格计划' : '阶梯止损沙盒'}</span></div><small>{grid ? '独立做多网格' : '非仓位收益率'}</small></div>
            {grid ? (
              <div className="grid-plan">
                <div><span>区间下沿</span><strong>{price(grid.lower)}</strong></div><div><span>区间上沿</span><strong>{price(grid.upper)}</strong></div>
                <div><span>网格数量</span><strong>{grid.grids}</strong></div><div><span>实际格距</span><strong>{grid.stepPct.toFixed(2)}%</strong></div>
                <div><span>下方硬退出价</span><strong>{price(grid.lowerHardStop)}</strong></div><div><span>上方硬退出价</span><strong>{price(grid.upperHardStop)}</strong></div>
                <p>仅为做多网格草稿：买入成交后才能挂对应卖单。突破区间停止新增买单，触及硬退出价平仓。不会把亏损趋势单转成网格。</p>
              </div>
            ) : stop ? (
              <>
                <div className="stop-hero"><span>{paper?.status === 'STOP_TRIGGERED' ? '已触发模拟平仓' : '模拟保护价 · 尚未挂单'}</span><strong>{price(stop.stopPrice)}</strong><em>保护目标 {stop.stopReturnPct >= 0 ? '+' : ''}{stop.stopReturnPct.toFixed(2)}%</em></div>
                <p className="sandbox-note">假设均价 {price(entry)} · 模拟价 {price(stop.mark)} · 当前有利变化 {scenarioPct.toFixed(2)}%</p>
                <div className="simulation-controls"><span>推进模拟价格</span>{[3, 5, 8, 12].map((value) => <button disabled={paper?.status !== 'OPEN'} key={value} className={Math.abs(scenarioPct - value) < .001 ? 'active' : ''} onClick={() => simulate(value)}>+{value}%</button>)}</div>
                <div className="sandbox-actions"><Button variant="secondary" size="sm" disabled={paper?.status !== 'OPEN'} onClick={() => simulate(stop.stopReturnPct)}>回撤到保护价</Button><Button variant="ghost" size="sm" onClick={() => setPaper(paperFor(selected, rules.initialStopPct))}>重置模拟</Button></div>
                <div className="ladder">
                  {[
                    ['初始保护', `目标 −${rules.initialStopPct}%`, entry * (1 + (trendSide === 'LONG' ? -1 : 1) * rules.initialStopPct / 100), 0],
                    ['盈利达到 +5%', '止损提高至 +2%', entry * (trendSide === 'LONG' ? 1.02 : .98), 1],
                    ['盈利达到 +8%', '止损提高至 +5%', entry * (trendSide === 'LONG' ? 1.05 : .95), 2],
                    ['后续每 +3% 升一档', '+11% → +8%，+14% → +11%', entry * (trendSide === 'LONG' ? 1.08 : .92), 3],
                  ].map(([title, subtitle, stopPrice, stage], index) => (
                    <div key={String(title)} className={`ladder-step ${stop.stage > Number(stage) ? 'done' : ''} ${stop.stage === Number(stage) ? 'active' : ''}`}>
                      <i>{stop.stage > Number(stage) ? <Check /> : index ? String(index + 1).padStart(2, '0') : '01'}</i><p><strong>{title}</strong><span>{subtitle}</span></p><b>{price(Number(stopPrice))}</b>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className="empty-state">{selected?.side === 'RANGE' ? '区间不足两格。请调小格距后应用参数。' : '当前候选没有通过全部硬条件。'}</p>}
          </section>

          <section className="panel risk-panel">
            <div className="panel-title"><div><CircleDollarSign /><span>风险预算</span></div><small>不代表亏损上限保证</small></div>
            <div className="risk-numbers">
              <div><span>账户权益</span><strong>{rules.accountEquity.toLocaleString()} U</strong></div><div><span>单笔风险</span><strong>{rules.riskPct.toFixed(2)}%</strong></div>
              <div><span>风险预算</span><strong>{risk.maxLoss.toFixed(2)} U</strong></div><div><span>计划名义仓位</span><strong>{selected?.side === 'RANGE' ? plan?.kind === 'LONG_GRID_PLAN' ? plan.notional?.toFixed(2) : '生成后计算' : selected?.side === 'NO_TRADE' ? '拒绝' : risk.notional.toFixed(2)} U</strong></div>
              <div><span>估算保证金</span><strong>{selected?.side === 'RANGE' ? plan?.kind === 'LONG_GRID_PLAN' ? plan.margin?.toFixed(2) : '生成后计算' : selected?.side === 'NO_TRADE' ? '—' : risk.margin.toFixed(2)} U</strong></div><div><span>费用/滑点预留</span><strong>名义仓位 0.2%</strong></div>
            </div>
            <Button className="plan-button" onClick={() => { try { stagePlan(); } catch (cause) { setError((cause as Error).message); } }} disabled={!selected || selected.side === 'NO_TRADE' || running || stale || draftChanged}><Bot />{plan ? '计划草稿已生成' : '生成交易计划草稿'}<ChevronRight /></Button>
            <p className="confirm-note"><LockKeyhole /> 当前默认单笔风险为账户权益 10%，属于激进设置。预算含 0.2% 示例成本预留，不含资金费、跳空与极端滑点；实际亏损仍可能超过预算。无下单功能。</p>
            {plan && <details className="plan-details"><summary>{plan.kind} · DRAFT ONLY</summary><pre>{JSON.stringify(plan, null, 2)}</pre></details>}
          </section>
        </aside>
      </div>

      <section className="trace-panel panel">
        <div className="panel-title"><div><Bot /><span>可追溯 Agent 工作流</span></div><Button variant="ghost" size="sm" onClick={downloadPlan}><Download />导出JSON</Button></div>
        <div className="trace-flow">
          {trace.map((item, index) => <div key={item}><i>{String(index + 1).padStart(2, '0')}</i><span>{item}</span>{index < trace.length - 1 && <ChevronRight />}</div>)}
        </div>
        {paper && <details className="plan-details"><summary>阶梯模拟事件 · {paper.status}</summary><ol>{paper.events.map((event, index) => <li key={index}>{event}</li>)}</ol></details>}
        <p><strong>连接边界：</strong>网页公开行情通过 Binance Futures REST 读取，并可自动运行 PAPER 趋势/网格状态机。MCP 监督执行仅生成带真实持仓参数的待确认改单指令；网页不持有账户授权。Binance MCP 的每次实盘写操作仍需用户确认并读回核验。</p>
      </section>

      <footer><span>Binance Agent OS 工作流原型</span><span>只读选币 · PAPER 自动化 · MCP 监督确认</span><span>非投资建议 · 无盈利保证</span></footer>
    </main>
  );
}
