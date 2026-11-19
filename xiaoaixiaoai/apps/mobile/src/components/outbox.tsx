import { Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import * as Haptics from "expo-haptics";
import Animated, { FadeIn } from "react-native-reanimated";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { forget, resend } from "../lib/outbox";
import type { PendingSend } from "../lib/store";
import { usePalette } from "../theme/theme";
import { fonts, motion, radius, space } from "../theme/tokens";
import { TypingDots } from "./ui";

/**
 * The quiet state line under a message sent from this phone, as chat apps do:
 * a clock while it goes, the time and a tick once the computer took it,
 * "排队中" while the agent's turn holds it, and a retry when it did not go through.
 */
export function SendMark({ send, agentKey, time }: { send: PendingSend; agentKey: string; time: string }) {
  const p = usePalette();
  if (send.state === "failed") {
    const pill = { minHeight: 30, paddingHorizontal: space.md, borderRadius: radius.pill, flexDirection: "row" as const, alignItems: "center" as const, gap: 3 };
    return (
      <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" }}>
        <MaterialCommunityIcons name="alert-circle-outline" size={14} color={p.error} />
        <Text numberOfLines={1} accessibilityLabel={`没发出去${send.error ? `：${send.error}` : ""}`} style={{ flexShrink: 1, color: p.error, fontSize: 12 }}>
          {send.error ? `没发出去：${send.error}` : "没发出去"}
        </Text>
        <Pressable
          onPress={() => forget(agentKey, [send.id])}
          accessibilityRole="button"
          accessibilityLabel="不发了，删掉这条"
          hitSlop={8}
          style={({ pressed }) => [pill, { backgroundColor: pressed ? p.surface3 : p.surface2 }]}
        >
          <Text style={{ color: p.muted, fontFamily: fonts.bodySemi, fontSize: 12.5 }}>删掉</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => undefined);
            void resend(agentKey, send.id);
          }}
          accessibilityRole="button"
          accessibilityLabel="重新发送这条消息"
          hitSlop={8}
          style={({ pressed }) => [pill, { backgroundColor: pressed ? p.primaryPressed : p.primary }]}
        >
          <MaterialCommunityIcons name="refresh" size={14} color={p.onPrimary} />
          <Text style={{ color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 12.5 }}>重发</Text>
        </Pressable>
      </View>
    );
  }
  if (send.state === "queued") {
    return (
      <View accessible accessibilityLiveRegion="polite" accessibilityLabel="排队中，它这一轮做完才会看到" style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
        <MaterialCommunityIcons name="timer-sand" size={12} color={p.accentText} />
        <Text style={{ color: p.accentText, fontFamily: fonts.bodySemi, fontSize: 11.5 }}>排队中</Text>
      </View>
    );
  }
  const sent = send.state === "sent";
  return (
    <View accessible accessibilityLabel={sent ? `已发送 ${time}` : "正在发送"} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      {sent ? <Text style={{ color: p.faint, fontSize: 11 }}>{time}</Text> : null}
      <MaterialCommunityIcons name={sent ? "check" : "clock-outline"} size={12} color={p.faint} />
    </View>
  );
}

/** The agent's side of the chat right after a message, until it answers or starts working: three soft dots. */
export function ReplyDots() {
  const p = usePalette();
  return (
    <Animated.View entering={FadeIn.duration(motion.standard)} accessibilityLiveRegion="polite" accessibilityLabel="等它回复" style={{ flexDirection: "row", paddingTop: space.md }}>
      <View
        style={{
          backgroundColor: p.surface,
          borderRadius: radius.card,
          borderBottomLeftRadius: 6,
          paddingHorizontal: space.lg,
          paddingVertical: 15,
          elevation: p.dark ? 0 : 1,
          shadowColor: p.shadow,
          shadowOpacity: 0.1,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
        }}
      >
        <TypingDots color={p.accentText} size={7} />
      </View>
    </Animated.View>
  );
}
