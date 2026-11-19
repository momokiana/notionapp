/**
 * 爱弥斯: the user-selected portrait shared by the app and assistant.
 * The first custom build uses one still portrait, not upstream character animations.
 * See assets/brand/USER-ARTWORK.md for the separate artwork rights notice.
 */
import { memo } from "react";
import { Image } from "react-native";
import Svg, { Path } from "react-native-svg";
import { brand } from "../theme/tokens";

export type MascotMood = "default" | "hello" | "waiting" | "sleepy" | "yay";

// One user-selected portrait; do not fall back to the upstream character.
export const ASSISTANT_PORTRAIT = require("../../assets/brand/aimisi-avatar.png");
const STICKERS = {
  default: ASSISTANT_PORTRAIT,
  hello: ASSISTANT_PORTRAIT,
  waiting: ASSISTANT_PORTRAIT,
  sleepy: ASSISTANT_PORTRAIT,
  yay: ASSISTANT_PORTRAIT,
} as const;

const LABEL: Record<MascotMood, string> = {
  default: "爱弥斯头像",
  hello: "爱弥斯头像",
  waiting: "爱弥斯，等待中",
  sleepy: "爱弥斯，空闲中",
  yay: "爱弥斯，已完成",
};

export const Mascot = memo(function Mascot({ mood = "default", size = 64 }: { mood?: MascotMood; size?: number }) {
  return (
    <Image
      source={STICKERS[mood]}
      resizeMode="contain"
      style={{ width: size, height: size, borderRadius: size / 2 }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={LABEL[mood]}
    />
  );
});

/** Animated stickers (animated WebP with alpha; the first frame shows where animation is off). */
export const MASCOT_ANIM = {
  idle: ASSISTANT_PORTRAIT,
  tap: ASSISTANT_PORTRAIT,
  working: ASSISTANT_PORTRAIT,
} as const;

/** The mascot hard at work, on a loop (the agent is busy). */
export const BusyMascot = memo(function BusyMascot({ size = 30 }: { size?: number }) {
  return <Image source={MASCOT_ANIM.working} resizeMode="contain" style={{ width: size, height: size, borderRadius: size / 2 }} accessible accessibilityRole="image" accessibilityLabel="爱弥斯正在忙" />;
});

const SPARKLE = "M0 -16 C2.5 -4 4 -2.5 16 0 C4 2.5 2.5 4 0 16 C-2.5 4 -4 2.5 -16 0 C-4 -2.5 -2.5 -4 0 -16Z";

/** Small decorative highlight. */
export function Sparkle({ size = 14, color = brand.sky }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="-16 -16 32 32" accessible={false}>
      <Path d={SPARKLE} fill={color} />
    </Svg>
  );
}
