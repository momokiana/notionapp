/** Deep link target: herdrpocket://pair?server=...&code=... (also what the scanner opens for an invite QR). */
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { ActivityIndicator, Button, Text } from "react-native-paper";
import { router, useLocalSearchParams } from "expo-router";
import { PageBackground, PairSuccess } from "../components/ui";
import { Mascot } from "../components/Mascot";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { completePairing, defaultDeviceName, friendlyError, takeScannedInvite } from "../lib/session";
import { normalizeServer } from "../lib/relay";
import { isMockServer } from "../lib/mock";
import { useSettings } from "../lib/store";

const bare = (url: string) => url.replace(/^https?:\/\//i, "");

export default function PairLinkScreen() {
  const p = usePalette();
  const { server, code } = useLocalSearchParams<{ server?: string; code?: string }>();
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  // Already set up before this link arrived: a failed link must not strand the person on the onboarding screen.
  const [mine] = useState(() => {
    const s = useSettings.getState().server;
    return s && !isMockServer(s) ? s : null;
  });
  // A link opened from a browser or chat on a phone that is already connected asks first.
  const [go, setGo] = useState(() => !mine || (!!server && !!code && takeScannedInvite(String(server), String(code))));

  // A pair code works once: never send the same link twice (effects can re-run).
  const tried = useRef<string | null>(null);

  useEffect(() => {
    if (!server || !code || !go) return;
    const key = `${server} ${code}`;
    if (tried.current === key) return;
    tried.current = key;
    completePairing(String(server), String(code), defaultDeviceName())
      .then(() => {
        setPaired(true);
        setTimeout(() => router.replace("/"), 1200);
      })
      .catch((e) => setError(friendlyError(e)));
  }, [server, code, go]);

  const problem = !server || !code ? "这个邀请链接不完整" : error;
  const back = () => (mine ? router.replace("/") : router.replace("/connect"));

  if (!problem && !go) {
    const same = normalizeServer(String(server)) === mine;
    return (
      <PageBackground>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl, gap: space.lg }}>
          <Mascot size={104} mood="hello" />
          <Text style={{ fontFamily: fonts.cute, fontSize: 22, lineHeight: 30, color: p.ink, textAlign: "center" }}>
            {same ? "用这个邀请重新连接？" : "换到这个服务器？"}
          </Text>
          <Text style={{ color: p.muted, textAlign: "center", lineHeight: 21 }}>
            {same
              ? `这台手机已经连着 ${bare(mine!)}。重新连接会换一个新授权，原来的授权作废。`
              : `这台手机现在连着 ${bare(mine!)}。连到 ${bare(String(server))} 后，原来的连接会断开，那边的设备列表里也会移除这台手机。`}
          </Text>
          <View style={{ alignSelf: "stretch", gap: space.sm, marginTop: space.sm }}>
            <Button mode="contained" onPress={() => setGo(true)} contentStyle={{ height: 50 }} style={{ borderRadius: radius.pill }} labelStyle={{ fontSize: 16 }}>
              {same ? "重新连接" : "换过去"}
            </Button>
            <Button mode="text" textColor={p.ink} onPress={back}>
              不用了
            </Button>
          </View>
        </View>
      </PageBackground>
    );
  }

  return (
    <PageBackground>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl, gap: space.lg }}>
        <Mascot size={104} mood={problem ? "waiting" : "hello"} />
        {problem ? (
          <>
            <Text style={{ fontFamily: fonts.cute, fontSize: 22, color: p.ink }}>配对没成功</Text>
            <Text style={{ color: p.faint, textAlign: "center" }}>{problem}</Text>
            <Button mode="contained" icon="qrcode-scan" onPress={() => router.replace("/scan")} style={{ borderRadius: radius.pill }}>
              重新扫码
            </Button>
            <Button mode="text" textColor={p.accentText} onPress={back}>
              {mine ? "回到列表" : "手动输入配对码"}
            </Button>
          </>
        ) : (
          <>
            <ActivityIndicator />
            <Text style={{ fontFamily: fonts.cute, fontSize: 22, color: p.ink }}>正在配对…</Text>
            <Text style={{ color: p.faint }}>{bare(String(server ?? ""))}</Text>
          </>
        )}
      </View>
      {paired ? <PairSuccess /> : null}
    </PageBackground>
  );
}
