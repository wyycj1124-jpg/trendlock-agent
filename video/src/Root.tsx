import "./index.css";
import { Composition } from "remotion";
import { TrendLockVideo } from "./Composition";
import data from "./data.json";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TrendLockIntro"
        component={TrendLockVideo}
        durationInFrames={data.durationInFrames}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
