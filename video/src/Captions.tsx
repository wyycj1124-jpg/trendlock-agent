import type { Caption } from "@remotion/captions";
import { useCurrentFrame } from "remotion";
import type { Scene } from "./SceneShell";
export const Captions = ({ scene }: { scene: Scene }) => {
  const ms = (useCurrentFrame() / 30) * 1000;
  const caption: Caption | undefined = scene.clips.find(
    (c) => ms >= c.startMs && ms < c.endMs,
  );
  return (
    <div
      style={{
        position: "absolute",
        bottom: 45,
        left: 140,
        right: 140,
        minHeight: 86,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        fontSize: 42,
        lineHeight: 1.5,
        fontWeight: 550,
        color: "#f4f6f9",
        textShadow: "0 2px 5px #000",
      }}
    >
      {caption?.text}
    </div>
  );
};
