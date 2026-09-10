# TrendLock 本地自动化核心

这个核心是独立 Node.js 常驻服务，不通过 Binance MCP 发起交易，也不调用大模型。5 秒持仓监控、阶梯判断和改单都由确定性代码完成，因此不会持续消耗 Codex token。模型只在你主动分析日志或另行创建每日摘要通知时使用。

## 当前完成范围

- `DRY_RUN` 默认模式，无密钥、无真实交易。
- `TESTNET` 与 `LIVE` 使用 Binance USDⓈ-M REST API；实盘需要精确的风险解锁字符串。
- 每根新收盘的 1 小时 K 线最多做一次全市场扫描，评分低于 90 不开仓。
- 最多两个不同交易对；组合风险 10%，每槽固定最多 5%，空槽不会把另一单放大到 10%。
- 只执行趋势 `LONG` / `SHORT`，逐仓、最高 3 倍杠杆。
- 市场成交后必须读回真实持仓均价，再创建并读回 `MARK_PRICE`、`closePosition=true` 的 `STOP_MARKET` 服务器保护单。
- 初始保护 −7%；+5% 锁 +2%，+8% 锁 +5%，+11% 锁 +8%；+15% 后使用 `clamp(1.5 × 1h ATR, 5%, 8%)` 的宽幅追踪且至少锁 +10%。
- 改单严格先建新保护并验证，再撤旧保护；新保护失败时保留旧保护。
- 新仓无法获得保护、已有保护异常消失、或应有止损已被价格越过时，尝试紧急减仓平仓并熔断。
- 原子状态文件、追加式审计日志、重启恢复、当日权益回撤熔断、连续亏损推定熔断与本地 Markdown 日报。

`RANGE` 网格暂不自动下单。官方条件单和普通订单无法单独保证一组网格在部分成交、重启和上下边界突破时始终正确对账；在这套闭环完成前，核心会明确拒绝网格候选。

## 安全边界

程序不会接管启动前已经存在的人工或 MCP 仓位。未知仓位只占用槽位并写入警告；只有本地持久化意图和 `TL…` 客户端订单标识能够对上的仓位才会被管理。

程序不转账、不提现、不修改全账户持仓模式，也不绕过币安的地区限制。API Key 应只启用合约交易，不启用提现，并使用 Binance 支持的 IP 白名单。所有密钥只放在本机未跟踪环境中，绝不能发到聊天、GitHub、截图或网页。

初始止损和风险预算都不是最大亏损保证。跳空、滑点、流动性枯竭、强平、API 故障和交易所异常都可能让实际损失更大。

## 第一步：本地无资金验证

需要 Node.js 22.18 或更高版本：

```bash
npm ci
npm run daemon:smoke
npm run daemon:doctor
```

`daemon:smoke` 使用临时目录跑完整的合成开仓、保护和 +5% 阶梯改单；结束后删除临时数据。`daemon:doctor` 默认只显示 DRY_RUN 配置和模拟账户摘要。

若要让 DRY_RUN 使用公开行情进行一次扫描：

```bash
npm run daemon:once -- --force-scan
```

当前网络若被 Binance 返回 HTTP 451，程序记录失败并停止该轮，不会尝试规避限制。

## 第二步：测试网

在 Binance 官方 Demo/Testnet 创建单独 API Key，并把以下内容放进本机、被 Git 忽略的 `.env.local` 或进程管理器。Node 本身不会自动读取 `.env.local`，可以用 shell 安全地导入；不要把真实值写进仓库示例。

```bash
export TRENDLOCK_MODE=TESTNET
export BINANCE_API_KEY='仅本机测试网 key'
export BINANCE_SECRET_KEY='仅本机测试网 secret'
npm run daemon:doctor
npm run daemon:once -- --force-scan
```

先在 Demo/Testnet 检查：实际持仓方向、逐仓模式、3 倍杠杆、全仓位服务器止损、改单顺序和重启恢复都符合预期，再考虑实盘。测试网不可用或接口不支持新 Algo Order 时，核心会失败关闭。

测试账户清空持仓与所有挂单后，可以运行一次受限闭环探针。它仅允许 `TESTNET`，默认用不超过 50 USDT 名义价值的 ETHUSDT 多单，验证真实成交读回、−7% 服务器保护、先建 −5% 新保护再撤旧保护、主动平仓和测试单清理：

```bash
export TRENDLOCK_TESTNET_PROBE_ACK='I_ACCEPT_TESTNET_ORDER_PROBE'
npm run daemon:probe
unset TRENDLOCK_TESTNET_PROBE_ACK
```

探针开始前要求账户完全无持仓、无普通挂单、无 Algo 单。任一步骤失败都会尝试只清理 `TLP` 标识的测试仓位和测试保护；若平仓无法确认，则保留服务器保护并要求人工核对。

## 第三步：实盘解锁

实盘不应直接从 50 USDT 开始之前跳过测试网。确认账户、API 权限、IP 白名单和策略风险后，才在本机设置：

```bash
export TRENDLOCK_MODE=LIVE
export BINANCE_API_KEY='仅本机实盘 key'
export BINANCE_SECRET_KEY='仅本机实盘 secret'
export TRENDLOCK_LIVE_ACK='I_ACCEPT_AUTONOMOUS_FUTURES_RISK'
npm run daemon:doctor
```

`doctor` 只读账户，不下单。确认摘要无误后，`npm run daemon:once -- --force-scan` 才会运行一轮；`npm run daemon:start` 才会常驻。

停止常驻服务使用 `Ctrl+C`。停止程序不会撤销已经在币安服务器上的保护单。电脑休眠或断网时不会继续提高止损，但最后一个已核验保护仍留在交易所。

发生熔断后不要删除状态文件或直接重新启动。先在币安核对真实持仓、普通委托和 Algo 保护单；确认一致后才可显式恢复：

```bash
export TRENDLOCK_RESUME_ACK='I_HAVE_RECONCILED_ACCOUNT'
npm run daemon:resume
unset TRENDLOCK_RESUME_ACK
```

恢复命令仍会重新读取账户。若数量、均价或保护不一致，它会再次熔断；缺少保护的托管仓位会进入紧急平仓流程。

## 状态与日报

默认数据位于 `.trendlock/`：

- `state.json`：原子写入的恢复状态；
- `audit.jsonl`：追加式审计事件；
- `reports/YYYY-MM-DD.md`：本地确定性日报。

生成当前日报：

```bash
npm run daemon:report
```

守护进程只生成本地报告，不会自行把消息发到手机。等测试网闭环通过后，可以再创建每天一次的 Codex 通知任务，只读取日报并推送摘要；这才会每天消耗一次少量模型用量。

## 尚未纳入实盘策略的项目

- 自动合约网格与其逐笔成交对账；
- “持仓评分下降后提前平仓”的亏损中途退出规则；
- WebSocket 用户数据流（当前核心以 REST 对账，5 秒一轮；后续用用户流降低延迟和权重）；
- 自动手机推送和无需人工查看的服务托管安装。

这些功能不会以默认关闭的隐藏逻辑进入实盘。每项都必须先有可复现测试与故障策略。
