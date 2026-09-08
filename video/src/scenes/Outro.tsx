import {
  useCurrentFrame,
  interpolate,
  Interactive,
  Img,
  staticFile,
} from "remotion";
import { C, Label, type SceneProps } from "../SceneShell";
import data from "../data.json";
export const Outro = ({ scene }: SceneProps) => {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateColumns: "1fr 490px",
        gap: 64,
        alignItems: "center",
      }}
    >
      <div>
        <Label>现已可体验 · 只读原型</Label>
        <Interactive.Div
          name="产品名称"
          style={{
            fontSize: 120,
            fontWeight: 800,
            letterSpacing: 2,
            marginTop: 20,
          }}
        >
          TREND<span style={{ color: C.gold }}>LOCK</span>
        </Interactive.Div>
        <div style={{ fontSize: 55, marginTop: 12 }}>
          从机会，到可执行的纪律。
        </div>
        <div
          style={{
            display: "flex",
            gap: 20,
            marginTop: 42,
            alignItems: "center",
            fontSize: 36,
          }}
        >
          {["选币证据", "风险计划", "阶梯保护"].map((x, i) => (
            <div
              key={x}
              style={{
                color: i === 2 ? C.gold : C.white,
                opacity: interpolate(f, [i * 12, i * 12 + 18], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            >
              {i > 0 && (
                <span style={{ marginRight: 20, color: C.muted }}>→</span>
              )}
              {x}
            </div>
          ))}
        </div>
        <div
          style={{
            fontSize: 31,
            color: C.gold,
            marginTop: 44,
            overflowWrap: "anywhere",
          }}
        >
          {data.site.replace("https://", "")}
        </div>
        <div style={{ fontSize: 27, color: C.muted, marginTop: 14 }}>
          {data.github
            ? data.github.replace("https://", "")
            : "源码与演示链接见作品说明"}
        </div>
        <div
          style={{
            fontSize: 27,
            color: C.muted,
            marginTop: 30,
            opacity: f > scene.clips[1].from ? 1 : 0.5,
          }}
        >
          网页尚未直连 Binance MCP
          <br />
          未开放实盘 · 无盈利保证
        </div>
      </div>
      <div
        style={{
          position: "relative",
          height: 650,
          border: "1px solid #4a4129",
          borderRadius: 26,
          overflow: "hidden",
          boxShadow: "0 30px 100px #000",
        }}
      >
        <Img
          src={staticFile("screens/workbench.png")}
          style={{ width: "100%" }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: 20,
            fontSize: 28,
            color: C.gold,
            background: "#10151fee",
            textAlign: "center",
          }}
        >
          实际产品界面
        </div>
      </div>
    </div>
  );
};
