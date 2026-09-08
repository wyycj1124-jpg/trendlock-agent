import { useCurrentFrame, interpolate } from "remotion";
import { C, Heading, Label, type SceneProps } from "../SceneShell";
import data from "../data.json";
export const Ladder = ({ scene }: SceneProps) => {
  const f = useCurrentFrame();
  const stages = scene.clips.map((c) => c.from + 20);
  let index = 0;
  for (let i = 0; i < stages.length; i++) if (f >= stages[i]) index = i;
  const state = data.steps[Math.min(index, 4)];
  const stop = state.stop.stopPrice;
  const mark = state.stop.mark;
  const y = (v: number) => 430 - ((v - 88) / 26) * 380;
  const points = [
    { x: 70, v: 100 },
    { x: 300, v: 105 },
    { x: 530, v: 108 },
    { x: 760, v: 111 },
    { x: 980, v: 108 },
  ];
  const shown = points.slice(0, index + 1);
  return (
    <>
      <Heading note="做多示例 · 开仓均价 100 · 相对价格涨跌幅">
        保护价，逐档向前
      </Heading>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.55fr .8fr",
          gap: 44,
          marginTop: 24,
        }}
      >
        <div
          style={{
            background: "#0e151d",
            border: "1px solid #2c3844",
            borderRadius: 24,
            padding: 24,
          }}
        >
          <svg viewBox="0 0 1100 500" style={{ width: "100%", height: 430 }}>
            {[90, 100, 105, 108, 111].map((v) => (
              <g key={v}>
                <path
                  d={`M25 ${y(v)}H1010`}
                  stroke="#293542"
                  strokeDasharray="6 9"
                />
                <text x="1030" y={y(v) + 9} fontSize="27" fill={C.muted}>
                  {v}
                </text>
              </g>
            ))}
            <polyline
              points={shown.map((p) => `${p.x},${y(p.v)}`).join(" ")}
              fill="none"
              stroke={C.gold}
              strokeWidth="8"
              strokeLinejoin="round"
            />
            {shown.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={y(p.v)}
                r={i === index ? 11 : 7}
                fill={C.gold}
              />
            ))}
            <path
              d={`M60 ${y(stop)}H1010`}
              stroke={C.green}
              strokeWidth="5"
              strokeDasharray="14 8"
            />
            <text x="75" y={y(stop) - 18} fontSize="29" fill={C.green}>
              保护价 {stop.toFixed(0)}
            </text>
            <text x="75" y="490" fontSize="27" fill={C.muted}>
              100 → 105 → 108 → 111 → 回撤 108
            </text>
          </svg>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Label color={state.status === "STOP_TRIGGERED" ? C.green : C.gold}>
            {state.status === "STOP_TRIGGERED"
              ? "触及保护 · 模拟退出"
              : "规则引擎计算结果"}
          </Label>
          <div style={{ padding: 22, borderRadius: 20, background: "#161d25" }}>
            <span style={{ fontSize: 30, color: C.muted }}>模拟价格</span>
            <div style={{ fontSize: 80, fontWeight: 750, lineHeight: 1.1 }}>
              {mark.toFixed(0)}
            </div>
          </div>
          <div
            style={{
              padding: 22,
              borderRadius: 20,
              background: "#65d6a612",
              border: "1px solid #65d6a650",
              scale: interpolate(
                f,
                [stages[index], stages[index] + 8, stages[index] + 18],
                [1, 1.03, 1],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
              ),
            }}
          >
            <span style={{ fontSize: 30, color: C.green }}>保护目标</span>
            <div
              style={{
                fontSize: 72,
                lineHeight: 1.1,
                fontWeight: 750,
                color: C.green,
              }}
            >
              {state.stop.stopReturnPct >= 0 ? "+" : ""}
              {Math.round(state.stop.stopReturnPct)}%
            </div>
          </div>
          <span style={{ fontSize: 25, lineHeight: 1.3, color: C.muted }}>
            只收紧，不回退
            <br />
            实际成交仍受滑点影响
          </span>
        </div>
      </div>
    </>
  );
};
