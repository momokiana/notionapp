import { useEffect, useState } from "react";
import { AppState, KeyboardAvoidingView, Pressable, ScrollView, View } from "react-native";
import { Button, HelperText, Text, TextInput } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import { parsePairInput } from "@xiaoaixiaoai/protocol";
import { Card, PageBackground, PairSuccess } from "../components/ui";
import { Sparkle } from "../components/Mascot";
import { StarlightPortrait } from "../components/Starlight";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { completePairing, defaultDeviceName, friendlyError } from "../lib/session";
import { useSettings } from "../lib/store";

const bare = (url: string) => url.replace(/^https?:\/\//i, "");

export default function ConnectScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const lastServer = useSettings((s) => s.lastServer);
  // One box takes a pair link, "server code", or just the code.
  const [input, setInput] = useState("");
  const [server, setServer] = useState(lastServer ?? "");
  const [editServer, setEditServer] = useState(!lastServer);
  const [name, setName] = useState(defaultDeviceName());
  const [editName, setEditName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  // An invite link copied from a chat or the invite page: offered as a one-tap connect.
  const [clip, setClip] = useState<{ server: string; code: string } | null>(null);
  const [clipDismissed, setClipDismissed] = useState<string | null>(null);

  useEffect(() => {
    const look = async () => {
      if (!(await Clipboard.hasStringAsync().catch(() => false))) return setClip(null);
      const text = (await Clipboard.getStringAsync().catch(() => "")).trim();
      const hit = text.length <= 500 ? parsePairInput(text) : null;
      setClip(hit?.server ? { server: hit.server, code: hit.code } : null);
    };
    void look();
    const sub = AppState.addEventListener("change", (st) => st === "active" && void look());
    return () => sub.remove();
  }, []);

  const parsed = parsePairInput(input);
  const useServer = parsed?.server ?? server.trim();
  const ready = !!parsed && !!useServer;
  const needsServer = !!parsed && !useServer;

  async function pair(srv: string, code: string) {
    setBusy(true);
    setError(null);
    try {
      await completePairing(srv, code, name);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setPaired(true);
      setTimeout(() => router.replace("/"), 1200);
    } catch (e) {
      setError(friendlyError(e));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function paste() {
    const text = (await Clipboard.getStringAsync().catch(() => "")).trim();
    if (!text) {
      setError("剪贴板里没有内容");
      return;
    }
    setError(parsePairInput(text) ? null : "剪贴板里的内容不像邀请链接或配对码");
    setInput(text);
  }

  const inputTheme = { roundness: radius.md, colors: { background: p.surface2, outline: p.outline, primary: p.skyText } };
  const line = { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, minHeight: 32 };

  return (
    <PageBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: insets.top + space.xxl, paddingHorizontal: space.xl, paddingBottom: space.xxl, gap: space.xl }}
        >
          <View style={{ alignItems: "center", gap: space.md }}>
            <StarlightPortrait size={96} mood="default" />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontFamily: fonts.cute, fontSize: 32, lineHeight: 42, color: p.ink }}>小爱小爱</Text>
              <Sparkle size={16} />
            </View>
            <Text style={{ color: p.muted, textAlign: "center", lineHeight: 21 }}>
              把每台电脑上的 agent 装进口袋{"\n"}随时看看它们在忙什么，需要你时马上回一句
            </Text>
          </View>

          {clip && clipDismissed !== clip.code ? (
            <Card style={{ padding: space.lg, gap: space.md, borderWidth: 1.5, borderColor: p.primary }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Sparkle size={14} />
                <Text style={{ flex: 1, fontFamily: fonts.bodyBold, color: p.ink, fontSize: 15 }}>剪贴板里有一个邀请</Text>
              </View>
              <Text numberOfLines={2} style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>
                {bare(clip.server)} · <Text style={{ fontFamily: fonts.mono, color: p.ink }}>{clip.code}</Text>
              </Text>
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Button mode="contained" icon="link-variant" onPress={() => pair(clip.server, clip.code)} loading={busy} disabled={busy} style={{ flex: 1, borderRadius: radius.pill }}>
                  用它连接
                </Button>
                <Button mode="text" textColor={p.ink} onPress={() => setClipDismissed(clip.code)} disabled={busy}>
                  不用
                </Button>
              </View>
            </Card>
          ) : null}

          <Card style={{ padding: space.xl, gap: space.md }}>
            <Text style={{ fontFamily: fonts.bodyBold, color: p.ink, fontSize: 15 }}>连接这台手机</Text>
            <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>
              扫一下已连上的手机里“设备 → 邀请设备”的二维码，或电脑上 <Text style={{ fontFamily: fonts.mono, color: p.ink, fontSize: 13 }}>xiaoaixiaoai pair</Text> 显示的二维码，一步连上。新服务器就扫它启动时显示的二维码。收到邀请链接的话，直接点开它。
            </Text>
            <Button mode="contained" icon="qrcode-scan" onPress={() => router.push("/scan")} contentStyle={{ height: 50 }} style={{ borderRadius: radius.pill }} labelStyle={{ fontSize: 16 }}>
              扫码配对
            </Button>

            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.xs }}>
              <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
              <Text style={{ color: p.faint, fontSize: 12 }}>扫不了就输入</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
            </View>

            <TextInput
              mode="outlined"
              label="邀请链接或配对码"
              placeholder="MEOW-4821"
              value={input}
              onChangeText={(t) => {
                setInput(t);
                setError(null);
              }}
              autoCapitalize="characters"
              autoCorrect={false}
              left={<TextInput.Icon icon="key-variant" />}
              right={<TextInput.Icon icon="content-paste" accessibilityLabel="从剪贴板粘贴" onPress={paste} />}
              theme={inputTheme}
            />

            {parsed?.server ? (
              <View style={line}>
                <Text style={{ color: p.faint, fontSize: 13 }}>服务器</Text>
                <Text numberOfLines={1} style={{ flex: 1, color: p.ink, fontFamily: fonts.mono, fontSize: 12.5 }}>
                  {bare(parsed.server)}
                </Text>
                <Text style={{ color: p.faint, fontSize: 12 }}>来自链接</Text>
              </View>
            ) : editServer ? (
              <TextInput
                mode="outlined"
                label="服务器地址"
                placeholder="https://xiaoaixiaoai.example.com"
                value={server}
                onChangeText={(t) => {
                  setServer(t);
                  setError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                left={<TextInput.Icon icon="server-network" />}
                theme={inputTheme}
              />
            ) : (
              <View style={line}>
                <Text style={{ color: p.faint, fontSize: 13 }}>服务器</Text>
                <Text numberOfLines={1} style={{ flex: 1, color: p.ink, fontFamily: fonts.mono, fontSize: 12.5 }}>
                  {bare(server)}
                </Text>
                <Pressable hitSlop={10} accessibilityRole="button" onPress={() => setEditServer(true)}>
                  <Text style={{ color: p.accentText, fontFamily: fonts.bodySemi, fontSize: 13 }}>更换</Text>
                </Pressable>
              </View>
            )}

            {editName ? (
              <TextInput mode="outlined" label="这台手机的名字" value={name} onChangeText={setName} left={<TextInput.Icon icon="cellphone" />} theme={inputTheme} />
            ) : (
              <View style={line}>
                <Text style={{ color: p.faint, fontSize: 13 }}>手机名</Text>
                <Text numberOfLines={1} style={{ flex: 1, color: p.ink, fontSize: 13.5 }}>
                  {name}
                </Text>
                <Pressable hitSlop={10} accessibilityRole="button" onPress={() => setEditName(true)}>
                  <Text style={{ color: p.accentText, fontFamily: fonts.bodySemi, fontSize: 13 }}>改名</Text>
                </Pressable>
              </View>
            )}

            {error ? (
              <HelperText type="error" visible style={{ paddingHorizontal: 0 }}>
                {error}
              </HelperText>
            ) : needsServer ? (
              <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18 }}>
                只有配对码时还要填服务器地址，也就是电脑登记用的那个地址。扫码或粘贴邀请链接就不用填。
              </Text>
            ) : input.trim() && !parsed ? (
              <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18 }}>配对码长这样：MEOW-4821，10 分钟内有效，只能用一次。</Text>
            ) : null}

            <Button
              mode="contained-tonal"
              onPress={() => parsed && pair(useServer, parsed.code)}
              loading={busy}
              disabled={busy || !ready}
              contentStyle={{ height: 48 }}
              style={{ borderRadius: radius.pill }}
            >
              用配对码连接
            </Button>
          </Card>

          <Button mode="text" textColor={p.accentText} onPress={() => pair("mock://demo", "DEMO")} disabled={busy} compact>
            还没有服务器？先逛逛演示数据
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
      {paired ? <PairSuccess sub="爱弥斯开始帮你盯着啦" /> : null}
    </PageBackground>
  );
}
