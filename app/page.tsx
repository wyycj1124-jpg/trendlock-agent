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
  Download,
  Gauge,
  LockKeyhole,
  Radar,
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
import { scanFutures } from '@/lib/market';
import { importEvidence } from '@/lib/evidence';
import { advancePaper, stageCandidate, startPaper, type PaperState } from '@/lib/plans';

type Mode = 'demo' | 'live' | 'import';
type Draft = { accountEquity: string; riskPct: string; leverage: string; gridStepPct: string };
const draftOf = (rules: Rules): Draft => ({ accountEquity: String(rules.accountEquity), riskPct: String(rules.riskPct), leverage: String(rules.leverage), gridStepPct: String(rules.gridStepPct) });
const paperFor = (candidate?: Candidate, initialStop = 10) => candidate && (candidate.side === 'LONG' || candidate.side === 'SHORT') ? startPaper(candidate.side, candidate.price, initialStop) : null;

const price = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: value < 1 ? 6 : 2 });
const money = (value: number) => value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : `$${(value / 1e6).toFixed(1)}M`;

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
  const [prompt, setPrompt] = useState('扫描 1 小时 U 本位永续，识别趋势多空与震荡；单笔风险 0.5%，3 倍杠杆，网格 3%。');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: defaults.poolSize });
  const [error, setError] = useState('');
  const [asOf, setAsOf] = useState(demoTime);
  const [source, setSource] = useState('SYNTHETIC');
  const [stale, setStale] = useState(false);
  const [paper, setPaper] = useState<PaperState | null>(() => paperFor(rows[0]));
  const [plan, setPlan] = useState<ReturnType<typeof stageCandidate> | null>(null);
  const [agentEvidence, setAgentEvidence] = useState<ReturnType<typeof importEvidence> | null>(null);
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
  });

  useEffect(() => {
    if (source === 'SYNTHETIC') return;
    const checkAge = () => {
      if (Date.now() - asOf > 120_000 || asOf - Date.now() > 5_000) { setStale(true); setPlan(null); }
    };
    checkAge();
    const timer = setInterval(checkAge, 5_000);
    return () => clearInterval(timer);
  }, [asOf, source]);

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
        agentOs: agentEvidence?.agentOs ?? { verified: false, note: '未进行 Agent OS 连接验证' },
      }),
      simulate,
      stage: stagePlan,
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
    if (target === 'import') { importInput.current?.click(); return; }
    scanLock.current = true;
    setRunning(true);
    setError('');
    setPlan(null);
    try {
      const fromDraft = { ...rules, accountEquity: Number(draft.accountEquity), riskPct: Number(draft.riskPct), leverage: Number(draft.leverage), gridStepPct: Number(draft.gridStepPct) };
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
      const next = parseIntent('', { ...rules, accountEquity: Number(draft.accountEquity), riskPct: Number(draft.riskPct), leverage: Number(draft.leverage), gridStepPct: Number(draft.gridStepPct) });
      setRules(next); setDraft(draftOf(next)); setPlan(null); setError('');
      setPrompt(`扫描 ${next.interval} 趋势与震荡；单笔风险 ${next.riskPct}%，${next.leverage} 倍杠杆，网格 ${next.gridStepPct}%。`);
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
          <span className="status-pill">AGENT OS · 待连接验证</span>
          <span className="status-pill muted"><LockKeyhole /> 不连接账户 · 不下单</span>
        </nav>
      </header>

      <section className="command-bar">
        <div className="mode-switch" aria-label="数据模式">
          <button disabled={running} className={mode === 'demo' ? 'active' : ''} onClick={() => void runScan('demo')}>合成演示</button>
          <button disabled={running} className={mode === 'live' ? 'active' : ''} onClick={() => void runScan('live')}>公开行情</button>
        </div>
        <div className="command-icon"><Sparkles /></div>
        <label htmlFor="agent-command" className="sr-only">输入智能体任务</label>
        <Input id="agent-command" value={prompt} disabled={running} onChange={(event) => setPrompt(event.target.value)} className="command-input" />
        <Button className="scan-button" onClick={() => void runScan()} disabled={running}>
          {running ? <RefreshCw className="spin" /> : <Radar />}{running ? `${progress.done}/${progress.total}` : '运行扫描'}
        </Button>
      </section>
      <div className="command-help">规则解析器支持周期、风险、杠杆、量比和格距；未接入大模型。修改文字后需重新扫描。<Button variant="ghost" size="sm" disabled={running || draftChanged} onClick={() => importInput.current?.click()}>导入 Agent 行情 JSON</Button><Input ref={importInput} className="hidden" type="file" accept="application/json,.json" aria-label="导入Agent原始行情" onChange={(event) => void uploadEvidence(event.target.files?.[0])} /></div>
      {error && <div className="error-banner" role="alert"><X />{error}</div>}
      <div className="source-banner"><span className={source === 'SYNTHETIC' ? 'demo-source' : 'live-source'}>{source}</span><span>{stamp}</span><span>{stale ? '证据已失效 · 禁止生成计划' : source === 'SYNTHETIC' ? '合成行情 · 非回测 · 非实时信号' : '行情快照 · 两分钟后失效'}</span></div>

      <section className="summary-strip" aria-label="扫描摘要">
        <div><Activity /><span>扫描池</span><strong>{String(rows.length).padStart(2, '0')}</strong><small>U本位永续</small></div>
        <div><ArrowUpRight /><span>趋势做多</span><strong>{String(counts.long).padStart(2, '0')}</strong><small>满足硬条件</small></div>
        <div><ArrowDownRight /><span>趋势做空</span><strong>{String(counts.short).padStart(2, '0')}</strong><small>满足硬条件</small></div>
        <div><Waves /><span>震荡候选</span><strong>{String(counts.range).padStart(2, '0')}</strong><small>仅生成网格计划</small></div>
        <div className="risk-ok"><ShieldCheck /><span>单笔预算</span><strong>{rules.riskPct.toFixed(2)}%</strong><small>风险预算 {risk.maxLoss.toFixed(0)} U</small></div>
      </section>

      <div className="workspace">
        <aside className="candidate-panel panel">
          <div className="panel-title"><div><Radar /><span>机会队列</span></div><small>按证据评分</small></div>
          <div className="candidate-list">
            {visibleRows.map((candidate) => (
              <button disabled={running} className={selected?.symbol === candidate.symbol ? 'candidate active' : 'candidate'} key={candidate.symbol} onClick={() => selectCandidate(candidate.symbol)}>
                <span className={`side ${candidate.side.toLowerCase()}`}>{candidate.side}</span>
                <span className="candidate-main"><strong>{candidate.symbol.replace('USDT', '')}<small>/USDT</small></strong><em>{candidate.reason}</em></span>
                <span className="candidate-score"><b>{candidate.score}</b><small>SCORE</small></span>
                <ChevronRight className="candidate-arrow" />
              </button>
            ))}
            {!visibleRows.length && <p className="empty-state">没有通过硬风控的候选。零结果也是有效结果。</p>}
          </div>
          <div className="rule-controls">
            <label htmlFor="equity">假设权益 U<Input disabled={running} id="equity" type="number" value={draft.accountEquity} min={1} onChange={(event) => updateRule('accountEquity', event.target.value)} /></label>
            <label htmlFor="risk-percent">单笔风险 %<Input disabled={running} id="risk-percent" type="number" value={draft.riskPct} min={0.05} max={5} step={0.05} onChange={(event) => updateRule('riskPct', event.target.value)} /></label>
            <label htmlFor="leverage">杠杆（上限 3）<Input disabled={running} id="leverage" type="number" value={draft.leverage} min={1} max={3} onChange={(event) => updateRule('leverage', event.target.value)} /></label>
            <label htmlFor="grid-step">网格间距 %<Input disabled={running} id="grid-step" type="number" value={draft.gridStepPct} min={0.2} max={10} step={0.1} onChange={(event) => updateRule('gridStepPct', event.target.value)} /></label>
            <Button className="apply-rules" variant="secondary" disabled={running || !draftChanged} onClick={applyDraft}>{draftChanged ? '应用参数' : '参数已应用'}</Button>
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
            <p className="confirm-note"><LockKeyhole /> 预算含 0.2% 示例成本预留，不含未知资金费与极端滑点；实际亏损可能超预算，杠杆仍有强平风险。无下单功能。</p>
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
        <p><strong>连接边界：</strong>网页公开行情通过 Binance Futures REST 读取；Agent 数据由本地只读适配器或已连接的 MCP 工具采集后导入。导入记录未经签名验证，不等于本页面完成了 Agent OS 连接。本版本没有实盘、测试网下单或自动常驻交易功能。</p>
      </section>

      <footer><span>Binance Agent OS 工作流原型</span><span>只读选币 · 风险规划 · 阶梯模拟</span><span>非投资建议 · 无盈利保证</span></footer>
    </main>
  );
}
