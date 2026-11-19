import { Redirect, Tabs } from "expo-router";
import type { BottomTabBarButtonProps } from "expo-router/js-tabs";
import { Pressable, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { CuteIcon, type CuteIconName } from "../../components/icons";
import { useSettings, useLive, allAgents } from "../../lib/store";
import { useAssistant } from "../../lib/assistant";
import { UpdatePrompt } from "../../components/UpdatePrompt";
import { usePalette } from "../../theme/theme";
import { fonts } from "../../theme/tokens";

/** The selected tab sits on a small blue-to-pink pill. */
function TabIcon({ name, focused, color }: { name: CuteIconName; focused: boolean; color: string }) {
  const p = usePalette();
  return (
    <View style={{ width: 56, height: 30, borderRadius: 15, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
      {focused ? <LinearGradient pointerEvents="none" colors={[p.skyContainer, p.accentContainer]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: "absolute", inset: 0, borderRadius: 15 }} /> : null}
      <CuteIcon name={name} size={22} color={color} fill={focused ? (p.dark ? p.surface : "#FFFFFF") : "none"} strokeWidth={2} />
    </View>
  );
}

/**
 * Tab button without React Navigation's default Android ripple (a borderless
 * gray circle). The selected tab's gradient pill is the selection cue; a press gives
 * the same small squash as the app's other buttons.
 */
function TabButton({ ref: _ref, href: _href, android_ripple: _ripple, pressColor: _pressColor, pressOpacity: _pressOpacity, hoverEffect: _hover, style, children, ...rest }: BottomTabBarButtonProps) {
  return (
    <Pressable {...rest} style={({ pressed }) => [style, { transform: [{ scale: pressed ? 0.94 : 1 }] }]}>
      {children}
    </Pressable>
  );
}

export default function TabsLayout() {
  const p = usePalette();
  const server = useSettings((s) => s.server);
  const needsYou = useLive((s) => allAgents(s.agents).filter((a) => a.status === "blocked").length);
  // Waiting for a yes/no, plus what the assistant said on its own while this tab was not open.
  const pendingActions = useAssistant((s) => s.items.filter((i) => i.action?.state === "pending").length + s.unread);
  if (!server) return <Redirect href="/connect" />;

  return (
    <>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarHideOnKeyboard: true,
          tabBarButton: (props) => <TabButton {...props} />,
          tabBarActiveTintColor: p.accentText,
          tabBarInactiveTintColor: p.faint,
          tabBarLabelStyle: { fontFamily: fonts.cute, fontSize: 11.5, marginTop: 2 },
          tabBarStyle: {
            borderTopWidth: 1,
            borderTopColor: p.divider,
            backgroundColor: p.glass,
            elevation: 0,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "助理",
            tabBarBadge: pendingActions || undefined,
            tabBarBadgeStyle: { backgroundColor: p.primary, color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 11 },
            tabBarIcon: ({ color, focused }) => <TabIcon name="chat" focused={focused} color={color as string} />,
          }}
        />
        <Tabs.Screen
          name="agents"
          options={{
            title: "Agents",
            tabBarBadge: needsYou || undefined,
            tabBarBadgeStyle: { backgroundColor: p.primary, color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 11 },
            tabBarIcon: ({ color, focused }) => <TabIcon name="robot" focused={focused} color={color as string} />,
          }}
        />
        <Tabs.Screen
          name="devices"
          options={{ title: "设备", tabBarIcon: ({ color, focused }) => <TabIcon name="laptop" focused={focused} color={color as string} /> }}
        />
        <Tabs.Screen
          name="settings"
          options={{ title: "设置", tabBarIcon: ({ color, focused }) => <TabIcon name="gear" focused={focused} color={color as string} /> }}
        />
      </Tabs>
      <UpdatePrompt />
    </>
  );
}
