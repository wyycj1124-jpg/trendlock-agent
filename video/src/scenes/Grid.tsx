import { useCurrentFrame, interpolate } from "remotion";
import { C, Heading, Label, type SceneProps } from "../SceneShell";
import data from "../data.json";
export const Grid = ({ scene }: SceneProps) => {
  const f = useCurrentFrame();
  const phase = f > scene.clips[2].from;
  const g = data.grid!;
  const times = Array.from(
    { length: 9 },
    (_, i) => (i * (scene.durationInFrames - 1)) / 8,
  );
  const markerX = interpolate(
    f,
    times,
    [75, 180, 280, 390, 490, 600, 720, 840, 1000],
  );
  const markerY = interpolate(
    f,
    times,
    [250, 150, 285, 180, 345, 150, 300, 175, 280],
  );
  return (
    <>
      <Heading note="识别 RANGE 后，生成一套新的做多网格计划">
        震荡，进入独立网格
      </Heading>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: 40,
          marginTop: 32,
        }}
      >
        <div
          style={{
            background: "#111923",
            border: "1px solid #2c3946",
            borderRadius: 25,
            padding: 22,
          }}
        >
          <svg viewBox="0 0 1100 460" style={{ width: "100%", height: 380 }}>
            {[90, 180, 270, 360].map((y, i) => (
              <g key={y}>
                <path d={`M30 ${y}H1050`} stroke={C.blue} strokeWidth="2" />
                <text x="45" y={y - 15} fontSize="28" fill={C.blue}>
                  网格 {4 - i}
                </text>
              </g>
            ))}
            <path
              d="M30 35H1050 M30 420H1050"
              stroke={C.red}
              strokeWidth="3"
              strokeDasharray="10 8"
            />
            <path
              d="M75 250 180 150 280 285 390 180 490 345 600 150 720 300 840 175 1000 280"
              fill="none"
              stroke={C.gold}
              strokeWidth="6"
            />
            <circle cx={markerX} cy={markerY} r="11" fill={C.gold} />
            <text x="775" y="447" fontSize="25" fill={C.red}>
              区间外：硬退出
            </text>
          </svg>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Label color={C.blue}>独立做多 · 计划草稿</Label>
          <div
            style={{
              background: "#111923",
              borderRadius: 22,
              padding: 24,
              fontSize: 34,
              lineHeight: 1.7,
            }}
          >
            区间：{g.lower.toFixed(4)}—{g.upper.toFixed(4)}
            <br />
            实际格距：{g.stepPct.toFixed(2)}%<br />
            独立风险预算
          </div>
          <div
            style={{
              padding: 22,
              fontSize: 35,
              lineHeight: 1.4,
              borderRadius: 20,
              border: `1px solid ${phase ? C.gold : C.border}`,
              color: phase ? C.gold : C.muted,
            }}
          >
            亏损趋势仓位
            <br />
            不会转为网格补仓
          </div>
        </div>
      </div>
      <p style={{ color: C.muted, fontSize: 27, marginTop: 24 }}>
        区间线条为示意；参数来自合成 DOGE 行情的同一规则引擎
      </p>
    </>
  );
};
