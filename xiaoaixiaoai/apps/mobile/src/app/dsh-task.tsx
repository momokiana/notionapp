import { router, useLocalSearchParams } from "expo-router";
import { isRuntimeId } from "@xiaoaixiaoai/protocol";
import { View } from "react-native";
import { Button, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DshDirectoryPanel } from "../components/DshDirectoryPanel";
import { PageBackground, PageTitle } from "../components/ui";
import { useLive, useSettings } from "../lib/store";
import { usePalette } from "../theme/theme";
import { space } from "../theme/tokens";

/** Notification links nominate an exact row, never a trusted principal or a send action. */
export default function DshTaskScreen() {
  const params = useLocalSearchParams<{ host?: string; session?: string }>();
  const viewer = useSettings((s) => s.deviceId);
  const self = useLive((s) => s.self?.id);
  const host = useLive((s) => isRuntimeId(params.host) ? s.devices[params.host] : undefined);
  const insets = useSafeAreaInsets();
  const p = usePalette();
  const back = () => { if (router.canGoBack()) router.back(); else router.replace("/devices"); };
  if (viewer && self === viewer && host?.kind === "host" && host.sources?.includes("dsh-directory") && isRuntimeId(params.session)) {
    return <DshDirectoryPanel key={`${host.id}:${params.session}`} host={host} onBack={back} focusSessionId={params.session} />;
  }
  return (
    <PageBackground>
      <View style={{ padding: space.lg, paddingTop: insets.top + space.lg, gap: space.md }}>
        <PageTitle>DSH 任务</PageTitle>
        <Text style={{ color: p.muted }}>等待已配对电脑连上；只有原授权仍有效时才显示目标会话。</Text>
        <Button mode="outlined" onPress={() => router.replace("/devices")}>打开设备</Button>
      </View>
    </PageBackground>
  );
}
