# TrendLock Agent 中文介绍视频

102 秒，1920×1080，30 fps；中文合成配音和同步烧录字幕。成片见[发布页](https://github.com/wyycj1124-jpg/trendlock-agent/releases/tag/v0.1.0)。

## 预览与导出

在本目录执行：

```bash
npm ci
npx remotion studio --no-open
npx remotion render TrendLockIntro out/trendlock-intro-zh.mp4 --codec=h264 --crf=19
```

预览路径为启动地址下的 `/TrendLockIntro`。`src/scenes/` 的七个场景可独立修改，`script.json` 保存中文解说词。`public/trendlock-zh.srt` 为可导入剪辑软件的字幕。

## 内容与数据来源

- 阶梯止损、风险预算和网格参数由 `prepare.mjs` 调用仓库内同一规则引擎生成，保存在 `src/data.json`。
- 行情和交易路径是明确标注的合成示例，不是实盘录像、回测结果或收益证明。
- 片尾的 `public/screens/workbench.png` 是公开演示站的实际界面截图。
- 配音为 macOS Tingting 合成语音；已提供 WAV，无需外部密钥即可渲染。
- 网页 WebMCP 不等于 Binance MCP；本版本没有账户连接、真实下单或 Binance MCP 实连验证。

## 修改解说后重新生成

需要 macOS 的 `say`、`afinfo`，以及 Node.js 22.18+（推荐 24）：

```bash
node prepare.mjs
```

该命令重新生成配音、逐句字幕、场景时长和演示数据，之后重新导出视频即可。其他系统可直接使用仓库自带素材。

## 许可

本项目原创代码遵循仓库根目录 MIT 许可；Remotion 及其他依赖遵循各自许可。合成语音使用本地系统提供的声音，第三方声音与品牌权利不由本项目授予。
