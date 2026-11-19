import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Text } from "react-native-paper";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { parseJoinLink, parsePairLink } from "@xiaoaixiaoai/protocol";
import { EmptyState, PageBackground } from "../components/ui";
import { usePalette } from "../theme/theme";
import { radius, space } from "../theme/tokens";
import { markScannedInvite } from "../lib/session";

export default function ScanScreen() {
  const p = usePalette();
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState("对准邀请二维码，或新设备显示的加入二维码");
  const handled = useRef(false);

  if (!permission) return <PageBackground />;
  if (!permission.granted) {
    return (
      <PageBackground>
        <EmptyState
          mood="waiting"
          title="需要用一下相机"
          body="只用来扫二维码，不会拍照或录像。"
          action={
            <Button mode="contained" onPress={requestPermission} style={{ borderRadius: radius.pill }}>
              允许使用相机
            </Button>
          }
        />
      </PageBackground>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          // Two kinds of QR: an invite (this phone joins) and a join request (this phone lets another device in).
          const invite = parsePairLink(data);
          const join = invite ? null : parseJoinLink(data);
          if (!invite && !join) {
            setHint("这不是 小爱小爱 的二维码哦");
            return;
          }
          handled.current = true;
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
          if (invite) {
            markScannedInvite(invite.server, invite.code);
            router.replace({ pathname: "/pair", params: invite });
          }
          else router.replace({ pathname: "/join", params: join! });
        }}
      />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }} pointerEvents="none">
        <View style={{ width: 240, height: 240, borderRadius: radius.xl, borderWidth: 3, borderColor: p.accentContainer }} />
        <View style={{ marginTop: space.xl, backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill }}>
          <Text style={{ color: "#fff" }}>{hint}</Text>
        </View>
      </View>
    </View>
  );
}
