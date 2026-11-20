import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { Button, Dialog, Portal, Snackbar, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Markdown from "react-native-markdown-display";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AssistantAction, AssistantItem } from "@xiaoaixiaoai/protocol";
import { BreathingDot, Card, IconTile, PageBackground, SendPill, TypingDots } from "../../components/ui";
import { CuteIcon } from "../../components/icons";
import { Mascot } from "../../components/Mascot";
import { StarlightPortrait } from "../../components/Starlight";
import { mdStyles } from "../../components/chat";
import { CallBar, CallScreen } from "../../components/CallScreen";
import { AgentLink, NoticeBubble } from "../../components/notice";
import { RemindersSheet } from "../../components/reminders";
import { router, useFocusEffect } from "expo-router";
import { clearAssistant, decideAction, loadAssistant, sendToAssistant, setAssistantReplyMode, setAssistantWatching, useAssistant } from "../../lib/assistant";
import { abortVoiceNote, beginVoiceNote, finishVoiceNote, playAssistantItem, stopAssistantSpeech, useChatVoice } from "../../lib/chat-voice";
import { dismissCallMessage, startCall, useVoice } from "../../lib/voice";
import { findAgent, useLive, useSettings } from "../../lib/store";
import { fixCjkEmphasis, hasList } from "../../lib/markdown";
import { isMockServer } from "../../lib/mock";
import { dshIntent } from "../../lib/dsh-follows";
import { stageDshIntent } from "../../lib/dsh-runtime";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space } from "../../theme/tokens";

const SUGGESTIONS = ["谁在等我？", "大家都在忙什么？", "最近谁跑完了，结果怎么样？", "10 分钟后提醒我看一下进度"];

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function AssistantScreen() {
  const NAME = useAssistant((s) => s.name);
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const items = useAssistant((s) => s.items);
  const busy = useAssistant((s) => s.busy);
  const busyLabel = useAssistant((s) => s.busyLabel);
  const ready = useAssistant((s) => s.ready);
  const voice = useAssistant((s) => s.voice);
  const chatVoice = useAssistant((s) => s.chatVoice);
  const replyMode = useAssistant((s) => s.replyMode);
  const loaded = useAssistant((s) => s.loaded);
  const error = useAssistant((s) => s.error);
  const reminders = useAssistant((s) => s.reminders);
  const speakingItemId = useChatVoice((s) => s.speakingItemId);
  const pttState = useChatVoice((s) => s.pttState);
  const pttLevel = useChatVoice((s) => s.pttLevel);
  const link = useLive((s) => s.link);
  const server = useSettings((s) => s.server);
  const call = useVoice((s) => s.status);
  const callMessage = useVoice((s) => s.message);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pttMode, setPttMode] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const list = useRef<FlatList<AssistantItem>>(null);
  const inCall = call === "connecting" || call === "ready";
  const callCapable = voice || isMockServer(server);
  const chatVoiceCapable = chatVoice || isMockServer(server);
  // During a call the chat stays reachable: the call folds into a bar above the composer.
  const [callOpen, setCallOpen] = useState(true);
  const foldCall = useCallback(() => setCallOpen(false), []);

  useEffect(() => {
    if (link === "online" || isMockServer(server)) void loadAssistant();
  }, [link, server]);

  useFocusEffect(
    useCallback(() => {
      setAssistantWatching(true);
      return () => setAssistantWatching(false);
    }, []),
  );

  const data = useMemo(() => [...items].reverse(), [items]);

  const send = useCallback(
    async (raw?: string) => {
      const t = (raw ?? text).trim();
      if (!t || sending) return;
      const intent = dshIntent(t);
      if (intent === "invalid") { setToast("请核对 DSH 会话名和消息。格式：发给 DSH 会话名：消息"); return; }
      if (intent) {
        const { server, deviceId: viewer } = useSettings.getState();
        if (!server || !viewer || useLive.getState().self?.id !== viewer) {
          setToast("配对并连接后就能打开 DSH 项目会话。");
          return;
        }
        stageDshIntent(intent, server, viewer);
        if (raw === undefined) setText("");
        router.navigate("/devices");
        return;
      }
      setSending(true);
      try {
        await sendToAssistant(t);
        if (raw === undefined) setText("");
        list.current?.scrollToOffset({ offset: 0, animated: true });
      } catch (e) {
        setToast((e as Error).message);
      } finally {
        setSending(false);
      }
    },
    [text, sending],
  );

  async function call_() {
    stopAssistantSpeech();
    setCallOpen(true);
    const err = await startCall();
    if (err) setToast(err);
  }

  async function toggleReplyMode() {
    const next = replyMode === "voice" ? "text" : "voice";
    if (next === "text") stopAssistantSpeech();
    try {
      await setAssistantReplyMode(next);
      setToast(next === "voice" ? "已打开语音 + 文字双轨回复" : "已切为纯文字回复");
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  const status = inCall
    ? "通话中"
    : speakingItemId
      ? "正在说话…"
      : busy
        ? `${busyLabel && busyLabel !== "在想" ? busyLabel : "在想"}…`
        : link === "online" || isMockServer(server)
          ? ready
            ? chatVoiceCapable
              ? replyMode === "voice"
                ? "在线 · 语音双轨"
                : "在线 · 纯文字"
              : "在线 · 有事会叫你"
            : loaded
              ? "还没接上模型"
              : "连接中…"
          : "等网络恢复";

  return (
    <PageBackground>
      <View style={{ paddingTop: insets.top + space.md, paddingHorizontal: space.lg, paddingBottom: space.sm, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <View style={{ padding: 2, borderWidth: 1, borderRadius: radius.pill, borderColor: p.sky, backgroundColor: p.surface }}>
          <Mascot mood={busy || inCall || speakingItemId ? "hello" : "default"} size={44} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.cute, fontSize: 24, lineHeight: 32, color: p.ink }}>{NAME}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <BreathingDot color={busy || inCall || speakingItemId ? p.primary : link === "online" || isMockServer(server) ? "#3FB68B" : p.faint} active={!!(busy || inCall || speakingItemId)} size={7} />
            <Text style={{ color: p.muted, fontSize: 13 }}>{status}</Text>
          </View>
        </View>
        {chatVoiceCapable ? (
          <IconTile
            icon={replyMode === "voice" ? "volume" : "volumeOff"}
            active={replyMode === "voice"}
            tone="plain"
            size={40}
            onPress={() => void toggleReplyMode()}
            a11y={replyMode === "voice" ? "切换为纯文字回复" : "切换为语音加文字双轨回复"}
          />
        ) : null}
        <View>
          <IconTile icon="bell" tone="plain" size={40} onPress={() => setShowReminders(true)} a11y={`提醒，${reminders.length} 个`} />
          {reminders.length ? (
            <View pointerEvents="none" style={{ position: "absolute", right: 4, top: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: p.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 }}>
              <Text style={{ color: p.onPrimary, fontSize: 10, fontFamily: fonts.bodyBold }}>{reminders.length}</Text>
            </View>
          ) : null}
        </View>
        <IconTile icon="newChat" tone="plain" size={40} onPress={() => setConfirmClear(true)} a11y="开始新对话" />
      </View>

      {error ? (
        <Card flat style={{ marginHorizontal: space.lg, padding: space.md, backgroundColor: p.errorContainer }}>
          <Text style={{ color: p.error, fontSize: 13.5 }}>{error}</Text>
        </Card>
      ) : loaded && !ready && !isMockServer(server) ? (
        <Card flat style={{ marginHorizontal: space.lg, padding: space.md, backgroundColor: p.accentContainer }}>
          <Text style={{ color: p.ink, fontSize: 13.5 }}>服务器上还没配置助理用的模型，配好后就能聊了。</Text>
        </Card>
      ) : null}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {/* The welcome sits outside the inverted list: inverted lists flip their empty view differently per platform. */}
        {loaded && !data.length && !busy ? (
          <Welcome onPick={(s) => void send(s)} voice={chatVoiceCapable} callVoice={callCapable} />
        ) : (
          <FlatList
            ref={list}
            data={data}
            inverted
            keyExtractor={(it) => it.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md, flexGrow: 1 }}
            renderItem={({ item }) => <Bubble item={item} voice={chatVoiceCapable} speakingId={speakingItemId} onError={setToast} />}
            ListHeaderComponent={busy ? <Thinking label={busyLabel} /> : undefined}
          />
        )}

        {inCall && !callOpen ? <CallBar name={NAME} onExpand={() => setCallOpen(true)} /> : null}
        <Composer
          text={text}
          onText={setText}
          onSend={() => void send()}
          onCall={() => void call_()}
          sending={sending}
          voice={callCapable}
          chatVoice={chatVoiceCapable}
          inCall={inCall}
          pttMode={pttMode}
          onTogglePtt={() => setPttMode((v) => !v)}
          pttState={pttState}
          pttLevel={pttLevel}
          onToast={setToast}
        />
      </KeyboardAvoidingView>

      {inCall && callOpen ? <CallScreen name={NAME} onMinimize={foldCall} /> : null}

      <Portal>
        <Dialog visible={confirmClear} onDismiss={() => setConfirmClear(false)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink }}>开始新对话？</Dialog.Title>
          <Dialog.Content>
            <Text style={{ color: p.muted, lineHeight: 22 }}>聊天记录会清空，提醒不受影响。</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmClear(false)} textColor={p.ink}>
              取消
            </Button>
            <Button
              textColor={p.accentText}
              onPress={async () => {
                setConfirmClear(false);
                try {
                  await clearAssistant();
                } catch (e) {
                  setToast((e as Error).message);
                }
              }}
            >
              清空
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <RemindersSheet visible={showReminders} reminders={reminders} name={NAME} onDismiss={() => setShowReminders(false)} />

      <Snackbar visible={!!toast || !!callMessage} onDismiss={() => (toast ? setToast(null) : dismissCallMessage())} duration={3000} wrapperStyle={{ bottom: 90 }}>
        {toast ?? callMessage ?? ""}
      </Snackbar>
    </PageBackground>
  );
}

function Welcome({ onPick, voice, callVoice }: { onPick: (s: string) => void; voice: boolean; callVoice: boolean }) {
  const NAME = useAssistant((s) => s.name);
  const p = usePalette();
  return (
    <ScrollView
      style={{ flex: 1 }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", gap: space.sm, paddingVertical: space.md, paddingHorizontal: space.lg }}
    >
      <StarlightPortrait size={104} />
      <Text style={{ fontFamily: fonts.cute, fontSize: 22, color: p.ink }}>我是{NAME}</Text>
      <Text style={{ color: p.muted, textAlign: "center", lineHeight: 21, paddingHorizontal: space.lg }}>
        你所有电脑上的 agent 我都盯着。问我谁在等你、谁跑完了，或者让我替你回一句
        {voice && callVoice
          ? "；点左下方话筒可以按住说话，点右侧电话可以语音通话"
          : voice
            ? "；点左下方话筒可以按住说话"
            : callVoice
              ? "；点右侧电话可以语音通话"
              : ""}
        。
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.sm, paddingTop: space.sm }}>
        {SUGGESTIONS.map((s, i) => (
          <Pressable
            key={s}
            accessibilityRole="button"
            onPress={() => onPick(s)}
            style={({ pressed }) => ({ paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: pressed ? p.surface3 : i % 2 ? p.accentContainer : p.skyContainer, borderWidth: 1, borderColor: p.divider })}
          >
            <Text style={{ color: i % 2 ? p.accentText : p.skyText, fontSize: 13.5 }}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

/** The assistant is replying: a small bubble on her side of the chat with typing dots, like the agent chat's working pill. */
function Thinking({ label }: { label: string | null }) {
  const NAME = useAssistant((s) => s.name);
  const p = usePalette();
  // The dots stand in for the old trailing "…".
  const text = label && label !== "在想" ? `${NAME}正在处理${label}` : `${NAME}在想`;
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
      style={{
        alignSelf: "flex-start",
        maxWidth: "92%",
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        backgroundColor: p.reply,
        borderRadius: radius.card,
        borderBottomLeftRadius: 6,
        paddingLeft: space.md + 2,
        paddingRight: space.md,
        paddingVertical: 9,
      }}
    >
      <TypingDots color={p.primary} size={7} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: p.muted, fontSize: 13.5, fontFamily: fonts.bodySemi }}>
        {text}
      </Text>
    </View>
  );
}

const Bubble = memo(function Bubble({
  item,
  voice,
  speakingId,
  onError,
}: {
  item: AssistantItem;
  voice: boolean;
  speakingId: string | null;
  onError: (m: string) => void;
}) {
  const p = usePalette();
  const scale = useSettings((s) => s.textScale);
  const styles = useMemo(() => mdStyles(p, scale), [p, scale]);
  const speaking = speakingId === item.id;
  const toggleSpeak = useCallback(async () => {
    if (speaking) {
      stopAssistantSpeech();
      return;
    }
    const text = item.role === "notice" ? item.notice?.body || item.text : item.text;
    const err = await playAssistantItem(item.id, text);
    if (err) onError(err);
  }, [speaking, item, onError]);

  if (item.action) return <ActionCard item={item} onError={onError} />;

  if (item.role === "notice" && item.notice) {
    return <NoticeBubble item={item} speaking={speaking} onToggleSpeak={voice && (item.notice.body || item.text) ? () => void toggleSpeak() : undefined} />;
  }

  if (item.role === "user") {
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: "85%", gap: 3, alignItems: "flex-end" }}>
        <View style={{ backgroundColor: p.bubble, borderRadius: radius.card, borderBottomRightRadius: 6, paddingHorizontal: space.md, paddingVertical: 9 }}>
          <Text style={{ color: p.ink, fontSize: 15.5 * scale, lineHeight: 22 * scale }}>{item.text}</Text>
        </View>
        <Meta item={item} />
      </View>
    );
  }

  const callCaption = item.id.startsWith("v-") && item.via === "voice";
  const canSpeak = voice && !item.error && !!item.text.trim();
  return (
    <View style={[{ alignSelf: "flex-start", gap: 4 }, !callCaption && hasList(item.text) ? { width: "92%" } : { maxWidth: "92%" }]}>
      <View style={{ backgroundColor: item.error ? p.errorContainer : p.reply, borderWidth: 1, borderColor: p.divider, borderRadius: radius.card, borderBottomLeftRadius: 6, paddingHorizontal: space.md, paddingVertical: 4 }}>
        {callCaption ? (
          <Text style={{ color: p.ink, fontSize: 15.5 * scale, lineHeight: 22 * scale, paddingVertical: 5 }}>{item.text}</Text>
        ) : (
          <Markdown style={styles}>{fixCjkEmphasis(item.text || "…")}</Markdown>
        )}
      </View>
      {item.steps?.length ? (
        <Text style={{ color: p.faint, fontSize: 12, paddingHorizontal: 4 }} numberOfLines={2}>
          {item.steps.join(" · ")}
        </Text>
      ) : null}
      <Meta item={item} speaking={speaking} onToggleSpeak={canSpeak ? () => void toggleSpeak() : undefined} />
    </View>
  );
});

function Meta({ item, speaking, onToggleSpeak }: { item: AssistantItem; speaking?: boolean; onToggleSpeak?: () => void }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}>
      {item.via === "voice" ? <CuteIcon name="mic" size={12} color={p.faint} strokeWidth={2.4} /> : null}
      <Text style={{ color: p.faint, fontSize: 11 }}>{clock(item.ts)}</Text>
      {onToggleSpeak ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={speaking ? "停止语音播报" : "语音播报这条消息"}
          onPress={onToggleSpeak}
          hitSlop={8}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: radius.pill,
            backgroundColor: speaking || pressed ? p.skyContainer : p.surface2,
          })}
        >
          <CuteIcon name={speaking ? "volumeOff" : "volume"} size={12} color={speaking ? p.skyText : p.muted} strokeWidth={2.3} />
          <Text style={{ color: speaking ? p.skyText : p.muted, fontSize: 11, fontFamily: fonts.bodySemi }}>{speaking ? "停止" : "播报"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const ACTION_STATE: Record<string, string> = { pending: "等你确认", running: "正在执行", done: "已完成", cancelled: "已取消", failed: "失败了", expired: "已作废" };


/** One icon per kind of thing the assistant asks to do. */
const ACTION_ICONS: Record<AssistantAction["kind"], "send-outline" | "keyboard-outline" | "plus-circle-outline" | "stop-circle-outline" | "close-circle-outline" | "view-dashboard-outline" | "restore"> = {
  send: "send-outline",
  keys: "keyboard-outline",
  create: "plus-circle-outline",
  interrupt: "stop-circle-outline",
  close: "close-circle-outline",
  herdr: "view-dashboard-outline",
  resume: "restore",
};

function ActionCard({ item, onError }: { item: AssistantItem; onError: (m: string) => void }) {
  const p = usePalette();
  const a = item.action!;
  const [working, setWorking] = useState<"confirm" | "cancel" | null>(null);
  const pending = a.state === "pending";
  async function decide(d: "confirm" | "cancel") {
    setWorking(d);
    try {
      await decideAction(a.id, d);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWorking(null);
    }
  }
  const icon = ACTION_ICONS[a.kind] ?? "send-outline";
  const tone = a.state === "failed" ? p.error : a.state === "done" ? "#3FB68B" : pending ? p.accentText : p.faint;
  // A message says who got it, by the name the answer uses, and on which computer; the text itself is
  // shown once, in full, below (the summary repeats its first 80 characters). Older relays: the summary.
  const send = a.kind === "send" && !!a.text;
  const who = a.agentName || a.agentTitle;
  const head = send && who ? `发给「${who}」` : a.summary;
  const where = send ? [a.deviceName, a.agentTitle && a.agentTitle !== who ? a.agentTitle : undefined].filter(Boolean).join(" · ") : "";
  const agent = a.agent ? findAgent(a.agent) : undefined;
  return (
    <Card style={{ padding: space.md, gap: space.sm, borderWidth: pending ? 1.5 : 0, borderColor: p.primary }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <MaterialCommunityIcons name={icon} size={18} color={p.ink} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bodyBold, color: p.ink }}>{head}</Text>
          {where ? (
            <Text numberOfLines={1} style={{ color: p.faint, fontSize: 12 }}>
              {where}
            </Text>
          ) : null}
        </View>
      </View>
      {send ? (
        <View style={{ backgroundColor: p.surface2, borderRadius: radius.sm, padding: space.sm }}>
          <Text selectable style={{ color: p.ink, lineHeight: 21 }}>
            {a.text}
          </Text>
        </View>
      ) : null}
      {send && a.said ? <SaidLine said={a.said} /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ flex: 1, color: tone, fontSize: 12.5, fontFamily: fonts.bodySemi }}>{stateLine(a)}</Text>
        {pending ? (
          <>
            <Button compact mode="text" textColor={p.muted} disabled={!!working} loading={working === "cancel"} onPress={() => void decide("cancel")}>
              取消
            </Button>
            <Button compact mode="contained" disabled={!!working} loading={working === "confirm"} onPress={() => void decide("confirm")} style={{ borderRadius: radius.pill }}>
              确认执行
            </Button>
          </>
        ) : null}
      </View>
      {agent ? <AgentLink agentKey={agent.key} /> : null}
    </Card>
  );
}

/**
 * Where an action stands. A finished one is described by its own result ("发了，它正在忙这一轮…"):
 * "已完成" in front of it read as if the agent had finished the work.
 */
function stateLine(a: AssistantAction): string {
  if (a.state === "pending" || !a.result) return ACTION_STATE[a.state] ?? "";
  return a.state === "done" ? a.result : `${ACTION_STATE[a.state]} · ${a.result}`;
}

/** The person's own words a relayed message was made from: one line, tap for all of it. */
function SaidLine({ said }: { said: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`你的原话：${said}`}
      accessibilityHint={open ? "点按收起" : "点按展开全文"}
      onPress={() => setOpen((v) => !v)}
      hitSlop={6}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, minHeight: 32, paddingHorizontal: 2, paddingTop: 2 }}
    >
      <MaterialCommunityIcons name="format-quote-open" size={15} color={p.faint} style={{ marginTop: 1 }} />
      <Text numberOfLines={open ? undefined : 1} style={{ flex: 1, color: p.muted, fontSize: 12.5, lineHeight: 18 }}>
        你的原话：{said}
      </Text>
      <MaterialCommunityIcons name={open ? "chevron-up" : "chevron-down"} size={16} color={p.faint} />
    </Pressable>
  );
}

function Composer({
  text,
  onText,
  onSend,
  onCall,
  sending,
  voice,
  chatVoice,
  inCall,
  pttMode,
  onTogglePtt,
  pttState,
  pttLevel,
  onToast,
}: {
  text: string;
  onText: (t: string) => void;
  onSend: () => void;
  onCall: () => void;
  sending: boolean;
  voice: boolean;
  chatVoice: boolean;
  inCall: boolean;
  pttMode: boolean;
  onTogglePtt: () => void;
  pttState: "idle" | "recording" | "transcribing";
  pttLevel: number;
  onToast: (m: string) => void;
}) {
  const NAME = useAssistant((s) => s.name);
  const p = usePalette();
  const empty = !text.trim();
  const [cancelling, setCancelling] = useState(false);
  const pressY = useRef<number | null>(null);
  const cancellingRef = useRef(false);

  async function onHoldStart(pageY: number) {
    if (pttState === "transcribing") return;
    pressY.current = pageY;
    cancellingRef.current = false;
    setCancelling(false);
    const err = await beginVoiceNote();
    if (err) onToast(err);
  }

  function onHoldMove(pageY: number) {
    if (pressY.current === null || pttState !== "recording") return;
    const cancel = pressY.current - pageY > 55;
    if (cancel !== cancellingRef.current) {
      cancellingRef.current = cancel;
      setCancelling(cancel);
    }
  }

  async function onHoldEnd() {
    if (pressY.current === null) return;
    const shouldCancel = cancellingRef.current;
    pressY.current = null;
    cancellingRef.current = false;
    setCancelling(false);
    if (shouldCancel) {
      abortVoiceNote();
      return;
    }
    const err = await finishVoiceNote();
    if (err) onToast(err);
  }

  const bars = Math.max(1, Math.min(5, Math.round(pttLevel * 5)));

  return (
    <View style={{ marginHorizontal: space.lg, marginBottom: space.sm, gap: 6 }}>
      {pttState !== "idle" ? (
        <View
          style={{
            alignSelf: "center",
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: space.md,
            paddingVertical: 6,
            borderRadius: radius.pill,
            backgroundColor: cancelling ? p.errorContainer : p.surface,
            borderWidth: 1,
            borderColor: cancelling ? p.error : p.divider,
          }}
        >
          <CuteIcon name={cancelling ? "close" : "mic"} size={14} color={cancelling ? p.error : p.primary} strokeWidth={2.4} />
          <Text style={{ color: cancelling ? p.error : p.ink, fontSize: 12.5, fontFamily: fonts.bodySemi }}>
            {pttState === "transcribing" ? "正在识别语音…" : cancelling ? "松开手指，取消发送" : "正在听，松开发送 · 上滑取消"}
          </Text>
          {pttState === "recording" && !cancelling ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              {[1, 2, 3, 4, 5].map((i) => (
                <View key={i} style={{ width: 3, height: 6 + i * 2, borderRadius: 2, backgroundColor: i <= bars ? p.primary : p.divider }} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: space.sm,
          backgroundColor: p.glass,
          borderRadius: radius.xl,
          borderWidth: 1,
          borderColor: p.divider,
          paddingLeft: chatVoice && !inCall ? 5 : space.lg,
          paddingRight: 5,
          paddingVertical: 5,
          shadowColor: p.shadow,
          shadowOpacity: p.dark ? 0 : 0.12,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: p.dark ? 0 : 2,
        }}
      >
        {chatVoice && !inCall ? (
          <IconTile
            icon={pttMode ? "keyboard" : "mic"}
            tone="soft"
            size={40}
            disabled={pttState !== "idle"}
            onPress={onTogglePtt}
            a11y={pttMode ? "切回键盘输入" : "切换为按住说话"}
          />
        ) : null}

        {pttMode && chatVoice && !inCall ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`按住给${NAME}发语音消息`}
            disabled={pttState === "transcribing"}
            onPressIn={(e) => void onHoldStart(e.nativeEvent.pageY)}
            onTouchMove={(e) => onHoldMove(e.nativeEvent.pageY)}
            onPressOut={() => void onHoldEnd()}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 42,
              borderRadius: radius.card,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor:
                pttState === "transcribing"
                  ? p.surface3
                  : cancelling
                    ? p.errorContainer
                    : pttState === "recording" || pressed
                      ? p.skyContainer
                      : p.surface2,
              borderWidth: 1,
              borderColor: cancelling ? p.error : pttState === "recording" ? p.skyText : p.divider,
            })}
          >
            <Text style={{ color: cancelling ? p.error : p.ink, fontFamily: fonts.bodyBold, fontSize: 15 }}>
              {pttState === "transcribing" ? "正在识别…" : pttState === "recording" ? (cancelling ? "松开取消" : "松开 发送") : "按住 说话"}
            </Text>
          </Pressable>
        ) : (
          <TextInput
            value={text}
            onChangeText={onText}
            placeholder={`和${NAME}说点什么…`}
            placeholderTextColor={p.faint}
            cursorColor={p.skyText}
            selectionColor={p.skyContainer}
            multiline
            style={{ flex: 1, fontFamily: fonts.body, fontSize: 15.5, color: p.ink, maxHeight: 120, paddingVertical: 9 }}
            accessibilityLabel={`发给${NAME}的消息`}
          />
        )}

        {((pttMode && chatVoice) || empty) && voice && !inCall ? (
          <IconTile icon="phoneCall" tone="primary" size={42} disabled={pttState !== "idle"} onPress={onCall} a11y={`和${NAME}实时语音通话`} />
        ) : (
          <SendPill disabled={(pttMode && chatVoice) || empty || sending} onPress={onSend} />
        )}
      </View>
    </View>
  );
}
