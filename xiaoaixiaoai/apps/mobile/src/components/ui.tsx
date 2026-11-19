import { useEffect, type ReactNode } from "react";
import { Image, Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Text } from "react-native-paper";
import Svg, { G, Path, SvgXml } from "react-native-svg";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, type SharedValue } from "react-native-reanimated";
import type { AgentStatus } from "@xiaoaixiaoai/protocol";
import { usePalette } from "../theme/theme";
import { fonts, motion, radius, space, statusColors, statusLabel } from "../theme/tokens";
import { harnessLook } from "../lib/harness";
import { useRemoteIcon } from "../lib/harnessRemote";
import { Mascot, type MascotMood } from "./Mascot";
import { CuteIcon, type CuteIconName } from "./icons";
import { StarTrail, StarlightPortrait } from "./Starlight";

/** Ice-blue sky into a pink horizon; the small trail never intercepts touches. */
export function PageBackground({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return (
    <LinearGradient colors={[p.pageTop, p.page, p.pageBottom]} locations={[0, 0.52, 1]} start={{ x: 0.15, y: 0 }} end={{ x: 0.85, y: 1 }} style={[{ flex: 1 }, style]}>
      <View pointerEvents="none" style={{ position: "absolute", top: 30, right: 0 }}>
        <StarTrail opacity={p.dark ? 0.28 : 0.34} />
      </View>
      {children}
    </LinearGradient>
  );
}

export type TileTone = "primary" | "soft" | "plain" | "danger";

/**
 * Round icon button in the app's own style: a pastel tile, a chubby duotone
 * icon, and a small squash when pressed. `primary` is the pink action
 * (send, call), `soft` a tinted helper, `plain` a quiet header action.
 */
export function IconTile({
  icon,
  onPress,
  onLongPress,
  a11y,
  tone = "soft",
  size = 44,
  iconSize,
  disabled,
  active,
  shape = "round",
}: {
  icon: CuteIconName;
  onPress?: () => void;
  onLongPress?: () => void;
  a11y: string;
  tone?: TileTone;
  size?: number;
  iconSize?: number;
  disabled?: boolean;
  /** A toggle that is on. */
  active?: boolean;
  shape?: "round" | "squircle";
}) {
  const p = usePalette();
  const look = tileLook(p, active ? "primary" : tone, disabled);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled: !!disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: shape === "round" ? size / 2 : Math.round(size * 0.36),
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? look.pressed : look.bg,
        borderWidth: look.border ? 1 : 0,
        borderColor: look.border,
        transform: [{ scale: pressed ? 0.92 : 1 }],
      })}
    >
      <CuteIcon name={icon} size={iconSize ?? Math.round(size * 0.52)} color={look.ink} fill={look.fill} />
    </Pressable>
  );
}

function tileLook(p: ReturnType<typeof usePalette>, tone: TileTone, disabled?: boolean): { bg: string; pressed: string; ink: string; fill: string; border?: string } {
  if (disabled) return { bg: p.surface3, pressed: p.surface3, ink: p.faint, fill: "none" };
  switch (tone) {
    case "primary":
      return { bg: p.primary, pressed: p.primaryPressed, ink: p.onPrimary, fill: p.dark ? "#FFD3E2" : "#FFFFFF" };
    case "danger":
      return { bg: p.errorContainer, pressed: p.surface3, ink: p.error, fill: "none" };
    case "plain":
      return { bg: p.dark ? p.surface : "#FFFFFFB3", pressed: p.skyContainer, ink: p.ink, fill: p.reply, border: p.divider };
    default:
      return { bg: p.skyContainer, pressed: p.reply, ink: p.skyText, fill: p.surface };
  }
}

/** The pink send button: a short pill with a paper plane. */
export function SendPill({ onPress, disabled, a11y = "发送" }: { onPress: () => void; disabled?: boolean; a11y?: string }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 54,
        height: 42,
        borderRadius: 21,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: disabled ? p.surface3 : pressed ? p.primaryPressed : p.primary,
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      <CuteIcon name="plane" size={20} color={disabled ? p.faint : p.onPrimary} fill={disabled ? "none" : p.dark ? "#FFD3E2" : "#FFFFFF"} strokeWidth={2} />
    </Pressable>
  );
}

/** Soft card with a fine cool outline and a diffused shadow. */
export function Card({
  children,
  style,
  outerStyle,
  onPress,
  onLongPress,
  accessibilityLabel,
  flat,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Layout style for the pressable wrapper (e.g. flex: 1 inside a row). */
  outerStyle?: StyleProp<ViewStyle>;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  /** No shadow (for nested tiles). */
  flat?: boolean;
}) {
  const p = usePalette();
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const base: ViewStyle = {
    backgroundColor: p.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: p.divider,
    ...(flat
      ? {}
      : {
          shadowColor: p.shadow,
          shadowOpacity: p.dark ? 0.3 : 0.14,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          elevation: p.dark ? 0 : 3,
        }),
  };
  if (!onPress && !onLongPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      style={outerStyle}
      onPressIn={() => scale.set(withTiming(0.98, { duration: motion.press }))}
      onPressOut={() => scale.set(withTiming(1, { duration: motion.quick, easing: motion.glide }))}
    >
      <Animated.View style={[base, style, anim]}>{children}</Animated.View>
    </Pressable>
  );
}

/** Dot that gently "breathes" while an agent is active. */
export function BreathingDot({ color, active, size = 7 }: { color: string; active: boolean; size?: number }) {
  const v = useSharedValue(1);
  useEffect(() => {
    if (active) {
      v.set(withRepeat(withSequence(withTiming(0.35, { duration: motion.breathe / 2 }), withTiming(1, { duration: motion.breathe / 2 })), -1));
    } else {
      cancelAnimation(v);
      v.set(1);
    }
    return () => cancelAnimation(v);
  }, [active, v]);
  const core = useAnimatedStyle(() => ({ opacity: 0.45 + v.get() * 0.55 }));
  return <Animated.View style={[{ width: size, height: size, borderRadius: size, backgroundColor: color }, core]} />;
}

/** Three dots taking turns, like someone typing: the lit one brightens and hops a little. */
export function TypingDots({ color, size = 6 }: { color: string; size?: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.set(withRepeat(withTiming(3, { duration: 1260, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(t);
  }, [t]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: Math.round(size * 0.7), height: size * 2 }}>
      {[0, 1, 2].map((i) => (
        <TypingDot key={i} t={t} i={i} size={size} color={color} />
      ))}
    </View>
  );
}

function TypingDot({ t, i, size, color }: { t: SharedValue<number>; i: number; size: number; color: string }) {
  const anim = useAnimatedStyle(() => {
    const phase = (t.get() - i + 3) % 3;
    const lit = phase < 1 ? Math.sin(phase * Math.PI) : 0;
    return { opacity: 0.3 + lit * 0.7, transform: [{ translateY: -lit * size * 0.4 }] };
  });
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, anim]} />;
}

const STATUS_ICON: Record<AgentStatus, CuteIconName> = { working: "working", blocked: "blocked", done: "done", idle: "idle", unknown: "idle" };

/** Status chip: a little icon in the status colour, the word, a tinted pill. Working and waiting breathe. */
export function StatusPill({ status, compact, label = statusLabel[status] }: { status: AgentStatus; compact?: boolean; label?: string }) {
  const p = usePalette();
  const c = statusColors(status, p.dark);
  const live = status === "working" || status === "blocked";
  const v = useSharedValue(1);
  useEffect(() => {
    if (live) v.set(withRepeat(withSequence(withTiming(0.82, { duration: motion.breathe / 2 }), withTiming(1, { duration: motion.breathe / 2 })), -1));
    else {
      cancelAnimation(v);
      v.set(1);
    }
    return () => cancelAnimation(v);
  }, [live, v]);
  const icon = useAnimatedStyle(() => {
    const value = v.get();
    return { transform: [{ scale: value }, { rotate: `${(1 - value) * (status === "working" ? 120 : 0)}deg` }] };
  });
  const size = compact ? 13 : 15;
  return (
    <View
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: c.bg,
        borderRadius: radius.pill,
        paddingLeft: compact ? 7 : 8,
        paddingRight: compact ? 9 : 11,
        paddingVertical: compact ? 3 : 4,
      }}
    >
      <Animated.View style={icon}>
        <CuteIcon name={STATUS_ICON[status]} size={size} color={c.fg} fill={p.dark ? "transparent" : "#FFFFFF"} strokeWidth={2.4} />
      </Animated.View>
      <Text style={{ color: c.fg, fontFamily: fonts.bodyBold, fontSize: compact ? 12 : 13 }}>{label}</Text>
    </View>
  );
}

/**
 * Pastel circle badge per harness: its sticker, else its brand glyph (bundled,
 * or sent by the computer's Uniflo), else a letter. Glyphs are plum (light) or near-white (dark).
 */
export function HarnessAvatar({ harness, isShell, size = 42, dim }: { harness: string; isShell: boolean; size?: number; dim?: boolean }) {
  const p = usePalette();
  const look = harnessLook(harness, isShell);
  const remote = useRemoteIcon(look.remoteId);
  const bg = p.dark ? look.darkBg : look.bg;
  const fg = p.ink;
  const mark = size * 0.52;
  const letter = look.icon ? (
    <MaterialCommunityIcons name={look.icon} size={size * 0.46} color={fg} />
  ) : (
    <Text style={{ color: fg, fontFamily: look.mono ? fonts.monoBold : fonts.cute, fontSize: size * (look.mono ? 0.32 : 0.46), lineHeight: size * 0.6 }}>{look.glyph}</Text>
  );
  const sticker = look.image ? <Image source={look.image} style={{ width: size, height: size, borderRadius: size / 2 }} /> : null;
  return (
    <View
      accessibilityLabel={look.label}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center", opacity: dim ? 0.55 : 1 }}
    >
      {sticker && !look.generic ? (
        sticker
      ) : look.svg ? (
        <Svg width={mark} height={mark} viewBox="0 0 24 24">
          <G fill={fg}>
            {look.svg.map((g, i) => (
              <Path key={i} d={g.d} fillRule={g.fillRule ?? "evenodd"} clipRule={g.clipRule} opacity={g.opacity} transform={g.transform} />
            ))}
          </G>
        </Svg>
      ) : remote ? (
        <SvgXml xml={remote} width={mark} height={mark} color={fg} fallback={sticker ?? letter} />
      ) : (
        sticker ?? letter
      )}
    </View>
  );
}

export function EmptyState({ title, body, mood = "sleepy", action }: { title: string; body?: string; mood?: MascotMood; action?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ alignItems: "center", paddingVertical: space.xxxl, paddingHorizontal: space.xxl, gap: space.md }}>
      <Mascot mood={mood} size={140} />
      <Text style={{ fontFamily: fonts.cute, fontSize: 20, color: p.ink, textAlign: "center" }}>{title}</Text>
      {body ? <Text style={{ color: p.muted, textAlign: "center", lineHeight: 21 }}>{body}</Text> : null}
      {action}
    </View>
  );
}

/** Full-screen "配对成功" moment with the cheering sticker; shown briefly before entering the app. */
export function PairSuccess({ sub }: { sub?: string }) {
  const p = usePalette();
  return (
    <LinearGradient accessibilityLiveRegion="assertive" colors={[p.pageTop, p.page, p.pageBottom]} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: space.md }}>
      <StarlightPortrait mood="yay" size={144} />
      <Text style={{ fontFamily: fonts.cute, fontSize: 26, lineHeight: 34, color: p.ink }}>配对成功</Text>
      {sub ? <Text style={{ color: p.muted }}>{sub}</Text> : null}
    </LinearGradient>
  );
}

export function SectionHeader({ title, right, dot, dim }: { title: string; right?: ReactNode; dot?: string; dim?: boolean }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.xs, paddingTop: space.xl, paddingBottom: space.sm, gap: space.sm, opacity: dim ? 0.6 : 1 }}>
      {dot ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} /> : null}
      <Text style={{ flex: 1, fontFamily: fonts.bodyBold, color: p.muted, fontSize: 14 }} numberOfLines={1}>
        {title}
      </Text>
      {right}
    </View>
  );
}

/** Large page title in our Starlight Hand display face. */
export function PageTitle({ children, sub, right }: { children: ReactNode; sub?: string; right?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
      <View style={{ flex: 1, gap: space.xs }}>
        <Text style={{ fontFamily: fonts.cute, fontSize: 30, lineHeight: 40, color: p.ink }}>{children}</Text>
        {sub ? <Text style={{ color: p.muted, fontSize: 14.5 }}>{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
}
