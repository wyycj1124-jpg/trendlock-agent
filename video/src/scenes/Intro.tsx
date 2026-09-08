import { interpolate, useCurrentFrame, Interactive } from "remotion";
import { C, Label, type SceneProps } from "../SceneShell";
export const Intro = ({ scene }: SceneProps) => {
  const f = useCurrentFrame();
  const phase = f >= scene.clips[2].from;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.12fr 1fr",
        gap: 70,
        height: "100%",
        alignItems: "center",
      }}
    >
      <div>
        <Label>从一次真实的交易痛点出发</Label>
        <Interactive.Div
          name="主标题"
          style={{
            fontSize: 106,
            lineHeight: 1.14,
            fontWeight: 800,
            marginTop: 28,
          }}
        >
          盈利之后，
          <br />
          <span style={{ color: C.gold }}>保护要跟上。</span>
        </Interactive.Div>
        <p
          style={{
            fontSize: 40,
            lineHeight: 1.6,
            color: C.muted,
            marginTop: 30,
          }}
        >
          把你的锁盈纪律
          <br />
          写进智能体的每一步。
        </p>
      </div>
      <div
        style={{
          border: "1px solid #35352a",
          borderRadius: 30,
          padding: 44,
          background: "#10161d",
          translate: interpolate(f, [0, 20], ["50px 0px", "0px 0px"], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 30,
            color: C.muted,
          }}
        >
          <span>同一笔仓位</span>
          <span>价格变化 · 示意</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 28,
            marginTop: 28,
          }}
        >
          <span style={{ fontSize: 92, fontWeight: 750, color: C.green }}>
            +5%
          </span>
          <span style={{ fontSize: 52, color: C.muted }}>→</span>
          <span style={{ fontSize: 92, fontWeight: 750, color: C.red }}>
            −10%
          </span>
        </div>
        <svg
          viewBox="0 0 620 220"
          style={{ width: "100%", height: 220, marginTop: 22 }}
        >
          <path
            d="M0 145H620 M0 60H620"
            stroke="#2f3945"
            strokeDasharray="5 8"
          />
          <path
            d="M0 145 70 120 110 140 200 55 270 20 330 66 390 95 440 150 520 173 620 218"
            fill="none"
            stroke={phase ? C.gold : C.red}
            strokeWidth="6"
            strokeDasharray="950"
            strokeDashoffset={interpolate(f, [10, 160], [950, 0], {
              extrapolateRight: "clamp",
            })}
          />
          {phase && (
            <path
              d="M270 72H620"
              stroke={C.green}
              strokeWidth="4"
              strokeDasharray="12 8"
            />
          )}
        </svg>
        <div
          style={{
            fontSize: 36,
            marginTop: 22,
            color: phase ? C.green : C.muted,
          }}
        >
          {phase ? "让保护价随盈利逐档提高" : "利润回吐，甚至转成亏损"}
        </div>
      </div>
    </div>
  );
};
