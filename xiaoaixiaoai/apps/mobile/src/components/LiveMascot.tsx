/**
 * The mascot in the Agents header: always gently alive (breathing, a little
 * sway), and it answers a tap: a happy hop and a speech bubble about how the
 * agents are doing. A long press opens the assistant.
 */
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import * as Haptics from "expo-haptics";
import Animated, { cancelAnimation, Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { Mascot, MASCOT_ANIM, type MascotMood } from "./Mascot";

export interface MascotCounts {
  blocked: number;
  working: number;
  done: number;
}

function lines(c: MascotCounts): string[] {
  const hour = new Date().getHours();
  const out: string[] = [];
  if (c.blocked) out.push(`有 ${c.blocked} 个在等你回话哦`);
  if (c.working) out.push(`${c.working} 个在干活，我帮你盯着`);
  if (c.done) out.push(`${c.done} 个跑完了，去看看？`);
  if (!c.blocked && !c.working) out.push("大家都歇着呢，你也歇会儿");
  if (hour >= 23 || hour < 6) out.push("夜深啦，早点睡哦");
  out.push("长按我，可以直接找我聊");
  return out;
}

export function LiveMascot({ counts, mood, size = 64, onLongPress }: { counts: MascotCounts; mood: MascotMood; size?: number; onLongPress?: () => void }) {
  const p = usePalette();
  const breath = useSharedValue(0);
  const hop = useSharedValue(0);
  const [say, setSay] = useState<string | null>(null);
  const [happy, setHappy] = useState(false);
  const [taps, setTaps] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    breath.set(withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.sin) }), -1, true));
    return () => cancelAnimation(breath);
  }, [breath]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const body = useAnimatedStyle(() => ({
    transform: [
      { translateY: -hop.get() * size * 0.22 - breath.get() * size * 0.03 },
      { rotate: `${(breath.get() - 0.5) * 5}deg` },
      { scaleX: 1 + hop.get() * 0.04 },
      { scaleY: 1 - hop.get() * 0.04 + breath.get() * 0.015 },
    ],
  }));

  function tap() {
    Haptics.selectionAsync().catch(() => undefined);
    hop.set(withSequence(withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) }), withSpring(0, { damping: 6, stiffness: 180 })));
    const all = lines(counts);
    setSay(all[taps % all.length]!);
    setTaps((n) => n + 1);
    setHappy(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setSay(null);
      setHappy(false);
    }, 2600);
  }

  return (
    <View style={{ width: size, height: size }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="爱弥斯，点一下听它说说现在的情况，长按去找它聊"
        onPress={tap}
        onLongPress={onLongPress}
        delayLongPress={450}
        hitSlop={6}
      >
        <Animated.View style={body}>
          {/* The moving sticker for the everyday moods; the still ones say something specific. */}
          {happy ? (
            <Image key={`tap-${taps}`} source={MASCOT_ANIM.tap} resizeMode="contain" style={{ width: size, height: size }} accessibilityLabel="爱弥斯开心地挥手" />
          ) : mood === "hello" ? (
            <Image source={MASCOT_ANIM.idle} resizeMode="contain" style={{ width: size, height: size }} accessibilityLabel="爱弥斯" />
          ) : (
            <Mascot mood={mood} size={size} />
          )}
        </Animated.View>
      </Pressable>
      {say ? (
        <Animated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(200)}
          pointerEvents="none"
          style={{
            position: "absolute",
            top: size - 4,
            right: 0,
            width: 168,
            backgroundColor: p.surface,
            borderRadius: radius.md,
            borderTopRightRadius: 4,
            paddingHorizontal: space.md,
            paddingVertical: 8,
            borderWidth: 1,
            borderColor: p.dark ? p.surface3 : "#FBDDE8",
            elevation: p.dark ? 0 : 4,
            shadowColor: p.shadow,
            shadowOpacity: 0.18,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 4 },
            zIndex: 10,
          }}
        >
          <Text accessibilityLiveRegion="polite" style={{ fontFamily: fonts.cute, fontSize: 14, lineHeight: 20, color: p.ink }}>
            {say}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}
