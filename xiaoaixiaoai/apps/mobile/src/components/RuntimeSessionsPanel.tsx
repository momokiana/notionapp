import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActivityIndicator, Button, Dialog, Portal, Text, TextInput } from "react-native-paper";
import { useQuery } from "@tanstack/react-query";
import {
  isRuntimeRequestId, RUNTIME_SESSION_TEXT_LIMIT,
  type Device, type RuntimeProject, type RuntimeSession, type RuntimeSessionReceipt, type SessionRuntime,
} from "@xiaoaixiaoai/protocol";
import { call, RelayError } from "../lib/relay";
import { relTime } from "../lib/format";
import { useLive, useSettings } from "../lib/store";
import { fonts, radius, space } from "../theme/tokens";
import { usePalette } from "../theme/theme";
import { RuntimeSessionDetailCard } from "./RuntimeSessionDetailCard";
import { Card, PageBackground, PageTitle } from "./ui";

const RUNTIME: Record<SessionRuntime, string> = { dsh: "DSH", codex: "Codex", antigravity: "Antigravity" };
const STATE = { running: "工作中", idle: "空闲", inactive: "未加载", attention: "等待回答", unknown: "状态未知" } as const;
const DENIED = new Set(["bad_request", "forbidden", "not_found", "unsupported"]);

/** Correlation only. This identifier is not a credential. */
function requestId() {
  const native = globalThis.crypto?.randomUUID?.();
  if (isRuntimeRequestId(native)) return native;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (part) => {
    const bits = Math.floor(Math.random() * 16);
    return (part === "x" ? bits : (bits & 3) | 8).toString(16);
  });
}

type Target = { project: RuntimeProject; session: RuntimeSession };
function caption(t: Target) { return `${RUNTIME[t.project.runtime]} · ${t.project.title} / ${t.session.title}`; }

function findFocusTarget(data: { projects: RuntimeProject[] } | undefined, focusSessionId: string | undefined): Target | undefined {
  if (!focusSessionId || !data) return undefined;
  for (const project of data.projects) {
    const session = project.sessions.find((s) => s.id === focusSessionId);
    if (session) return { project, session };
  }
  return undefined;
}

export function RuntimeSessionsPanel({ host, onBack, focusSessionId }: { host: Device; onBack: () => void; focusSessionId?: string }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  const self = useLive((s) => s.self?.id);
  const server = useSettings((s) => s.server);
  const [target, setTarget] = useState<Target>();
  const [openTarget, setOpenTarget] = useState<Target>();
  const [dismissedFocus, setDismissedFocus] = useState(false);
  const [runtimeFilter, setRuntimeFilter] = useState<SessionRuntime | "all">("all");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [result, setResult] = useState<{ text: string; warn?: boolean }>();
  const query = useQuery({
    queryKey: ["runtime-sessions", server, self, host.id],
    queryFn: () => call(host.id, "runtimeSessions.list", {}),
    enabled: host.online && focused && !!self, retry: false, gcTime: 0,
    refetchInterval: (q) => focused && q.state.status === "success" ? 5000 : false,
  });
  // Never render stale rows or make them writable while a refresh is denied.
  const hideSensitive = !host.online || !focused || (query.error instanceof RelayError && (query.error.code === "forbidden" || query.error.code === "unauthorized"));
  const data = !hideSensitive && query.isSuccess ? query.data : undefined;
  const activeDetail = openTarget ?? (!dismissedFocus ? findFocusTarget(data, focusSessionId) : undefined);

  const availableRuntimes = useMemo(() => {
    if (!data) return [];
    const seen = new Set<SessionRuntime>();
    for (const r of data.runtimes) seen.add(r.runtime);
    for (const pr of data.projects) seen.add(pr.runtime);
    return [...seen];
  }, [data]);

  const filteredProjects = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    return data.projects
      .filter((pr) => runtimeFilter === "all" || pr.runtime === runtimeFilter)
      .map((pr) => {
        if (!needle) return pr;
        const projHit = pr.title.toLowerCase().includes(needle) || pr.id.toLowerCase().includes(needle);
        if (projHit) return pr;
        const sessions = pr.sessions.filter((s) => s.title.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle));
        return sessions.length ? { ...pr, sessions } : null;
      })
      .filter((pr): pr is RuntimeProject => pr !== null);
  }, [data, runtimeFilter, search]);

  const selected = data?.projects.find((x) => x.runtime === target?.project.runtime && x.id === target.project.id)
    ?.sessions.find((x) => x.id === target?.session.id);
  const allowed = !!selected?.canSend && host.online && focused;

  async function submit() {
    if (!target || !allowed || !draft.trim() || pending.current) { setConfirm(false); return; }
    pending.current = true;
    setBusy(true);
    const id = requestId();
    const name = caption(target);
    try {
      const receipt: RuntimeSessionReceipt = await call(host.id, "runtimeSessions.send", {
        runtime: target.project.runtime, projectId: target.project.id, sessionId: target.session.id, requestId: id, input: draft,
      }, 20_000);
      if (receipt?.accepted !== true || receipt.requestId !== id) throw new Error("unverified receipt");
      setResult({ text: `「${name}」已接收。接收不代表已完成。`, warn: false });
      setDraft("");
      setTarget(undefined);
    } catch (e) {
      if (e instanceof RelayError && DENIED.has(e.code)) setResult({ text: e.message, warn: true });
      else {
        setDraft("");
        setTarget(undefined);
        setResult({ text: `没收到「${name}」的明确回执。请先在原会话核对，不要重发。`, warn: true });
      }
    } finally {
      pending.current = false;
      setBusy(false);
      setConfirm(false);
      void query.refetch();
    }
  }

  return (
    <PageBackground>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.md, gap: space.md, paddingBottom: space.xxl }}>
        <Button icon="arrow-left" disabled={busy} onPress={onBack} style={{ alignSelf: "flex-start" }}>返回设备</Button>
        <PageTitle sub={host.name}>项目会话</PageTitle>
        <Text style={{ color: p.muted }}>只显示这台电脑明确分享的会话。点“查看对话”可读最近消息并在支持时直接提交选项；不会开启新会话或代替你批准系统工具操作。</Text>
        {activeDetail && !hideSensitive ? (
          <RuntimeSessionDetailCard
            hostId={host.id}
            runtime={activeDetail.project.runtime}
            projectId={activeDetail.project.id}
            projectTitle={activeDetail.project.title}
            sessionId={activeDetail.session.id}
            sessionTitle={activeDetail.session.title}
            canSendHint={activeDetail.session.canSend}
            onNotice={setResult}
            onBack={() => { setOpenTarget(undefined); setDismissedFocus(true); void query.refetch(); }}
          />
        ) : (
          <>
            <Button icon="refresh" mode="outlined" disabled={!host.online || busy} onPress={() => void query.refetch()}>刷新状态</Button>
            {result && !hideSensitive ? <Text accessibilityLiveRegion="polite" style={{ color: result.warn ? p.error : p.ink, lineHeight: 20 }}>{result.text}</Text> : null}
            {!host.online ? <Text style={{ color: p.muted }}>电脑当前离线。</Text> : null}
            {host.online && query.isLoading ? <ActivityIndicator /> : null}
            {host.online && query.isError ? <Text style={{ color: p.error }}>{query.error instanceof RelayError ? query.error.message : "暂时无法读取项目会话。"}</Text> : null}
            {data?.runtimes.map((r: { runtime: SessionRuntime; online: boolean }) => !r.online ? (
              <Text key={r.runtime} style={{ color: p.muted }}>{RUNTIME[r.runtime]} 本机连接暂不可用</Text>
            ) : null)}
            {availableRuntimes.length > 1 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                <Button compact mode={runtimeFilter === "all" ? "contained" : "outlined"} onPress={() => setRuntimeFilter("all")}>全部</Button>
                {availableRuntimes.map((rt) => (
                  <Button key={rt} compact mode={runtimeFilter === rt ? "contained" : "outlined"} onPress={() => setRuntimeFilter(rt)}>{RUNTIME[rt]}</Button>
                ))}
              </View>
            ) : null}
            {data && data.projects.length > 0 ? (
              <TextInput
                mode="outlined"
                label="按项目或会话标题过滤"
                value={search}
                onChangeText={setSearch}
              />
            ) : null}
            {data && !filteredProjects.length ? <Text style={{ color: p.muted }}>{data.projects.length ? "没有匹配的可见项目或会话。" : "目前没有可查看的项目。"}</Text> : null}
            {target && !hideSensitive ? (
              <Card style={{ padding: space.md, gap: space.sm }}>
                <Text style={{ color: p.ink, fontFamily: fonts.bodyBold }}>发送到：{caption(target)}</Text>
                <Text selectable style={{ color: p.muted, fontSize: 12 }}>会话 ID：{target.session.id}</Text>
                <TextInput label="任务内容" mode="outlined" multiline maxLength={RUNTIME_SESSION_TEXT_LIMIT} value={draft} editable={!busy && allowed} onChangeText={setDraft} />
                {!allowed ? <Text style={{ color: p.error }}>目标当前不可发，请先刷新核对。</Text> : null}
                <Button mode="contained" disabled={!allowed || busy || !draft.trim()} onPress={() => setConfirm(true)}>确认目标</Button>
                <Button disabled={busy} onPress={() => { setDraft(""); setTarget(undefined); }}>取消编辑</Button>
              </Card>
            ) : null}
            {filteredProjects.map((project) => (
              <Card key={`${project.runtime}:${project.id}`} style={{ padding: space.md, gap: space.sm }}>
                <Text style={{ color: p.ink, fontFamily: fonts.cute, fontSize: 20 }}>{RUNTIME[project.runtime]} · {project.title}</Text>
                {!project.sessions.length ? <Text style={{ color: p.muted }}>暂无可见会话</Text> : null}
                {project.sessions.map((session) => {
                  const attention = session.state === "attention";
                  return (
                    <View key={session.id} style={{ paddingVertical: space.xs, borderTopWidth: 1, borderColor: p.divider, gap: space.xs }}>
                      <Text style={{ color: p.ink, fontFamily: fonts.bodySemi }}>{session.title}</Text>
                      <Text style={{ color: p.muted }}>{STATE[session.state] ?? "状态未知"} · {session.canSend ? "可发送" : "只读"}{session.updatedAt ? ` · ${relTime(session.updatedAt)}` : ""} · {session.id.slice(-8)}</Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                        <Button
                          compact
                          mode={attention ? "contained-tonal" : "outlined"}
                          disabled={busy || !!target}
                          onPress={() => { setResult(undefined); setOpenTarget({ project, session }); }}
                        >
                          {attention ? "查看对话 · 待选问题" : "查看对话"}
                        </Button>
                        {session.canSend ? <Button compact disabled={busy || !!target} onPress={() => { setResult(undefined); setTarget({ project, session }); }}>选中这个会话</Button> : null}
                      </View>
                    </View>
                  );
                })}
              </Card>
            ))}
          </>
        )}
      </ScrollView>
      <Portal>
        <Dialog visible={confirm && !hideSensitive} dismissable={!busy} onDismiss={() => setConfirm(false)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title>发送给这个会话？</Dialog.Title>
          <Dialog.Content style={{ gap: space.sm }}>
            {target ? <Text>{caption(target)} · {target.session.id}</Text> : null}
            <Text numberOfLines={5} style={{ color: p.muted }}>{draft}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button disabled={busy} onPress={() => setConfirm(false)}>取消</Button>
            <Button disabled={busy || !allowed} loading={busy} onPress={() => void submit()}>发送一次</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </PageBackground>
  );
}
