import { TransitionSeries } from "@remotion/transitions";
import { Intro } from "./scenes/Intro";
import { Scanner } from "./scenes/Scanner";
import { Ladder } from "./scenes/Ladder";
import { Short } from "./scenes/Short";
import { Risk } from "./scenes/Risk";
import { Grid } from "./scenes/Grid";
import { Outro } from "./scenes/Outro";
import { SceneShell } from "./SceneShell";
import data from "./data.json";

const scenes = [Intro, Scanner, Ladder, Short, Risk, Grid, Outro];
export const TrendLockVideo = () => (
  <TransitionSeries>
    {data.scenes.map((scene, index) => {
      const Content = scenes[index];
      return (
        <TransitionSeries.Sequence
          key={scene.id}
          name={scene.title}
          durationInFrames={scene.durationInFrames}
        >
          <SceneShell scene={scene} index={index}>
            <Content scene={scene} />
          </SceneShell>
        </TransitionSeries.Sequence>
      );
    })}
  </TransitionSeries>
);
