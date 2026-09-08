import { useCurrentFrame, interpolate } from "remotion";
import { C, Heading, Label, type SceneProps } from "../SceneShell";
import data from "../data.json";
export const Scanner = ({ scene }: SceneProps) => {
  const f = useCurrentFrame();
  const rows = [
    data.markets.find((x) => x.side === "LONG")!,
    data.markets.find((x) => x.side === "SHORT")!,
    data.markets.find((x) => x.side === "RANGE")!,
    data.markets.find((x) => x.side === "NO_TRADE")!,
  ];
  return (
    <>
      <Heading note="已收盘数据 → 规则核验 → 市况分类">
        先找证据，再选方向
      </Heading>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.15fr 1fr",
          gap: 42,
          marginTop: 26,
        }}
      >
        <div style={{ display: "grid", gap: 18 }}>
          {rows.map((row, i) => (
            <div
              key={row.symbol}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 24,
                background: "#111820",
                border: "1px solid #2a3540",
                borderRadius: 18,
                padding: "18px 28px",
                opacity: interpolate(f, [i * 8, i * 8 + 18], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            >
              <Label
                color={
                  row.side === "SHORT"
                    ? C.red
                    : row.side === "RANGE"
                      ? C.blue
                      : row.side === "NO_TRADE"
                        ? C.muted
                        : C.green
                }
              >
                {row.side}
              </Label>
              <strong style={{ fontSize: 42 }}>
                {row.symbol.replace("USDT", "")}
              </strong>
              <span
                style={{ fontSize: 27, color: C.muted, marginLeft: "auto" }}
              >
                {row.side === "NO_TRADE"
                  ? "价差超限 · 拒绝"
                  : row.side === "RANGE"
                    ? "均线收敛 · 震荡"
                    : row.side === "SHORT"
                      ? "空头结构"
                      : "多头结构"}
              </span>
            </div>
          ))}
        </div>
        <div
          style={{
            padding: 30,
            border: "1px solid #443c22",
            borderRadius: 22,
            background: "linear-gradient(140deg,#f2ba3811,#10151d)",
          }}
        >
          <div style={{ fontSize: 38, color: C.gold, marginBottom: 20 }}>
            每个结论都能解释
          </div>
          {[
            "已收盘 K 线",
            "成交量与流动性",
            "买卖价差",
            "通过条件 / 拒绝原因",
          ].map((text, i) => (
            <div
              key={text}
              style={{
                fontSize: 38,
                margin: "18px 0",
                display: "flex",
                gap: 20,
                opacity: f > scene.clips[1].from + i * 8 ? 1 : 0.5,
              }}
            >
              <span style={{ color: C.green }}>✓</span>
              {text}
            </div>
          ))}
        </div>
      </div>
      <p style={{ fontSize: 28, color: C.muted, marginTop: 22 }}>
        本画面使用合成行情 · 评分只用于证据排序，不代表胜率
      </p>
    </>
  );
};
