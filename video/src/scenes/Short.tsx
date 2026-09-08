import { useCurrentFrame, interpolate } from "remotion";
import { C, Heading, Label, type SceneProps } from "../SceneShell";
export const Short = ({ scene }: SceneProps) => {
  const f = useCurrentFrame();
  return (
    <>
      <Heading note="价格下跌，是空头的有利方向">做空，同样适用</Heading>
      <div
        style={{
          display: "flex",
          gap: 36,
          marginTop: 70,
          alignItems: "center",
        }}
      >
        {[
          ["开仓均价", "100", C.white],
          ["价格下跌至", "95", C.red],
          ["保护价降至", "98", C.green],
        ].map(([label, value, color], i) => (
          <div
            key={label}
            style={{
              flex: 1,
              background: "#111923",
              border: `1px solid ${color}55`,
              borderRadius: 26,
              padding: "40px 35px",
              opacity: interpolate(f, [i * 14, i * 14 + 20], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            }}
          >
            <span style={{ fontSize: 35, color: C.muted }}>{label}</span>
            <div
              style={{ fontSize: 142, color, fontWeight: 750, marginTop: 22 }}
            >
              {value}
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 50,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Label color={C.green}>有利变化 +5% → 保护目标 +2%</Label>
        <span
          style={{
            fontSize: 38,
            color: f > scene.clips[2].from ? C.gold : C.muted,
          }}
        >
          以开仓均价为基准，非杠杆 ROE
        </span>
      </div>
    </>
  );
};
