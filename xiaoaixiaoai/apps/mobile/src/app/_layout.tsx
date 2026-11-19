import { useEffect } from "react";
import { View } from "react-native";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold } from "@expo-google-fonts/nunito";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeRoot, usePalette } from "../theme/theme";
import { useSettings } from "../lib/store";
import { loadToken } from "../lib/auth";
import { startLink, stopLink } from "../lib/relay";
import { isMockServer } from "../lib/mock";
import { startAppLog } from "../lib/applog";
import { fonts } from "../theme/tokens";
import { useAlertSync } from "../lib/alerts";
import { IconTile } from "../components/ui";
import { useHarnessIconSync } from "../lib/harnessRemote";
import { Portal, Snackbar } from "react-native-paper";
import { useDshForegroundNotice, useDshIntent } from "../lib/dsh-runtime";

SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 2_000, refetchOnWindowFocus: false } },
});

/** Opens the relay socket whenever a server + token are known. */
function useRelayLink() {
  const hydrated = useSettings((s) => s.hydrated);
  const server = useSettings((s) => s.server);
  // Re-pairing on the same server issues a new token: the device id changes, so the link must restart.
  const deviceId = useSettings((s) => s.deviceId);
  useEffect(() => {
    if (!hydrated) return;
    const intent = useDshIntent.getState().pending;
    if (intent && (intent.server !== server || intent.viewer !== deviceId)) useDshIntent.setState({ pending: null });
    if (!server) {
      stopLink();
      return;
    }
    let cancelled = false;
    (async () => {
      const token = isMockServer(server) ? "mock-token" : await loadToken();
      if (!cancelled && token) startLink(server, token);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, server, deviceId]);
}

function Navigator() {
  const p = usePalette();
  useRelayLink();
  useAlertSync();
  useHarnessIconSync();
  const dsh = useDshForegroundNotice();
  return (
    <>
      <StatusBar style={p.dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerTransparent: false,
          headerStyle: { backgroundColor: p.pageTop },
          headerTintColor: p.ink,
          headerTitleStyle: { fontFamily: fonts.cute, color: p.ink, fontSize: 18 },
          headerBackButtonDisplayMode: "minimal",
          // The app's own back button instead of the system arrow.
          headerLeft: ({ canGoBack }) =>
            canGoBack ? (
              <View style={{ marginRight: 10 }}>
                <IconTile icon="back" tone="plain" size={40} onPress={() => router.back()} a11y="返回" />
              </View>
            ) : null,
          contentStyle: { backgroundColor: p.page },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="scan" options={{ title: "扫一扫", animation: "slide_from_bottom" }} />
        <Stack.Screen name="pair" options={{ title: "连接", animation: "fade" }} />
        <Stack.Screen name="join" options={{ title: "让它加入", animation: "fade" }} />
        <Stack.Screen name="pair-new" options={{ title: "邀请设备", animation: "slide_from_bottom" }} />
        <Stack.Screen name="agent/[key]" options={{ title: "" }} />
        <Stack.Screen name="dsh-task" options={{ headerShown: false }} />
        <Stack.Screen name="assistant" options={{ headerShown: false, animation: "none" }} />
      </Stack>
      <Portal>
        <Snackbar visible={dsh.notice > 0} onDismiss={dsh.dismiss} duration={4500} wrapperStyle={{ bottom: 64 }}>
          DSH：关注的会话刚才变为空闲，请在项目会话查看。
        </Snackbar>
      </Portal>
    </>
  );
}

export default function RootLayout() {
  const [loaded, error] = useFonts({
    Nunito_400Regular,
    Nunito_600SemiBold,
    Nunito_700Bold,
    [fonts.mono]: require("../../assets/fonts/MapleMono-Regular.ttf"),
    [fonts.monoBold]: require("../../assets/fonts/MapleMono-Bold.ttf"),
  });
  const hydrated = useSettings((s) => s.hydrated);
  const ready = !!(loaded || error) && hydrated;

  // The phone's own log goes to the relay every minute and when the app is put away.
  useEffect(() => startAppLog(), []);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  if (!ready) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeRoot>
        <Navigator />
      </ThemeRoot>
    </QueryClientProvider>
  );
}
