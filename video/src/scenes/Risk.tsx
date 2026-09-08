import { useCurrentFrame } from "remotion";
import { C, Heading, Label, type SceneProps } from "../SceneShell";
import data from "../data.json";
export const Risk = ({ scene }: SceneProps) => {
  const f = useCurrentFrame();
  return (
    <>
      <Heading note="默认示例 · 初始止损 10% · 成本预留 0.2%">
        先定风险，再定仓位
      </Heading>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 36,
          marginTop: 45,
        }}
      >
        <div
          style={{
            padding: 42,
            background: "#111923",
            border: "1px solid #2d3947",
            borderRadius: 25,
          }}
        >
          <span style={{ fontSize: 36, color: C.muted }}>假设账户权益</span>
          <div style={{ fontSize: 108, fontWeight: 750, marginTop: 20 }}>
            10,000 <span style={{ fontSize: 52, color: C.muted }}>U</span>
          </div>
          <div style={{ fontSize: 43, color: C.gold, marginTop: 30 }}>
            × 0.5% 单笔风险
          </div>
        </div>
        <div
          style={{
            padding: 42,
            background: "#65d6a610",
            border: "1px solid #65d6a650",
            borderRadius: 25,
          }}
        >
          <span style={{ fontSize: 36, color: C.green }}>风险预算</span>
          <div
            style={{
              fontSize: 132,
              fontWeight: 750,
              color: C.green,
              lineHeight: 1.3,
            }}
          >
            50 <span style={{ fontSize: 52 }}>U</span>
          </div>
          <span style={{ fontSize: 30, color: C.muted }}>
            预算是规划目标，不保证亏损上限
          </span>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 50,
          alignItems: "center",
          marginTop: 40,
          opacity: f > scene.clips[1].from ? 1 : 0.55,
        }}
      >
        <Label>按止损距离反推仓位</Label>
        <span style={{ fontSize: 40 }}>
          名义仓位{" "}
          <strong style={{ color: C.gold }}>
            {data.risk.notional.toFixed(2)} U
          </strong>
        </span>
        <span style={{ fontSize: 32, color: C.muted }}>
          3× 估算保证金 {data.risk.margin.toFixed(2)} U
        </span>
      </div>
    </>
  );
};
