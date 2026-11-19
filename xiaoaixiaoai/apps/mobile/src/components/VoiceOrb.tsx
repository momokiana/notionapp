/**
 * The call's living centre: soft blue and pink shapes around the mascot that
 * move with whoever is audible. One look per phase (connecting, idle, listening,
 * thinking, speaking, muted) and every change glides — nothing jumps.
 *
 * Everything animates on the UI thread from `callLevel`; the screen itself does
 * not re-render while someone talks. Her face in the middle is a short loop per
 * phase (CallFace).
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Image, View, type ImageSourcePropType } from "react-native";
import Svg, { Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { callLevel, type CallPhase } from "../lib/voice";
import { usePalette } from "../theme/theme";
import { ASSISTANT_PORTRAIT, Sparkle } from "./Mascot";

const TAU = Math.PI * 2;
const PORTRAIT = ASSISTANT_PORTRAIT;

/**
 * One short loop of her face per call state. All of them start from PORTRAIT,
 * so the framing never changes and a crossfade between two states doesn't jump.
 */
const FACES: Record<CallPhase, ImageSourcePropType> = {
  connecting: PORTRAIT,
  idle: PORTRAIT,
  listening: PORTRAIT,
  thinking: PORTRAIT,
  speaking: PORTRAIT,
  muted: PORTRAIT,
};

/**
 * Follows `value`, but a new value has to last `settle` ms before it shows and
 * each shown value stays at least `hold` ms: the pause between two sentences
 * shouldn't flash another face.
 */
function useSteady<T>(value: T, settle: number, hold: number): T {
  const [shown, setShown] = useState(value);
  const since = useRef(0);
  useEffect(() => {
    if (value === shown) return;
    const wait = Math.max(settle, hold - (Date.now() - since.current));
    const t = setTimeout(() => {
      since.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, shown, settle, hold]);
  return shown;
}

/** Her face for the current call state, crossfading between states over the still portrait. */
export const CallFace = memo(function CallFace({ phase, size }: { phase: CallPhase; size: number }) {
  const face = useSteady(phase, 250, 700);
  return (
    <View style={{ width: size, height: size }}>
      <Image source={PORTRAIT} resizeMode="cover" style={{ position: "absolute", width: size, height: size }} />
      <Animated.View key={face} entering={FadeIn.duration(280)} exiting={FadeOut.duration(280)} style={{ position: "absolute", width: size, height: size }}>
        <Image source={FACES[face]} resizeMode="cover" style={{ width: size, height: size }} />
      </Animated.View>
    </View>
  );
});

/** A closed, gently lobed outline in a 200 x 200 box: a circle with a few low waves on it. */
function blobPath(seed: number, lobes: number, depth: number): string {
  const n = 96;
  let d = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const r = 82 * (1 + depth * Math.sin(lobes * a + seed) + depth * 0.45 * Math.sin((lobes - 1) * a - seed * 1.7) + depth * 0.25 * Math.sin((lobes + 2) * a + seed * 0.6));
    d += `${i ? "L" : "M"}${(100 + r * Math.cos(a)).toFixed(2)} ${(100 + r * Math.sin(a)).toFixed(2)}`;
  }
  return `${d}Z`;
}

/** A wide wave whose top edge rolls; slid sideways it reads as liquid. Two full periods, so half its width is one loop. */
function wavePath(height: number, seed: number): string {
  const n = 80;
  let d = "M0 60";
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * 400;
    const y = 14 + height * Math.sin((i / n) * TAU * 2 + seed) + height * 0.4 * Math.sin((i / n) * TAU * 4 + seed * 2);
    d += `L${x.toFixed(1)} ${y.toFixed(2)}`;
  }
  return `${d}L400 60Z`;
}

const BLOBS = [
  { d: blobPath(0.4, 3, 0.085), rate: 1, gain: 0.2, base: 1 },
  { d: blobPath(2.3, 4, 0.07), rate: -0.72, gain: 0.3, base: 0.96 },
  { d: blobPath(4.1, 3, 0.06), rate: 0.45, gain: 0.12, base: 0.84 },
] as const;
const WAVE_A = wavePath(7, 0.3);
const WAVE_B = wavePath(5, 2.1);

/** Eases 0 -> 1 while `on`, back to 0 after. */
function useWeight(on: boolean): SharedValue<number> {
  const v = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    v.value = withTiming(on ? 1 : 0, { duration: 420 });
  }, [on, v]);
  return v;
}

export const VoiceOrb = memo(function VoiceOrb({ phase, size = 260 }: { phase: CallPhase; size?: number }) {
  const p = usePalette();
  const speak = useWeight(phase === "speaking");
  const listen = useWeight(phase === "listening");
  const think = useWeight(phase === "thinking");
  const mute = useWeight(phase === "muted");
  const connect = useWeight(phase === "connecting");

  // Phases are integrated frame by frame, so a change of speed never makes them jump.
  const energy = useSharedValue(0);
  const spin = useSharedValue(0);
  const breath = useSharedValue(0);
  const ripple = useSharedValue(0);
  const flow = useSharedValue(0);

  useFrameCallback((frame) => {
    "worklet";
    const dt = Math.min((frame.timeSincePreviousFrame ?? 16) / 1000, 0.05);
    const heard = callLevel.value;
    // Thinking has no sound of its own: a slow swell keeps it alive.
    const want = Math.max(heard, think.value * (0.22 + 0.14 * Math.sin(breath.value * 1.6)), connect.value * 0.1);
    // Up fast with each syllable, down slowly, like something soft.
    energy.value += (want - energy.value) * Math.min(1, dt * (want > energy.value ? 16 : 5));
    spin.value = (spin.value + dt * (0.22 + 1.1 * think.value + 0.5 * energy.value)) % TAU;
    breath.value = (breath.value + dt * (1.1 - 0.5 * mute.value)) % TAU;
    ripple.value = (ripple.value + dt * (0.22 + 0.5 * speak.value + 0.25 * listen.value)) % 1;
    flow.value = (flow.value + dt * (0.1 + 0.35 * energy.value + 0.12 * think.value)) % 1;
  });

  const blobSize = size * 0.9;
  const bodySize = size * 0.6;
  const colors = useMemo(() => ({
    a: [p.accentContainer, p.primary],
    b: [p.sky, p.lavender],
    c: [p.skyContainer, p.accentContainer],
    glow: p.sky,
    ring: p.sky,
    wave: p.surface,
    body: [p.reply, p.accentContainer],
  }), [p]);

  const quiet = useAnimatedStyle(() => ({ opacity: 1 - 0.45 * mute.value - 0.25 * connect.value }));
  const glow = useAnimatedStyle(() => ({
    opacity: 0.35 + 0.5 * energy.value + 0.08 * Math.sin(breath.value),
    transform: [{ scale: 0.92 + 0.22 * energy.value }],
  }));

  const blob0 = useBlobStyle(0, spin, breath, energy, speak, listen);
  const blob1 = useBlobStyle(1, spin, breath, energy, speak, listen);
  const blob2 = useBlobStyle(2, spin, breath, energy, speak, listen);

  const ring0 = useRingStyle(0, ripple, breath, speak, listen);
  const ring1 = useRingStyle(0.5, ripple, breath, speak, listen);

  const body = useAnimatedStyle(() => {
    const pump = 0.07 * energy.value * (speak.value + 0.5 * listen.value);
    const squash = 0.025 * Math.sin(breath.value * 2) * energy.value;
    return { transform: [{ scaleX: 1 + pump - squash }, { scaleY: 1 + pump + squash }, { translateY: -2 * Math.sin(breath.value) }] };
  });
  const waveA = useAnimatedStyle(() => ({
    transform: [{ translateX: -bodySize * flow.value }, { translateY: bodySize * (0.2 - 0.16 * energy.value) }],
  }));
  const waveB = useAnimatedStyle(() => ({
    transform: [{ translateX: -bodySize * ((flow.value * 0.6 + 0.37) % 1) }, { translateY: bodySize * (0.24 - 0.2 * energy.value) }],
  }));

  const orbit = useAnimatedStyle(() => ({ opacity: think.value, transform: [{ rotate: `${spin.value * 2}rad` }] }));
  const twinkle = useAnimatedStyle(() => ({
    opacity: 0.55 + 0.45 * Math.abs(Math.sin(breath.value)),
    transform: [{ scale: 0.8 + 0.3 * Math.abs(Math.sin(breath.value)) + 0.5 * energy.value * speak.value }],
  }));
  const badge = useAnimatedStyle(() => ({ opacity: mute.value, transform: [{ scale: 0.6 + 0.4 * mute.value }] }));

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[{ position: "absolute", width: size, height: size }, glow]}>
        <Svg width={size} height={size} viewBox="0 0 100 100">
          <Defs>
            <RadialGradient id="orbGlow" cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
              <Stop offset="0.35" stopColor={colors.glow} stopOpacity={p.dark ? 0.32 : 0.36} />
              <Stop offset="1" stopColor={colors.glow} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width="100" height="100" fill="url(#orbGlow)" />
        </Svg>
      </Animated.View>

      {[ring0, ring1].map((style, i) => (
        <Animated.View key={i} style={[{ position: "absolute", width: size * 0.78, height: size * 0.78, borderRadius: size, borderWidth: 1.2, borderColor: colors.ring }, style]} />
      ))}

      <Animated.View style={[{ position: "absolute", width: size, height: size, alignItems: "center", justifyContent: "center" }, quiet]}>
        {[blob0, blob1, blob2].map((style, i) => (
          <Animated.View key={i} style={[{ position: "absolute", width: blobSize, height: blobSize }, style]}>
            <Svg width={blobSize} height={blobSize} viewBox="0 0 200 200">
              <Defs>
                <LinearGradient id={`orbBlob${i}`} x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor={colors[i === 0 ? "a" : i === 1 ? "b" : "c"][0]} />
                  <Stop offset="1" stopColor={colors[i === 0 ? "a" : i === 1 ? "b" : "c"][1]} />
                </LinearGradient>
              </Defs>
              <Path d={BLOBS[i]!.d} fill={`url(#orbBlob${i})`} fillOpacity={i === 2 ? 0.9 : p.dark ? 0.5 : 0.62} />
            </Svg>
          </Animated.View>
        ))}
      </Animated.View>

      <Animated.View style={[{ width: bodySize, height: bodySize, borderRadius: bodySize, overflow: "hidden", backgroundColor: colors.body[0] }, body]}>
        <CallFace phase={phase} size={bodySize} />
        {/* Liquid that rises with each syllable, and hides the flat lower edge of the portrait. */}
        <Animated.View style={[{ position: "absolute", left: 0, bottom: 0, width: bodySize * 2, height: bodySize * 0.3, opacity: 0.55 }, waveB]}>
          <Svg width={bodySize * 2} height={bodySize * 0.3} viewBox="0 0 400 60" preserveAspectRatio="none">
            <Path d={WAVE_B} fill={colors.b[0]} />
          </Svg>
        </Animated.View>
        <Animated.View style={[{ position: "absolute", left: 0, bottom: 0, width: bodySize * 2, height: bodySize * 0.3, opacity: 0.7 }, waveA]}>
          <Svg width={bodySize * 2} height={bodySize * 0.3} viewBox="0 0 400 60" preserveAspectRatio="none">
            <Path d={WAVE_A} fill={colors.wave} />
          </Svg>
        </Animated.View>
      </Animated.View>

      {/* Thinking: three small dots circling. */}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", width: size * 0.74, height: size * 0.74 }, orbit]}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={{
              position: "absolute",
              width: 9 - i * 2,
              height: 9 - i * 2,
              borderRadius: 9,
              backgroundColor: p.primary,
              opacity: 1 - i * 0.28,
              left: size * 0.37 + size * 0.37 * Math.cos(-i * 0.42) - (9 - i * 2) / 2,
              top: size * 0.37 + size * 0.37 * Math.sin(-i * 0.42) - (9 - i * 2) / 2,
            }}
          />
        ))}
      </Animated.View>

      <Animated.View pointerEvents="none" style={[{ position: "absolute", right: size * 0.13, top: size * 0.1 }, twinkle]}>
        <Sparkle size={size * 0.075} color={p.primary} />
      </Animated.View>

      <Animated.View
        pointerEvents="none"
        style={[
          { position: "absolute", right: size * 0.2, bottom: size * 0.17, width: 34, height: 34, borderRadius: 17, backgroundColor: p.surface, alignItems: "center", justifyContent: "center", elevation: 2 },
          badge,
        ]}
      >
        <MaterialCommunityIcons name="microphone-off" size={19} color={p.muted} />
      </Animated.View>
    </View>
  );
});

function useBlobStyle(
  i: 0 | 1 | 2,
  spin: SharedValue<number>,
  breath: SharedValue<number>,
  energy: SharedValue<number>,
  speak: SharedValue<number>,
  listen: SharedValue<number>,
) {
  const { rate, gain, base } = BLOBS[i];
  return useAnimatedStyle(() => {
    const voiced = 0.35 + 0.65 * Math.max(speak.value, listen.value * 0.8);
    const scale = base * (0.9 + 0.03 * Math.sin(breath.value + i * 1.9) + gain * energy.value * voiced);
    return { transform: [{ rotate: `${spin.value * rate + i * 2.1}rad` }, { scale }] };
  });
}

/** Speaking sends rings outward; otherwise they rest as two faint outlines that breathe. */
function useRingStyle(offset: number, ripple: SharedValue<number>, breath: SharedValue<number>, speak: SharedValue<number>, listen: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const moving = Math.max(speak.value, listen.value);
    const t = (ripple.value + offset) % 1;
    // Listening pulls the rings in, towards the mascot: sound coming to her.
    const travel = speak.value >= listen.value ? t : 1 - t;
    const restScale = 1.08 + offset * 0.3 + 0.012 * Math.sin(breath.value + offset * 4);
    const scale = restScale * (1 - moving) + (1 + 0.5 * travel) * moving;
    const opacity = 0.22 * (1 - moving) + 0.6 * (1 - travel) * moving;
    return { opacity, transform: [{ scale }] };
  });
}

/** Five small bars beside the state line; they rise with the same loudness as the orb. */
export const LevelBars = memo(function LevelBars({ active, color }: { active: boolean; color: string }) {
  const on = useWeight(active);
  const clock = useSharedValue(0);
  const energy = useSharedValue(0);
  useFrameCallback((frame) => {
    "worklet";
    const dt = Math.min((frame.timeSincePreviousFrame ?? 16) / 1000, 0.05);
    clock.value = (clock.value + dt * 9) % (TAU * 100);
    const want = callLevel.value;
    energy.value += (want - energy.value) * Math.min(1, dt * (want > energy.value ? 18 : 7));
  });
  const b0 = useBarStyle(0, on, clock, energy);
  const b1 = useBarStyle(1, on, clock, energy);
  const b2 = useBarStyle(2, on, clock, energy);
  const b3 = useBarStyle(3, on, clock, energy);
  const b4 = useBarStyle(4, on, clock, energy);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 3.5, height: 22 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {[b0, b1, b2, b3, b4].map((style, i) => (
        <Animated.View key={i} style={[{ width: 4.5, borderRadius: 3, backgroundColor: color }, style]} />
      ))}
    </View>
  );
});

function useBarStyle(i: number, on: SharedValue<number>, clock: SharedValue<number>, energy: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const rest = 5 + i * 1.6;
    const full = 9 + i * 3.2;
    const wiggle = 0.6 + 0.4 * Math.sin(clock.value * (0.8 + i * 0.23) + i * 1.3);
    const lift = Math.min(1, energy.value * 1.6) * wiggle * on.value;
    return { height: rest + (full - rest) * lift + 2 * lift, opacity: 0.35 + 0.13 * i + 0.2 * on.value };
  });
}
