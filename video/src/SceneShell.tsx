import React from "react";
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Audio } from "@remotion/media";
import { Captions } from "./Captions";
import data from "./data.json";

export type Scene = (typeof data.scenes)[number];
export type SceneProps = { scene: Scene };
export const C = {
  gold: "#F2BA38",
  green: "#65D6A6",
  red: "#F18491",
  blue: "#72B7FF",
  white: "#F4F6F9",
  muted: "#9EACBA",
  border: "#2B3440",
};
export const SceneShell: React.FC<{
  scene: Scene;
  index: number;
  children: React.ReactNode;
}> = ({ scene, index, children }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(ellipse at 82% 0%, #302a174d 0%, transparent 52%), #080b10",
        color: C.white,
        fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.3,
          backgroundImage:
            "linear-gradient(#202630 1px,transparent 1px),linear-gradient(90deg,#202630 1px,transparent 1px)",
          backgroundSize: "96px 96px",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 60,
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <svg width="48" height="54" viewBox="0 0 32 36">
          <path d="M16 2 29 7v11c0 8-13 16-13 16S3 26 3 18V7Z" fill={C.gold} />
          <path
            d="m9 17 5 5 10-11"
            stroke="#080b10"
            strokeWidth="3"
            fill="none"
          />
        </svg>
        <span style={{ fontSize: 34, letterSpacing: 4, fontWeight: 800 }}>
          TRENDLOCK
        </span>
        <span
          style={{
            fontSize: 26,
            color: C.muted,
            borderLeft: "1px solid #4a4a4a",
            paddingLeft: 20,
          }}
        >
          趋势锁盈智能体
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          right: 96,
          top: 70,
          fontSize: 26,
          color: C.muted,
        }}
      >
        BINANCE AGENT OS · 工作流原型
      </div>
      <div
        style={{
          position: "absolute",
          left: 96,
          right: 96,
          top: 158,
          bottom: 185,
          opacity: interpolate(
            frame,
            [0, 12, scene.durationInFrames - 9, scene.durationInFrames - 1],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          ),
          translate: interpolate(frame, [0, 15], ["0px 24px", "0px 0px"], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        {children}
      </div>
      <div
        style={{
          position: "absolute",
          left: 96,
          right: 96,
          bottom: 170,
          height: 2,
          background: "#27303a",
        }}
      >
        <div
          style={{
            height: 2,
            width: `${((index + frame / scene.durationInFrames) / 7) * 100}%`,
            background: C.gold,
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          right: 98,
          bottom: 185,
          fontSize: 24,
          color: C.muted,
        }}
      >
        0{index + 1} / 07
      </div>
      {scene.clips.map((clip) => (
        <Sequence
          key={clip.file}
          from={clip.from}
          durationInFrames={clip.durationInFrames}
        >
          <Audio src={staticFile(clip.file)} />
        </Sequence>
      ))}
      <Captions scene={scene} />
    </AbsoluteFill>
  );
};
export const Heading: React.FC<{
  children: React.ReactNode;
  note?: string;
}> = ({ children, note }) => (
  <>
    <h1
      style={{
        fontSize: 82,
        lineHeight: 1.18,
        fontWeight: 750,
        letterSpacing: -2,
        margin: "0 0 16px",
      }}
    >
      {children}
    </h1>
    {note && (
      <p style={{ fontSize: 34, color: C.muted, margin: "0 0 32px" }}>{note}</p>
    )}
  </>
);
export const Label: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = C.gold,
}) => (
  <span
    style={{
      display: "inline-block",
      fontSize: 27,
      color,
      padding: "9px 20px",
      border: `1px solid ${color}55`,
      borderRadius: 9,
      background: `${color}0D`,
    }}
  >
    {children}
  </span>
);
