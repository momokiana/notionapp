import "../../src/styles/base.css";
import "../../src/styles/phone.css";
import "./video.css";
import React from "react";
import { Composition, Still } from "remotion";
import { Intro, INTRO_FRAMES } from "./Intro";
import { OgCard } from "./scenes";

export const Root: React.FC = () => (
  <>
    <Composition id="Intro" component={Intro} durationInFrames={INTRO_FRAMES} fps={30} width={1920} height={1080} />
    <Still id="Og" component={OgCard} width={1200} height={630} />
  </>
);
