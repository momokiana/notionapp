import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Pressable, View } from "react-native";
import { ActivityIndicator, Button, Dialog, Portal, Text, TextInput } from "react-native-paper";
import Markdown from "react-native-markdown-display";
import { useIsFocused } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  isRuntimeRequestId,
  RUNTIME_SESSION_TEXT_LIMIT,
  type RuntimePendingQuestion,
  type RuntimeQuestionAnswerItem,
  type RuntimeSessionReceipt,
  type RuntimeSessionState,
  type SessionRuntime,
} from "@xiaoaixiaoai/protocol";
import { useAppActive } from "../lib/dsh-runtime";
import { fixCjkEmphasis } from "../lib/markdown";
import { call, RelayError } from "../lib/relay";
import { useLive, useSettings } from "../lib/store";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { mdStyles } from "./chat";
import { Card } from "./ui";

const RUNTIME_LABEL: Record<SessionRuntime, string> = { dsh: "DSH", codex: "Codex", antigravity: "Antigravity" };
const STATE_LABEL: Record<RuntimeSessionState, string> = {
  running: "工作中",
  idle: "空闲",
  inactive: "未加载",
  attention: "等待回答",
  unknown: "状态未知",
};
const QUESTION_STATE_NOTE: Record<RuntimePendingQuestion["state"], string> = {
  open: "等待你的选择（手机或电脑任一端回答即可）",
  continued: "等待补充回答（超时挂起，提交后继续执行）",
  readonly: "待选问题（只读预览，请在电脑端回答）",
};
const DENIED = new Set(["bad_request", "unauthorized", "forbidden", "not_found", "unsupported"]);

function requestId() {
  const native = globalThis.crypto?.randomUUID?.();
  if (isRuntimeRequestId(native)) return native;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (part) => {
    const bits = Math.floor(Math.random() * 16);
    return (part === "x" ? bits : (bits & 3) | 8).toString(16);
  });
}

function clock(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function detailErrorText(err: unknown): string {
  if (err instanceof RelayError) {
    if (err.code === "unsupported") return "这台电脑还没有升级到 0.2.0，请升级电脑端后查看对话详情与待选问题。";
    if (err.code === "forbidden" || err.code === "unauthorized") return "当前手机无权查看这个会话的详情。";
    if (err.code === "not_found") return "找不到这个会话，可能已被移除、归档或移动。";
    if (err.message) return err.message;
  }
  return "暂时无法读取会话消息。";
}

type QuestionDraftMap = Record<string, Record<string, { selected: string[]; custom: string }>>;

export function RuntimeSessionDetailCard({
  hostId,
  runtime,
  projectId,
  projectTitle,
  sessionId,
  sessionTitle,
  canSendHint,
  initialDraft,
  current,
  onBack,
  onNotice,
}: {
  hostId: string;
  runtime: SessionRuntime;
  projectId: string;
  projectTitle: string;
  sessionId: string;
  sessionTitle: string;
  canSendHint?: boolean;
  initialDraft?: string;
  current?: () => boolean;
  onBack: () => void;
  onNotice?: (notice: { text: string; warn?: boolean }) => void;
}) {
  const p = usePalette();
  const focused = useIsFocused();
  const active = useAppActive();
  const self = useLive((s) => s.self?.id);
  const server = useSettings((s) => s.server);
  const scale = useSettings((s) => s.textScale);
  const styles = useMemo(() => mdStyles(p, scale), [p, scale]);

  const [statusNote, setStatusNote] = useState<{ text: string; warn?: boolean }>();
  const [answersByCall, setAnswersByCall] = useState<QuestionDraftMap>({});
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [confirmSend, setConfirmSend] = useState(false);
  const [busyAction, setBusyAction] = useState<"answer" | "send" | null>(null);

  const actionPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const canPoll = focused && active && (!current || current());
  const query = useQuery({
    queryKey: ["runtime-session-detail", server, self, hostId, runtime, projectId, sessionId],
    queryFn: () => call(hostId, "runtimeSessions.detail", { runtime, projectId, sessionId, limit: 60 }, 15_000),
    enabled: canPoll && !!self,
    retry: false,
    gcTime: 0,
    refetchInterval: (q) => canPoll && q.state.status === "success" && !actionPending.current ? 5000 : false,
  });

  const detail = query.isSuccess ? query.data : undefined;
  const errorText = query.isError ? detailErrorText(query.error) : undefined;
  const refreshing = query.isFetching;

  const sessionState = detail?.session.state ?? "unknown";
  const effectiveProject = detail?.project.title ?? projectTitle;
  const effectiveTitle = detail?.session.title ?? sessionTitle;
  const canSend = detail ? detail.session.canSend === true : !!canSendHint;
  const canSubmitDraft = !!detail?.session.canSend && !!draft.trim() && !/[\0\uD800-\uDFFF]/u.test(draft) && draft.length <= RUNTIME_SESSION_TEXT_LIMIT;

  function toggleOption(callId: string, qId: string, label: string, multiSelect: boolean) {
    setAnswersByCall((prev) => {
      const forCall = prev[callId] ?? {};
      const entry = forCall[qId] ?? { selected: [], custom: "" };
      const selected = multiSelect
        ? (entry.selected.includes(label) ? entry.selected.filter((x) => x !== label) : [...entry.selected, label])
        : [label];
      return { ...prev, [callId]: { ...forCall, [qId]: { ...entry, selected } } };
    });
  }

  function setCustomAnswer(callId: string, qId: string, custom: string) {
    setAnswersByCall((prev) => {
      const forCall = prev[callId] ?? {};
      const entry = forCall[qId] ?? { selected: [], custom: "" };
      return { ...prev, [callId]: { ...forCall, [qId]: { ...entry, custom } } };
    });
  }

  async function submitQuestionAnswer(pq: RuntimePendingQuestion) {
    if (actionPending.current || !detail?.session.canSend || pq.state === "readonly") return;
    if (current && !current()) return;
    const forCall = answersByCall[pq.callId] ?? {};
    const answers: RuntimeQuestionAnswerItem[] = pq.questions.map((q) => {
      const item = forCall[q.id] ?? { selected: [], custom: "" };
      const custom = item.custom.trim();
      return { id: q.id, selected: item.selected, ...(custom ? { custom } : {}) };
    });
    if (answers.some((a) => !a.selected.length && !a.custom)) {
      setStatusNote({ text: "请先完成所有问题再提交回答。", warn: true });
      return;
    }
    actionPending.current = true;
    setBusyAction("answer");
    setStatusNote(undefined);
    Keyboard.dismiss();
    const id = requestId();
    try {
      const receipt: RuntimeSessionReceipt = await call(hostId, "runtimeSessions.answer", {
        runtime,
        projectId,
        sessionId,
        requestId: id,
        callId: pq.callId,
        answers,
      }, 20_000);
      if (receipt?.accepted !== true || receipt.requestId !== id) throw new Error("unverified receipt");
      if (!mounted.current) return;
      setAnswersByCall((prev) => {
        const next = { ...prev };
        delete next[pq.callId];
        return next;
      });
      const ok = { text: "回答已送到原会话，任务会继续推进。" };
      setStatusNote(ok);
      onNotice?.(ok);
      await query.refetch();
    } catch (err) {
      if (!mounted.current) return;
      const msg = err instanceof RelayError && DENIED.has(err.code)
        ? (err.message || "原会话当前无法接收该回答，请先刷新核对。")
        : "未收到明确回执，请刷新后核对原会话是否已继续。";
      const note = { text: msg, warn: true };
      setStatusNote(note);
      onNotice?.(note);
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusyAction(null);
    }
  }

  async function submitMessage() {
    if (actionPending.current || !canSubmitDraft) {
      setConfirmSend(false);
      return;
    }
    if (current && !current()) return;
    actionPending.current = true;
    setBusyAction("send");
    setConfirmSend(false);
    setStatusNote(undefined);
    Keyboard.dismiss();
    const id = requestId();
    const payload = draft;
    try {
      const receipt: RuntimeSessionReceipt = await call(hostId, "runtimeSessions.send", {
        runtime,
        projectId,
        sessionId,
        requestId: id,
        input: payload,
      }, 20_000);
      if (receipt?.accepted !== true || receipt.requestId !== id) throw new Error("unverified receipt");
      if (!mounted.current) return;
      setDraft("");
      const ok = { text: "已收到回执，任务已排入原会话。" };
      setStatusNote(ok);
      onNotice?.(ok);
      await query.refetch();
    } catch (err) {
      if (!mounted.current) return;
      const warnText = err instanceof RelayError && DENIED.has(err.code)
        ? (err.message || "目标当前拒绝发送，请先刷新状态。")
        : "未收到明确回执。请先在电脑的原会话核对，不要重发。";
      if (!(err instanceof RelayError && DENIED.has(err.code))) setDraft("");
      const note = { text: warnText, warn: true };
      setStatusNote(note);
      onNotice?.(note);
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusyAction(null);
    }
  }

  return (
    <View style={{ gap: space.md }}>
      <Card flat style={{ padding: space.md, gap: space.sm }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          <Button icon="arrow-left" mode="outlined" disabled={busyAction !== null} onPress={onBack}>返回会话列表</Button>
          <Button icon="refresh" mode="outlined" disabled={refreshing || busyAction !== null} onPress={() => void query.refetch()}>刷新对话</Button>
        </View>
        <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 12.5 }}>
          {RUNTIME_LABEL[runtime]} · {effectiveProject}
        </Text>
        <Text style={{ color: p.ink, fontFamily: fonts.bodyBold, fontSize: 17 }}>{effectiveTitle}</Text>
        <Text style={{ color: p.muted, fontSize: 13 }}>
          {STATE_LABEL[sessionState] ?? "状态未知"} · {canSend ? "可发送" : "只读"} · {sessionId.slice(-8)}
        </Text>
        {detail?.readOnlyReason ? (
          <View style={{ backgroundColor: p.surface2, borderRadius: radius.md, padding: space.sm }}>
            <Text style={{ color: p.muted, fontSize: 13, lineHeight: 19 }}>{detail.readOnlyReason}</Text>
          </View>
        ) : null}
        {statusNote ? (
          <Text accessibilityLiveRegion="polite" style={{ color: statusNote.warn ? p.error : p.ink, lineHeight: 20 }}>
            {statusNote.text}
          </Text>
        ) : null}
        {errorText ? (
          <Text accessibilityLiveRegion="polite" style={{ color: p.error, lineHeight: 20 }}>{errorText}</Text>
        ) : null}
      </Card>

      {!detail && !errorText ? <ActivityIndicator accessibilityLabel="正在加载会话消息" /> : null}

      {detail?.pendingQuestions.map((pq) => {
        const interactive = pq.state !== "readonly" && detail.session.canSend === true;
        const forCall = answersByCall[pq.callId] ?? {};
        const allValid = pq.questions.every((q) => {
          const entry = forCall[q.id];
          return !!entry && (entry.selected.length > 0 || entry.custom.trim().length > 0);
        });
        return (
          <Card key={pq.callId} style={{ padding: space.md, gap: space.md, borderWidth: 1.5, borderColor: interactive ? p.primary : p.divider }}>
            <Text style={{ color: interactive ? p.primary : p.muted, fontFamily: fonts.bodyBold }}>
              {QUESTION_STATE_NOTE[pq.state]}
            </Text>
            {pq.questions.map((q) => {
              const entry = forCall[q.id] ?? { selected: [], custom: "" };
              return (
                <View key={q.id} style={{ gap: space.xs }}>
                  {q.header ? (
                    <View style={{ alignSelf: "flex-start", backgroundColor: p.lavenderContainer, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 }}>
                      <Text style={{ color: p.ink, fontSize: 12, fontFamily: fonts.bodyBold }}>{q.header}</Text>
                    </View>
                  ) : null}
                  <Text style={{ color: p.ink, fontFamily: fonts.bodyBold, fontSize: 15, lineHeight: 22 }}>
                    {q.question}{q.multiSelect ? "（可多选）" : ""}
                  </Text>
                  {q.detail ? <Text style={{ color: p.muted, fontSize: 13, lineHeight: 19 }}>{q.detail}</Text> : null}
                  {q.options?.length ? (
                    <View style={{ gap: space.xs }}>
                      {q.options.map((opt) => {
                        const chosen = entry.selected.includes(opt.label);
                        return (
                          <Pressable
                            key={opt.label}
                            disabled={!interactive || busyAction !== null}
                            accessibilityRole="button"
                            accessibilityState={{ selected: chosen, disabled: !interactive || busyAction !== null }}
                            onPress={() => toggleOption(pq.callId, q.id, opt.label, !!q.multiSelect)}
                            style={{
                              padding: space.sm,
                              borderRadius: radius.md,
                              borderWidth: 1.5,
                              borderColor: chosen ? p.primary : p.divider,
                              backgroundColor: chosen ? p.accentContainer : p.surface2,
                              gap: 2,
                            }}
                          >
                            <Text style={{ color: chosen ? p.accentText : p.ink, fontFamily: chosen ? fonts.bodyBold : fonts.bodySemi }}>
                              {opt.label}
                            </Text>
                            {opt.description ? (
                              <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18 }}>{opt.description}</Text>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                  {interactive ? (
                    <TextInput
                      mode="outlined"
                      label="补充说明或自定义回答"
                      value={entry.custom}
                      maxLength={2000}
                      editable={busyAction === null}
                      onChangeText={(text) => setCustomAnswer(pq.callId, q.id, text)}
                    />
                  ) : null}
                </View>
              );
            })}
            {interactive ? (
              <Button
                mode="contained"
                disabled={!allValid || busyAction !== null}
                loading={busyAction === "answer"}
                onPress={() => void submitQuestionAnswer(pq)}
              >
                提交回答
              </Button>
            ) : null}
          </Card>
        );
      })}

      {detail ? (
        <Card flat style={{ padding: space.md, gap: space.sm }}>
          <Text style={{ color: p.muted, fontFamily: fonts.bodyBold, fontSize: 13 }}>最近对话记录（共 {detail.messages.length} 条）</Text>
          {!detail.messages.length ? (
            <Text style={{ color: p.muted }}>暂无最近消息记录。</Text>
          ) : (
            <View style={{ gap: space.sm }}>
              {detail.messages.map((m) => {
                const t = clock(m.ts);
                if (m.role === "user") {
                  return (
                    <View key={m.id} style={{ backgroundColor: p.accentContainer, borderRadius: radius.card, padding: space.md, gap: 4 }}>
                      <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 12 }}>
                        我{t ? ` · ${t}` : ""}
                      </Text>
                      <Text selectable style={{ color: p.ink, lineHeight: 21 }}>{m.text}</Text>
                    </View>
                  );
                }
                if (m.role === "tool") {
                  return (
                    <View key={m.id} style={{ backgroundColor: p.surface2, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.xs }}>
                      <Text style={{ color: m.isError ? p.error : p.muted, fontSize: 12.5 }}>
                        {m.text}{t ? ` · ${t}` : ""}
                      </Text>
                    </View>
                  );
                }
                if (m.role === "system") {
                  return (
                    <View key={m.id} style={{ paddingHorizontal: space.xs }}>
                      <Text style={{ color: p.faint, fontSize: 12 }}>{m.text}</Text>
                    </View>
                  );
                }
                return (
                  <View key={m.id} style={{ backgroundColor: p.surface, borderWidth: 1, borderColor: p.divider, borderRadius: radius.card, padding: space.md, gap: 4 }}>
                    <Text style={{ color: p.muted, fontFamily: fonts.bodyBold, fontSize: 12 }}>
                      助手{t ? ` · ${t}` : ""}
                    </Text>
                    <Markdown style={styles}>{fixCjkEmphasis(m.text)}</Markdown>
                  </View>
                );
              })}
            </View>
          )}
        </Card>
      ) : null}

      {detail?.session.canSend ? (
        <Card flat style={{ padding: space.md, gap: space.sm }}>
          <Text style={{ color: p.ink, fontFamily: fonts.bodyBold }}>继续发送消息</Text>
          <TextInput
            mode="outlined"
            label="输入要发送给原会话的任务或回复"
            multiline
            maxLength={RUNTIME_SESSION_TEXT_LIMIT}
            value={draft}
            editable={busyAction === null}
            onChangeText={setDraft}
          />
          <Button
            mode="contained"
            disabled={!canSubmitDraft || busyAction !== null}
            loading={busyAction === "send"}
            onPress={() => {
              Keyboard.dismiss();
              setConfirmSend(true);
            }}
          >
            确认发送
          </Button>
        </Card>
      ) : null}

      <Portal>
        <Dialog visible={confirmSend} dismissable={busyAction === null} onDismiss={() => setConfirmSend(false)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title>发送到这个会话？</Dialog.Title>
          <Dialog.Content style={{ gap: space.sm }}>
            <Text>{RUNTIME_LABEL[runtime]} · {effectiveProject}／{effectiveTitle}</Text>
            <Text variant="bodySmall" style={{ color: p.muted }}>会话 ID：{sessionId}</Text>
            <Text numberOfLines={5}>{draft}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button disabled={busyAction !== null} onPress={() => setConfirmSend(false)}>取消</Button>
            <Button disabled={busyAction !== null || !canSubmitDraft} loading={busyAction === "send"} onPress={() => void submitMessage()}>发送一次</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}
