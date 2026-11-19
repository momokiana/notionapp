/**
 * Looks for a new app version in the background and, once per version, asks gently.
 * After that the news only stays in Settings.
 */
import { useEffect } from "react";
import { AppState, View } from "react-native";
import { Button, Dialog, Portal, Text } from "react-native-paper";
import { router } from "expo-router";
import { checkForUpdate, currentVersion, downloadUpdate, useNewRelease, useUpdate } from "../lib/update";
import { useSettings } from "../lib/store";
import { Mascot } from "./Mascot";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";

export function UpdatePrompt() {
  const p = usePalette();
  const release = useNewRelease();
  const phase = useUpdate((s) => s.phase);
  const prompted = useSettings((s) => s.updatePrompted);

  useEffect(() => {
    void checkForUpdate();
    const sub = AppState.addEventListener("change", (st) => st === "active" && void checkForUpdate());
    return () => sub.remove();
  }, []);

  const visible = !!release && phase === "available" && prompted !== release.version;
  const close = () => release && useSettings.getState().set({ updatePrompted: release.version });

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={close} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
        <View style={{ alignItems: "center", paddingTop: space.lg }}>
          <Mascot mood="hello" size={72} />
        </View>
        <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink, textAlign: "center" }}>有新版本啦</Dialog.Title>
        <Dialog.Content style={{ gap: space.sm }}>
          <Text style={{ color: p.muted, lineHeight: 22, textAlign: "center" }}>
            小爱小爱 v{release?.version} 已经发布，你现在用的是 v{currentVersion()}。
          </Text>
          {release?.notes ? (
            <Text numberOfLines={4} style={{ color: p.faint, fontSize: 13, lineHeight: 19, textAlign: "center" }}>
              {release.notes}
            </Text>
          ) : null}
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={close} textColor={p.ink}>
            以后再说
          </Button>
          <Button
            textColor={p.accentText}
            onPress={() => {
              close();
              router.navigate("/settings");
              void downloadUpdate();
            }}
          >
            现在更新
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
