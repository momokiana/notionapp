import React from "react";
import { linearTiming, TransitionSeries, type TransitionPresentation } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import {
  SceneOpen,
  SceneProblem,
  SceneReveal,
  SceneFlow,
  SceneList,
  SceneChatTerm,
  SceneAssistant,
  SceneCall,
  SceneSelfHost,
  SceneOutro,
} from "./scenes";

export const T = 16;
export const SCENES: [React.FC, number][] = [
  [SceneOpen, 180],
  [SceneProblem, 210],
  [SceneReveal, 220],
  [SceneFlow, 390],
  [SceneList, 270],
  [SceneChatTerm, 340],
  [SceneAssistant, 380],
  [SceneCall, 280],
  [SceneSelfHost, 260],
  [SceneOutro, 230],
];
export const INTRO_FRAMES = SCENES.reduce((a, [, d]) => a + d, 0) - T * (SCENES.length - 1);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const presentations: TransitionPresentation<any>[] = [fade(), fade(), slide({ direction: "from-right" }), wipe({ direction: "from-left" }), slide({ direction: "from-bottom" }), fade(), fade(), fade(), slide({ direction: "from-right" })];

export const Intro: React.FC = () => (
  <TransitionSeries>
    {SCENES.flatMap(([Scene, d], i) => {
      const seq = (
        <TransitionSeries.Sequence key={`s${i}`} durationInFrames={d}>
          <Scene />
        </TransitionSeries.Sequence>
      );
      if (i === SCENES.length - 1) return [seq];
      return [seq, <TransitionSeries.Transition key={`t${i}`} presentation={presentations[i]} timing={linearTiming({ durationInFrames: T })} />];
    })}
  </TransitionSeries>
);
