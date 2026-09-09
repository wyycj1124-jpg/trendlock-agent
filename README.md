# TrendLock Agent · 趋势锁盈智能体

TrendLock 是为 Binance Agent OS Mini Hackathon 制作的合约决策与 PAPER 自动化原型。它扫描流动性靠前的 USDⓈ-M 山寨币永续合约，把市场分为 `LONG`、`SHORT`、`RANGE` 或 `NO_TRADE`，再用确定性规则计算仓位预算、自动运行趋势保护阶梯或独立做多网格模拟。

[公开体验](https://trendlock-agent.jacksonning.chatgpt.site) · [中文演示视频与下载](https://github.com/wyycj1124-jpg/trendlock-agent/releases/tag/v0.1.0) · [提交文案](SUBMISSION.md)

[![TrendLock 中文演示视频](video/public/cover.png)](https://github.com/wyycj1124-jpg/trendlock-agent/releases/download/v0.1.0/trendlock-intro-zh.mp4)

它解决的不是“AI 猜涨跌”，而是持仓一度盈利却没及时移动止损、最后把利润全部吐回的问题。所有百分比相对真实加权开仓均价，而不是杠杆后的仓位收益率：

- 初始保护 −10%；
- 有利变化达到 +5% 后保护 +2%；
- 达到 +8% 后保护 +5%；
- 后续每增加 3 个百分点，提高一档：+11% → +8%、+14% → +11%；
- 多空镜像，保护价只能收紧、不能放松；价格回撤越过旧保护线后，模拟仓位关闭且不会自动恢复。

## 今晚版本能做什么

- 可复现的合成演示，覆盖多、空、震荡和拒绝四种状态。
- 公开 Binance Futures REST 行情扫描；受 Binance 地区规则和网络可用性影响。
- 导入由 Binance MCP 或官方 `binance` skill 采集的原始行情 JSON，并在本地重新计算，不信任外部评分。
- 只使用已收盘且连续、未过期的 K 线；缺资金费率、异常盘口、过期数据或硬规则失败都会拒绝。
- 趋势仓位按账户风险预算计算；0.2% 名义仓位成本预留只是示例，不是最大亏损保证。
- `RANGE` 只生成独立做多网格草稿；它不会把亏损趋势仓位变成网格。
- 网页内阶梯止损沙盒、计划 JSON 导出，以及 5 个页面级 WebMCP 工具。
- PAPER 自动化：合成行情自动播放，或每 5 秒读取 Binance 公开标记价格，自动推进趋势止损和网格成交状态。
- MCP 监督执行：录入 MCP 读回的真实成交均价、数量和现有服务器止损后，每 5 秒监控该持仓交易对；触发阶梯时生成待确认改单指令，用户执行并读回核验后才更新本地状态。
- 自动化状态保存在当前浏览器；刷新或离开页面后恢复为 `HALTED`，不会悄悄续跑。
- 行情超过 30 秒、连续三次取价失败、触及保护线或网格硬退出都会停止状态机并保留审计事件。

## 明确边界

网页版本没有直接连接账户，也没有测试网或实盘下单。PAPER 自动化只运行虚拟成交；MCP 监督执行只在浏览器本地保存用户录入的持仓状态并生成确认指令。浏览器页面关闭后不会后台常驻。导入文件里的 `transport: MCP` 是提供方声明，界面始终显示“未验签”。它不提供收益率、胜率、回测或盈利保证。

官方 Binance MCP 支持市场数据、账户和交易，但交易、撤单和转账需要用户逐次确认，且运行在专用 Agentic 子账户。TrendLock 不会绕过这层确认；MCP 实盘执行仍属于人工监督流程。

## 使用自动化试运行

1. 选择“合成演示”快速观察状态机，或选择“公开行情”后运行一次扫描。
2. 从机会队列选择一个通过全部硬条件的 `LONG`、`SHORT` 或 `RANGE` 候选。
3. 设置假设权益、单笔风险、杠杆和网格间距并应用参数。
4. 点击“启动 PAPER 自动化”。趋势模式会从模拟成交均价计算保护线；网格模式会自动记录虚拟买入、反弹卖出和硬退出。
5. 观察当前标记价格、保护价/已买入格数、浮动损益和最近事件。点击“停止并冻结”可随时终止。

公开行情自动化必须保持网页打开。要恢复一个刷新前仍在运行的实例，必须先核对持仓和挂单，再重新扫描并启动新的实例。

## 监督真实持仓

1. 在 Codex 中通过 Binance MCP 读取真实持仓、持仓模式和当前保护单，不要依赖页面计划值。
2. 在“MCP 监督执行”录入交易对、方向、`positionSide`、真实加权开仓均价、真实数量和已经挂在币安服务器上的止损。
3. 点击“开始监督监控”。页面只读取该交易对的公开标记价格，不读取账户。
4. 达到阶梯后，页面显示“待你确认改单”。复制指令到已经连接 Binance MCP 的 Codex 对话；先核验参数，再由你确认写操作。
5. 只有在 MCP 创建新保护、读回验证且正确处理旧保护后，才能点击“我已执行并读回核验”。如果确认前已经回撤越过请求的新止损，任务会废弃动作并要求对账。

这个网页监控器适合当前人工监督试行，不是 24/7 守护进程。现有保护单应始终由币安服务器托管；关页、休眠或断网时，旧保护仍在，但不会继续提高阶梯。完整架构和下一阶段见 [监督执行说明](docs/SUPERVISED_EXECUTION.md)。

## 本地运行

需要 Node.js 22.18 以上，推荐 Node.js 24。

```bash
npm ci
npm run dev
```

验证：

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Agent 数据工作流

项目内的 `agent-skill/trendlock-agent/` 是可分发的只读 Skill。已安装 Binance 官方 CLI 时，可选本地适配器只调用公开 GET 端点：

```bash
node scripts/collect-binance.ts SOLUSDT,LINKUSDT,DOGEUSDT 1h > evidence.json
node scripts/evaluate-evidence.ts evidence.json > analysis.json
```

也可以让已连接的 Binance MCP 按 `agent-skill/trendlock-agent/references/result-contract.md` 生成 `trendlock.market/v1`，再通过网页“导入 Agent 行情 JSON”。不要把 MCP 地址、授权链接、账户数据或密钥放进 JSON。

## 设计原则

AI/Agent 负责取数和提名；本仓库的确定性引擎负责规则、否决、风险预算与状态机。零候选是有效结果。低价币不等于低风险，价格跌得多也不等于处在低位。

本项目从 [Setup Radar](https://github.com/jian28277-hash/setup-radar) 获得“只读、证据优先、保留工具轨迹”的产品启发。参考仓库未提供许可证，因此本项目没有复制其代码或素材。

## 演示视频

`video/` 包含完整 Remotion 工程、中文配音、逐句字幕、实际产品截图和合成规则动画。成片为 1920×1080、30 fps、约 102 秒。动画里的风险与阶梯状态直接取自本仓库规则引擎；不是实盘录制或收益证明。

```bash
cd video
npm ci
npx remotion studio --no-open
npx remotion render TrendLockIntro out/trendlock-intro-zh.mp4
```

配音使用本地 macOS Tingting 合成语音。随仓库提供的 WAV 可直接在其他系统渲染；只有重新生成配音时才需要 macOS 的 `say` 和 `afinfo`。浏览器的 WebMCP 工具可读取、模拟、生成计划并启动/停止 PAPER 自动化；它们与 Binance MCP 账户连接是不同的能力。

## License

MIT，见 `LICENSE`。本项目不构成投资建议。
