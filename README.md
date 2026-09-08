# TrendLock Agent · 趋势锁盈智能体

TrendLock 是为 Binance Agent OS Mini Hackathon 制作的只读合约决策原型。它扫描流动性靠前的 USDⓈ-M 山寨币永续合约，把市场分为 `LONG`、`SHORT`、`RANGE` 或 `NO_TRADE`，再用确定性规则计算仓位预算、趋势保护阶梯或独立做多网格草稿。

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
- 网页内阶梯止损沙盒、计划 JSON 导出，以及 3 个页面级 WebMCP 工具。

## 明确边界

这个版本没有连接账户、没有测试网或实盘下单、没有常驻监控，也没有完成 Binance MCP 的真实连接验证。导入文件里的 `transport: MCP` 是提供方声明，界面始终显示“未验签”。它不提供收益率、胜率、回测或盈利保证。

官方 Binance MCP 支持市场数据、账户和交易，但交易/转账需要用户逐次确认，且运行在专用 Agentic 子账户。TrendLock 今晚版只使用读路径的产品设计，不请求账户或交易权限。

## 本地运行

需要 Node.js 22.13 以上。

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

## License

MIT，见 `LICENSE`。本项目不构成投资建议。
