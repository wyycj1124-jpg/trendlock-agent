import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { defaults, calculateRisk, calculateGrid } from "../lib/engine.ts";
import { demoMarkets, demoTime } from "../lib/demo.ts";
import { startPaper, advancePaper } from "../lib/plans.ts";

const exec = promisify(execFile);
const script = JSON.parse(
  await readFile(new URL("./script.json", import.meta.url), "utf8"),
);
const voiceDir = new URL("./public/voice/", import.meta.url);
await mkdir(voiceDir, { recursive: true });
let globalFrame = 0;
const fps = 30;
const scenes = [];
for (const scene of script) {
  let sceneFrame = 15;
  const clips = [];
  for (const [index, text] of scene.lines.entries()) {
    const file = `${scene.id}-${index}.wav`;
    const path = fileURLToPath(new URL(file, voiceDir));
    await exec("say", [
      "-v",
      "Tingting",
      "-r",
      "225",
      "--file-format=WAVE",
      "--data-format=LEI16@48000",
      "-o",
      path,
      text,
    ]);
    const { stdout } = await exec("afinfo", [path]);
    const duration = Number(
      stdout.match(/estimated duration:\s*([\d.]+)/)?.[1],
    );
    if (!duration) throw new Error(`Unknown voice duration: ${file}`);
    const frames = Math.ceil(duration * fps);
    clips.push({
      file: `voice/${file}`,
      from: sceneFrame,
      durationInFrames: frames,
      text,
      startMs: (sceneFrame / fps) * 1000,
      endMs: ((sceneFrame + frames) / fps) * 1000,
      timestampMs: null,
      confidence: null,
    });
    sceneFrame += frames + 7;
  }
  const durationInFrames = sceneFrame + 20;
  scenes.push({
    id: scene.id,
    title: scene.title,
    from: globalFrame,
    durationInFrames,
    clips,
  });
  globalFrame += durationInFrames;
}
const markets = demoMarkets(defaults);
let state = startPaper("LONG", 100);
const steps = [0, 5, 8, 11, 8].map((pct) => {
  state = advancePaper(state, pct);
  return structuredClone(state);
});
const data = {
  fps,
  durationInFrames: globalFrame,
  scenes,
  markets,
  asOf: demoTime,
  risk: calculateRisk(defaults, 100),
  grid: calculateGrid(
    markets.find((x) => x.side === "RANGE"),
    3,
  ),
  steps,
  site: "https://trendlock-agent.jacksonning.chatgpt.site",
  github: "https://github.com/wyycj1124-jpg/trendlock-agent",
};
await writeFile(
  new URL("./src/data.json", import.meta.url),
  JSON.stringify(data, null, 2),
);
const toTime = (ms) => {
  const s = Math.round(ms);
  const h = Math.floor(s / 3600000);
  const m = Math.floor((s % 3600000) / 60000);
  const sec = Math.floor((s % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(s % 1000).padStart(3, "0")}`;
};
const captions = scenes.flatMap((scene) =>
  scene.clips.map((clip) => ({
    text: clip.text,
    startMs: (scene.from / fps) * 1000 + clip.startMs,
    endMs: (scene.from / fps) * 1000 + clip.endMs,
    timestampMs: null,
    confidence: null,
  })),
);
await writeFile(
  new URL("./public/captions.json", import.meta.url),
  JSON.stringify(captions, null, 2),
);
await writeFile(
  new URL("./public/trendlock-zh.srt", import.meta.url),
  captions
    .map(
      (c, i) =>
        `${i + 1}\n${toTime(c.startMs)} --> ${toTime(c.endMs)}\n${c.text}\n`,
    )
    .join("\n"),
);
console.log(
  JSON.stringify({
    durationSeconds: globalFrame / fps,
    scenes: scenes.map((s) => ({
      id: s.id,
      seconds: s.durationInFrames / fps,
    })),
  }),
);
