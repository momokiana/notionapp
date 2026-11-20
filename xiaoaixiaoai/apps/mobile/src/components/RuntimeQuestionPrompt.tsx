import { useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, View } from "react-native";
import { Button, Text, TextInput } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import {
  isRuntimeRequestId,
  type Agent,
  type RuntimePendingQuestion,
  type RuntimeQuestionAnswerItem,
  type RuntimeSessionReceipt,
  type SessionRuntime,
} from "@xiaoaixiaoai/protocol";
import { call, RelayError } from "../lib/relay";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";

type DraftByCall = Record<string, Record<string, { selected: string[]; custom: string }>>;

const DENIED = new Set(["bad_request", "unauthorized", "forbidden", "not_found", "unsupported"]);

function parseTarget(localId: string): { runtime: SessionRuntime; projectId: string; sessionId: string } | null {
  const parts = localId.split("~");
  if (parts.length !== 3) return null;
  const [runtime, projectId, sessionId] = parts;
  if ((runtime !== "dsh" && runtime !== "codex" && runtime !== "antigravity") || !projectId || !sessionId) return null;
  return { runtime, projectId, sessionId };
}

function makeRequestId(): string {
  const native = globalThis.crypto?.randomUUID?.();
  if (isRuntimeRequestId(native)) return native;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (part) => {
    const bits = Math.floor(Math.random() * 16);
    return (part === "x" ? bits : (bits & 3) | 8).toString(16);
  });
}

export function RuntimeQuestionPrompt({
  agent,
  pendingQuestions,
  canSend,
  online,
  onAnswered,
  onToast,
}: {
  agent: Agent;
  pendingQuestions: RuntimePendingQuestion[];
  canSend: boolean;
  online: boolean;
  onAnswered: () => void;
  onToast: (msg: string) => void;
}) {
  const p = usePalette();
  const c = statusColors("blocked", p.dark);
  const [drafts, setDrafts] = useState<DraftByCall>({});
  const [submittingCall, setSubmittingCall] = useState<string | null>(null);
  const lock = useRef(false);

  const target = parseTarget(agent.localId);
  if (!pendingQuestions.length || !target) return null;

  function toggleOption(callId: string, qId: string, label: string, multiSelect: boolean) {
    setDrafts((prev) => {
      const forCall = prev[callId] ?? {};
      const entry = forCall[qId] ?? { selected: [], custom: "" };
      const selected = multiSelect
        ? (entry.selected.includes(label) ? entry.selected.filter((x) => x !== label) : [...entry.selected, label])
        : [label];
      return { ...prev, [callId]: { ...forCall, [qId]: { ...entry, selected } } };
    });
  }

  function setCustom(callId: string, qId: string, custom: string) {
    setDrafts((prev) => {
      const forCall = prev[callId] ?? {};
      const entry = forCall[qId] ?? { selected: [], custom: "" };
      return { ...prev, [callId]: { ...forCall, [qId]: { ...entry, custom } } };
    });
  }

  async function submit(pq: RuntimePendingQuestion) {
    if (!target || lock.current || !online || !canSend || pq.state === "readonly") return;
    const forCall = drafts[pq.callId] ?? {};
    const answers: RuntimeQuestionAnswerItem[] = pq.questions.map((q) => {
      const entry = forCall[q.id] ?? { selected: [], custom: "" };
      const custom = entry.custom.trim();
      return { id: q.id, selected: entry.selected, ...(custom ? { custom } : {}) };
    });
    if (answers.some((a) => !a.selected.length && !a.custom)) {
      onToast("请先完成所有问题再提交回答");
      return;
    }
    lock.current = true;
    setSubmittingCall(pq.callId);
    Keyboard.dismiss();
    Haptics.selectionAsync().catch(() => undefined);
    const requestId = makeRequestId();
    try {
      const receipt: RuntimeSessionReceipt = await call(agent.deviceId, "runtimeSessions.answer", {
        runtime: target.runtime,
        projectId: target.projectId,
        sessionId: target.sessionId,
        requestId,
        callId: pq.callId,
        answers,
      }, 20_000);
      if (receipt?.accepted !== true || receipt.requestId !== requestId) {
        throw new Error("unverified receipt");
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[pq.callId];
        return next;
      });
      onToast("回答已送到原会话");
      onAnswered();
    } catch (err) {
      const msg = err instanceof RelayError && DENIED.has(err.code)
        ? (err.message || "当前会话暂不能提交回答")
        : "未收到明确回执，请稍后刷新会话确认";
      onToast(msg);
    } finally {
      lock.current = false;
      setSubmittingCall(null);
    }
  }

  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        marginHorizontal: space.lg,
        marginBottom: space.xs,
        backgroundColor: c.bg,
        borderRadius: radius.card,
        padding: space.md,
        maxHeight: 260,
        gap: space.sm,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <MaterialCommunityIcons name="hand-wave-outline" size={18} color={c.fg} />
        <Text style={{ flex: 1, fontFamily: fonts.cute, fontSize: 16, color: c.fg }}>它在等你回答问题</Text>
      </View>
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.sm }}>
        {pendingQuestions.map((pq) => {
          const readonly = !canSend || pq.state === "readonly";
          const busy = submittingCall === pq.callId;
          return (
            <View key={pq.callId} style={{ gap: space.sm }}>
              {pq.questions.map((q) => {
                const draft = drafts[pq.callId]?.[q.id] ?? { selected: [], custom: "" };
                return (
                  <View key={q.id} style={{ gap: 6 }}>
                    <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13.5, color: p.ink }}>
                      {q.question}
                      {q.multiSelect ? "（可多选）" : ""}
                    </Text>
                    {q.detail ? <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18 }}>{q.detail}</Text> : null}
                    {q.options?.length ? (
                      <View style={{ gap: 5 }}>
                        {q.options.map((opt) => {
                          const picked = draft.selected.includes(opt.label);
                          return (
                            <Pressable
                              key={opt.label}
                              disabled={readonly || busy || !online}
                              onPress={() => toggleOption(pq.callId, q.id, opt.label, q.multiSelect === true)}
                              accessibilityRole="button"
                              accessibilityState={{ selected: picked }}
                              style={({ pressed }) => ({
                                paddingHorizontal: space.md,
                                paddingVertical: 8,
                                borderRadius: radius.md,
                                backgroundColor: pressed ? (picked ? p.accentText : p.surface3) : picked ? p.primary : p.surface,
                                opacity: readonly || busy || !online ? 0.65 : 1,
                              })}
                            >
                              <Text style={{ fontFamily: fonts.bodySemi, fontSize: 13, color: picked ? p.onPrimary : p.ink }}>
                                {opt.label}
                              </Text>
                              {opt.description ? (
                                <Text style={{ fontSize: 11.5, color: picked ? p.onPrimary : p.muted, marginTop: 2 }}>
                                  {opt.description}
                                </Text>
                              ) : null}
                            </Pressable>
                          );
                        })}
                      </View>
                    ) : null}
                    {!readonly ? (
                      <TextInput
                        mode="outlined"
                        dense
                        value={draft.custom}
                        onChangeText={(value) => setCustom(pq.callId, q.id, value)}
                        placeholder={q.options?.length ? "补充说明（可选）" : "输入回答内容"}
                        disabled={busy || !online}
                        style={{ backgroundColor: p.surface, fontSize: 13 }}
                      />
                    ) : null}
                  </View>
                );
              })}
              {readonly ? (
                <Text style={{ color: c.fg, fontSize: 12 }}>当前为只读预览，请在电脑端原窗口确认。</Text>
              ) : (
                <Button mode="contained" compact loading={busy} disabled={busy || !online} onPress={() => void submit(pq)}>
                  提交回答
                </Button>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
