/** Deep link target: herdrpocket://join?server=...&id=... — another device asks this phone to let it in. */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { ActivityIndicator, Button, Text } from "react-native-paper";
import { router, useLocalSearchParams } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import type { Device, JoinRequest } from "@xiaoaixiaoai/protocol";
import { Card, PageBackground } from "../components/ui";
import { Mascot } from "../components/Mascot";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { answerJoinRequest, getJoinRequest, normalizeServer } from "../lib/relay";
import { loadToken } from "../lib/auth";
import { isMockServer } from "../lib/mock";
import { friendlyError } from "../lib/session";
import { useSettings } from "../lib/store";

const PLATFORM: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows", android: "Android", ios: "iOS" };
const bare = (url: string) => url.replace(/^https?:\/\//i, "");

export default function JoinScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{ server?: string; id?: string }>();
  const mine = useSettings((s) => s.server);
  const [req, setReq] = useState<JoinRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [joined, setJoined] = useState<Device | null>(null);

  const theirs = params.server ? normalizeServer(String(params.server)) : null;
  const id = params.id ? String(params.id) : null;
  // In demo mode any join QR is accepted so the flow can be tried.
  const sameServer = !!mine && !!theirs && (isMockServer(mine) || theirs === mine);

  useEffect(() => {
    if (!mine || !theirs || !id) return;
    if (!sameServer) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await getJoinRequest(mine, (await loadToken()) ?? "mock-token", id);
        if (!cancelled) setReq(r);
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mine, theirs, id, sameServer]);

  async function answer(allow: boolean) {
    if (!mine || !id) return;
    setBusy(allow ? "allow" : "deny");
    setError(null);
    try {
      const d = await answerJoinRequest(mine, (await loadToken()) ?? "mock-token", id, allow);
      if (allow && d) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        setJoined(d);
      } else router.back();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  const done = () => (router.canGoBack() ? router.back() : router.replace("/devices"));
  const center = { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, padding: space.xxl, gap: space.md };

  let problem: { title: string; body: string; action?: { label: string; go: () => void } } | null = null;
  if (!theirs || !id) problem = { title: "这个二维码不完整", body: "让对方重新显示一次二维码。" };
  else if (!mine) problem = { title: "这台手机还没连上", body: "先把这台手机连到服务器，才能让别的设备加入。", action: { label: "去连接", go: () => router.replace("/connect") } };
  else if (!sameServer) problem = { title: "不是同一个服务器", body: `这个二维码属于 ${bare(theirs)}，这台手机连的是 ${bare(mine)}。` };
  else if (error && !req) problem = { title: "没找到这个加入请求", body: error };

  if (problem) {
    return (
      <PageBackground>
        <View style={center}>
          <Mascot mood="waiting" size={104} />
          <Text style={{ fontFamily: fonts.cute, fontSize: 22, color: p.ink, textAlign: "center" }}>{problem.title}</Text>
          <Text style={{ color: p.muted, textAlign: "center", lineHeight: 21 }}>{problem.body}</Text>
          <Button mode="contained" onPress={problem.action?.go ?? done} style={{ borderRadius: radius.pill, marginTop: space.sm }}>
            {problem.action?.label ?? "返回"}
          </Button>
        </View>
      </PageBackground>
    );
  }

  if (joined) {
    return (
      <PageBackground>
        <View style={center}>
          <Mascot mood="yay" size={150} />
          <Text style={{ fontFamily: fonts.cute, fontSize: 26, lineHeight: 34, color: p.ink, textAlign: "center" }}>“{joined.name}”加入啦</Text>
          <Text style={{ color: p.muted, textAlign: "center", lineHeight: 21 }}>
            {joined.kind === "host" ? "它上线后，上面的 agent 会出现在列表里。" : "那台设备已经可以看到你的 agent 了。"}
          </Text>
          <Button mode="contained" onPress={done} contentStyle={{ height: 48 }} style={{ borderRadius: radius.pill, marginTop: space.md, alignSelf: "stretch" }}>
            完成
          </Button>
        </View>
      </PageBackground>
    );
  }

  if (!req) {
    return (
      <PageBackground>
        <View style={center}>
          <ActivityIndicator />
          <Text style={{ color: p.faint }}>正在读取加入请求…</Text>
        </View>
      </PageBackground>
    );
  }

  const host = req.kind === "host";
  return (
    <PageBackground>
      <View style={{ flex: 1, justifyContent: "center", padding: space.xl, gap: space.lg }}>
        <View style={{ alignItems: "center", gap: space.sm }}>
          <Mascot mood="hello" size={96} />
          <Text style={{ fontFamily: fonts.cute, fontSize: 24, lineHeight: 32, color: p.ink }}>让它加入吗？</Text>
        </View>
        <Card style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: host ? p.lavenderContainer : p.accentContainer, alignItems: "center", justifyContent: "center" }}>
            <MaterialCommunityIcons name={host ? "laptop" : "cellphone"} size={24} color={p.ink} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text numberOfLines={2} style={{ fontFamily: fonts.bodyBold, fontSize: 17, color: p.ink }}>
              {req.name}
            </Text>
            <Text style={{ color: p.muted, fontSize: 13 }}>{[host ? "电脑" : "手机 / 客户端", PLATFORM[req.platform ?? ""] ?? req.platform].filter(Boolean).join(" · ")}</Text>
          </View>
        </Card>
        <Text style={{ color: p.muted, lineHeight: 21, textAlign: "center" }}>
          {host ? "允许后，这台电脑上的 agent 会出现在你的列表里，也能被你的其他设备查看和操作。" : "允许后，那台设备能查看和操作你所有电脑上的 agent。"}
          {"\n"}只允许你自己正在操作的设备。
        </Text>
        {error ? <Text style={{ color: p.error, textAlign: "center" }}>{error}</Text> : null}
        <View style={{ gap: space.sm }}>
          <Button mode="contained" loading={busy === "allow"} disabled={!!busy} onPress={() => answer(true)} contentStyle={{ height: 52 }} style={{ borderRadius: radius.pill }} labelStyle={{ fontSize: 16 }}>
            允许加入
          </Button>
          <Button mode="text" textColor={p.ink} loading={busy === "deny"} disabled={!!busy} onPress={() => answer(false)}>
            拒绝
          </Button>
        </View>
      </View>
    </PageBackground>
  );
}
