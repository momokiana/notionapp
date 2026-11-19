import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { AppState, Keyboard, ScrollView, View } from "react-native";
import { useIsFocused, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActivityIndicator, Button, Dialog, Portal, Text, TextInput } from "react-native-paper";
import {
  DSH_DIRECTORY_PAGE_SIZE, DSH_DIRECTORY_SEARCH_LIMIT, RUNTIME_SESSION_TEXT_LIMIT, isRuntimeId, isRuntimeRequestId,
  type Device, type DshDirectoryEntry, type DshDirectoryReply, type DshDirectoryRequest, type RuntimeSessionState,
} from "@xiaoaixiaoai/protocol";
import type { DshFollow, DshIntent } from "../lib/dsh-follows";
import { useAppActive, useDshFollows } from "../lib/dsh-runtime";
import { call, RelayError } from "../lib/relay";
import { useLive, useSettings } from "../lib/store";
import { fonts, radius, space } from "../theme/tokens";
import { usePalette } from "../theme/theme";
import { Card, PageBackground, PageTitle } from "./ui";

const STATE: Record<RuntimeSessionState, string> = { running: "工作中", idle: "空闲", inactive: "未加载", attention: "需检查", unknown: "状态未知" };
const PROBLEM = {
  unsupported: "这台电脑或中继不支持 DSH 目录。",
  denied: "当前手机无权查看这台电脑的 DSH 目录。",
  unavailable: "暂时无法读取 DSH 目录。",
};
const DECLINED = new Set(["bad_request", "unauthorized", "forbidden", "not_found", "unsupported"]);
const SEARCH_CONTROL = /[\p{Cc}\p{Cf}\uD800-\uDFFF]/u;
const ACTION = { minHeight: 44 };
const ACTIONS = { flexDirection: "row", flexWrap: "wrap", gap: space.xs } as const;

type Props = { host: Device; onBack: () => void; intent?: DshIntent; focusSessionId?: string; onLegacy?: () => void };
type Tab = "directory" | "follows";
type Target = { projectId: string; sessionId: string };
type Notice = { text: string; warn?: boolean };
type FollowAction = Parameters<ReturnType<typeof useDshFollows>["change"]>[1];
type ReadResult = { data: DshDirectoryReply; problem?: never } | { data?: never; problem: keyof typeof PROBLEM };

function problem(error: unknown): keyof typeof PROBLEM {
  if (error instanceof RelayError) {
    if (error.code === "unsupported") return "unsupported";
    if (error.code === "forbidden" || error.code === "unauthorized") return "denied";
  }
  return "unavailable";
}

async function browse(hostId: string, request: DshDirectoryRequest): Promise<DshDirectoryReply> {
  const reply = await call(hostId, "runtimeSessions.browse", request);
  if (!reply || reply.view !== request.view || (reply.scope !== "profile" && reply.scope !== "selected")) throw new Error("Invalid directory reply");
  const rows = reply.view === "projects" ? reply.projects : reply.entries;
  if (!Array.isArray(rows) || rows.length > DSH_DIRECTORY_PAGE_SIZE) throw new Error("Invalid directory page");
  return reply;
}

/** Never put directory titles or search terms into the shared query cache. */
function useBrowse(hostId: string, request: DshDirectoryRequest | undefined, revision: number, current: () => boolean) {
  const [read, setRead] = useState<{ request: DshDirectoryRequest; revision: number; result: ReadResult }>();
  useEffect(() => {
    if (!request || !current()) return;
    let open = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const commit = (result: ReadResult) => {
      if (!open || !current()) return;
      setRead({ request, revision, result });
      if (result.data && request.view !== "projects") timer = setTimeout(refresh, 12_000);
    };
    function refresh() {
      if (open && current() && request) void browse(hostId, request).then((data) => commit({ data }), (error: unknown) => commit({ problem: problem(error) }));
    }
    refresh();
    return () => { open = false; if (timer !== undefined) clearTimeout(timer); };
  }, [hostId, request, revision, current]);
  return read?.request === request && read?.revision === revision ? read.result : undefined;
}

function writable(reply: DshDirectoryReply | undefined, target: Target) {
  return reply?.view === "exact" ? reply.entries.find((e) => e.session.id === target.sessionId &&
    e.project.id === target.projectId && e.archived === false && e.session.canSend === true) : undefined;
}

/** Correlation/idempotency only; the request ID is not a credential. */
function requestId() {
  const native = globalThis.crypto?.randomUUID?.();
  if (isRuntimeRequestId(native)) return native;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (part) => {
    const bits = Math.floor(Math.random() * 16);
    return (part === "x" ? bits : (bits & 3) | 8).toString(16);
  });
}

export function DshDirectoryPanel(props: Props) {
  const server = useSettings((s) => s.server);
  const viewer = useSettings((s) => s.deviceId);
  return <HostDirectory key={JSON.stringify([server, viewer, props.host.id])} {...props} server={server} viewer={viewer} />;
}

function HostDirectory({ host, intent, focusSessionId, onBack, onLegacy, server, viewer }: Props & { server: string | null; viewer: string | null }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const navigation = useNavigation();
  const active = useAppActive();
  const self = useLive((s) => s.self?.id);
  const link = useLive((s) => s.link);
  const liveHost = useLive((s) => s.devices[host.id]);
  const { items, change } = useDshFollows(host.id);
  const follows = useMemo(() => [...new Map(items.filter((item) => item.hostId === host.id && isRuntimeId(item.sessionId))
    .map((item) => [item.sessionId, item])).values()], [host.id, items]);
  const [tab, setTab] = useState<Tab>("directory");
  const [notice, setNotice] = useState<Notice>();
  const [sending, setSending] = useState(false);
  const sendPending = useRef(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const generation = useRef(0);
  const [epoch, setEpoch] = useState(0);
  const [suggestion, setSuggestion] = useState({ intent, epoch, version: 0 });
  // A new suggestion may arrive on the same host after leaving and re-entering
  // the device tab. Never repopulate text from the previous foreground lease.
  if (intent && intent !== suggestion.intent) {
    setSuggestion({ intent, epoch, version: suggestion.version + 1 });
    setTab("directory");
  }
  const foreground = active && focused;
  const paired = !!server && !!viewer && viewer === self && link !== "unauthorized";
  const demo = server?.startsWith("mock://") === true;
  const connected = foreground && paired && link === "online" && liveHost?.kind === "host" && liveHost.online;
  const supported = liveHost?.sources?.includes("dsh-directory") === true;
  const ready = connected && supported;

  const pairedNow = useCallback(() => {
    const live = useLive.getState();
    const saved = useSettings.getState();
    return navigation.isFocused() && AppState.currentState === "active" && !!server && !!viewer &&
      saved.server === server && saved.deviceId === viewer && live.self?.id === viewer && live.link !== "unauthorized";
  }, [navigation, server, viewer]);
  const connectedNow = useCallback(() => {
    const live = useLive.getState();
    const device = live.devices[host.id];
    return pairedNow() && live.link === "online" && device?.kind === "host" && device.online;
  }, [host.id, pairedNow]);
  const readableNow = useCallback(() => connectedNow() &&
    useLive.getState().devices[host.id]?.sources?.includes("dsh-directory") === true, [connectedNow, host.id]);

  // Invalidate even if a disconnect and reconnect are batched into one render.
  // This also fences exact replies that arrive after the tab or app loses focus.
  useLayoutEffect(() => {
    if (!ready) return;
    const invalidate = () => { setEpoch(++generation.current); };
    const check = () => { if (!readableNow()) invalidate(); };
    const removeBlur = navigation.addListener("blur", invalidate);
    const app = AppState.addEventListener("change", (state) => { if (state !== "active") invalidate(); });
    const removeLive = useLive.subscribe(check);
    const removeSettings = useSettings.subscribe(check);
    check();
    return () => { removeBlur(); app.remove(); removeLive(); removeSettings(); };
  }, [ready, navigation, readableNow]);
  const current = useCallback(() => generation.current === epoch && readableNow(), [epoch, readableNow]);
  const scrollTop = () => scroll.current?.scrollTo({ y: 0, animated: false });

  function changeLocal(id: string, mode: FollowAction) {
    if (!change(id, mode)) setNotice({ text: "无法修改关注，请检查授权或关注上限。", warn: true });
  }

  function changeFollow(id: string, mode: FollowAction) {
    if (current()) changeLocal(id, mode);
  }

  async function dispatch(target: Target, input: string) {
    if (!current() || sendPending.current) return;
    sendPending.current = true;
    setSending(true);
    setNotice(undefined);
    const id = requestId();
    try {
      const receipt = await call(host.id, "runtimeSessions.send", { runtime: "dsh", ...target, requestId: id, input }, 20_000);
      if (receipt?.accepted !== true || receipt.requestId !== id) throw new Error("Unverified receipt");
      const tracking = useLive.getState().runtimeTaskNotices;
      const alertsOn = useSettings.getState().alertsOn;
      setNotice({ text: "目标会话已确认接收，不代表任务已完成。" + (demo ? "" : !tracking ? " 当前中转不支持 DSH 任务提醒。" : !alertsOn ? " 开启后台提醒后可收到任务通知。" : "") });
    } catch (error) {
      setNotice({ warn: true, text: error instanceof RelayError && DECLINED.has(error.code)
        ? "发送请求已被拒绝。"
        : "未收到明确回执。请先在电脑的原会话核对，不要重发。" });
    } finally {
      sendPending.current = false;
      setSending(false);
    }
  }

  function leave(callback: () => void) {
    setEpoch(++generation.current);
    callback();
  }

  return (
    <PageBackground>
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xxl, gap: space.md }}>
        <View style={ACTIONS}>
          <Button icon="arrow-left" contentStyle={ACTION} onPress={() => leave(onBack)}>返回设备</Button>
          {onLegacy ? <Button contentStyle={ACTION} disabled={!connected || sending} onPress={() => { if (connectedNow()) leave(onLegacy); }}>旧版 / Codex 会话</Button> : null}
        </View>
        <PageTitle sub={demo ? "演示数据 · 未连接真实 DSH" : ready ? liveHost?.name : undefined}>DSH 会话目录</PageTitle>
        {foreground && paired && (notice || sending) ? (
          <Text accessibilityLiveRegion="polite" style={{ color: notice?.warn ? p.error : p.ink }}>{sending ? "已发送请求，等待接收回执…" : notice?.text}</Text>
        ) : null}
        {ready ? (
          <DirectoryContent key={`${epoch}:${suggestion.version}`} hostId={host.id} intent={suggestion.epoch === epoch ? intent : undefined} {...{ focusSessionId, tab, setTab, follows, current, scrollTop, sending, changeFollow, dispatch, setNotice }} />
        ) : foreground ? (
          <>
            <Text accessibilityLiveRegion="polite" style={{ color: p.muted }}>
              {!paired ? "请连接已配对的手机后查看目录。" : connected && !supported ? PROBLEM.unsupported : "电脑或中继未连接，已隐藏会话信息。"}
            </Text>
            {paired ? (
              <>
                <DirectoryTabs {...{ tab, setTab }} />
                {tab === "follows" ? <UnavailableFollows items={follows} onRemove={(id) => { if (pairedNow()) changeLocal(id, "unfollow"); }} /> : null}
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </PageBackground>
  );
}

function DirectoryTabs({ tab, setTab, profile }: { tab: Tab; setTab: (tab: Tab) => void; profile?: boolean }) {
  return (
    <View style={ACTIONS}>
      <Button mode={tab === "directory" ? "contained" : "outlined"} contentStyle={ACTION} accessibilityState={{ selected: tab === "directory" }} onPress={() => setTab("directory")}>{profile === false ? "已分享" : profile === true ? "全部" : "目录"}</Button>
      <Button mode={tab === "follows" ? "contained" : "outlined"} contentStyle={ACTION} accessibilityState={{ selected: tab === "follows" }} onPress={() => setTab("follows")}>关注</Button>
    </View>
  );
}

function UnavailableFollows({ items, onRemove }: { items: DshFollow[]; onRemove: (id: string) => void }) {
  const p = usePalette();
  return items.length ? items.map(({ sessionId }, i) => (
    <Card key={sessionId} flat style={{ padding: space.md }}>
      <Text style={{ color: p.muted }}>已关注的会话暂不可见</Text>
      <Button contentStyle={ACTION} accessibilityLabel={`取消关注第 ${i + 1} 项不可见会话`} onPress={() => onRemove(sessionId)}>取消关注</Button>
    </Card>
  )) : <Text style={{ color: p.muted }}>还没有关注这台电脑上的会话。</Text>;
}

function DirectoryContent({ hostId, intent, focusSessionId, tab, setTab, follows, current, scrollTop, sending, changeFollow, dispatch, setNotice }: {
  hostId: string; intent?: DshIntent; focusSessionId?: string; tab: Tab; setTab: (tab: Tab) => void; follows: DshFollow[]; current: () => boolean;
  scrollTop: () => void; sending: boolean; changeFollow: (id: string, mode: FollowAction) => void;
  dispatch: (target: Target, input: string) => Promise<void>; setNotice: (notice: Notice) => void;
}) {
  const p = usePalette();
  const [typed, setTyped] = useState(intent?.search ?? "");
  const [search, setSearch] = useState(intent?.search ?? "");
  const [badSearch, setBadSearch] = useState(false);
  const [projectId, setProjectId] = useState<string>();
  const [chooseProject, setChooseProject] = useState(false);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<Target>();
  const [focus, setFocus] = useState(focusSessionId);
  const [suggestedDraft, setSuggestedDraft] = useState(intent?.action === "send" ? intent.draft : undefined);
  const [editorDraft, setEditorDraft] = useState<string>();
  const after = cursors.at(-1);
  const ids = focus ?? (tab === "follows" ? follows.slice(0, DSH_DIRECTORY_PAGE_SIZE).map((item) => item.sessionId).join(",") : "");
  const view = target ? undefined : focus || tab === "follows" ? "exact" : chooseProject ? "projects" : "sessions";
  const request = useMemo<DshDirectoryRequest | undefined>(() => {
    if (view === "exact") return ids ? { view, sessionIds: ids.split(",") } : undefined;
    const page = after ? { after } : {};
    if (view === "projects") return { view, ...page };
    if (view === "sessions") return { view, ...(projectId ? { projectId } : {}), ...(search ? { search } : {}), ...page };
  }, [view, ids, projectId, search, after]);
  const reply = useBrowse(hostId, request, revision, current);
  const data = reply?.data;
  const error = reply?.problem;
  const waiting = !!request && !reply;
  const entries = data?.view === "sessions" || data?.view === "exact" ? data.entries : [];
  const next = data && data.view !== "exact" && isRuntimeId(data.next) && data.next > (after ?? "") ? data.next : undefined;
  const saved = new Map(follows.map((item) => [item.sessionId, item]));
  const exact = new Map(data?.view === "exact" ? entries.map((entry) => [entry.session.id, entry]) : []);

  function firstPage() { setCursors([undefined]); scrollTop(); }
  function clearFilters() { setTyped(""); setSearch(""); setProjectId(undefined); setChooseProject(false); setBadSearch(false); }
  function refresh() {
    if (!current()) return;
    if (error) clearFilters();
    firstPage(); setRevision((n) => n + 1);
  }
  function findTitle() {
    if (!current() || error) return;
    const title = typed.trim();
    if (title.length > DSH_DIRECTORY_SEARCH_LIMIT || SEARCH_CONTROL.test(title)) { setBadSearch(true); return; }
    Keyboard.dismiss();
    setSearch(title); setBadSearch(false); refresh();
  }
  function chooseTarget(entry: DshDirectoryEntry) {
    if (!current() || sending || entry.archived || entry.session.canSend !== true || !isRuntimeId(entry.project.id) || !isRuntimeId(entry.session.id)) return;
    setEditorDraft(suggestedDraft);
    setSuggestedDraft(undefined);
    setTarget({ projectId: entry.project.id, sessionId: entry.session.id }); scrollTop();
  }
  function closeEditor(clear: boolean) {
    setTarget(undefined);
    if (clear) clearFilters();
    firstPage(); setRevision((n) => n + 1);
  }

  if (target) return <Composer {...{ hostId, target, current, dispatch, setNotice }} initialDraft={editorDraft} onClose={closeEditor} />;
  if (focus) return (
    <>
      <Button mode="outlined" contentStyle={ACTION} onPress={() => { setFocus(undefined); setTab("directory"); }}>查看全部会话</Button>
      <Text style={{ color: p.muted }}>通知对应的会话。若需工具审批，请在电脑上的原 DSH 会话中决定。</Text>
      <Button icon="refresh" contentStyle={ACTION} disabled={waiting} onPress={refresh}>刷新</Button>
      {waiting ? <ActivityIndicator accessibilityLabel="正在读取通知对应的会话" /> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: p.error }}>{PROBLEM[error]}</Text> : null}
      {data && !exact.has(focus) ? <Text style={{ color: p.muted }}>原会话已不可见或不在这台电脑上。</Text> : null}
      {entries.filter((entry) => entry.session.id === focus).map((entry) => (
        <SessionRow key={entry.session.id} {...{ entry, sending, changeFollow, chooseTarget }} follow={saved.get(entry.session.id)} />
      ))}
    </>
  );
  const followTab = tab === "follows";
  const locked = !!error;
  return (
    <>
      <DirectoryTabs tab={tab} profile={data ? data.scope === "profile" : undefined} setTab={(value) => {
        if (value === tab) return;
        if (locked) clearFilters();
        setChooseProject(false); firstPage(); setTab(value);
      }} />
      <Text style={{ color: p.muted }}>
        {followTab ? "关注仅保存在本机。开启提醒后，只有应用在前台且检测到会话从工作中变为空闲才会提醒；不在后台推送，也不代表任务成功。" : "按这台电脑的项目和会话标题或 ID 搜索。归档会话只读。"}
      </Text>
      {!followTab && !locked ? chooseProject ? (
        <Button mode="outlined" contentStyle={ACTION} onPress={() => { setChooseProject(false); firstPage(); }}>返回会话列表</Button>
      ) : (
        <>
          {intent ? <Text style={{ color: p.muted }}>{intent.action === "send" ? "已准备草稿。请选择实际会话并确认发送；不会自动发给搜索结果。" : `这是搜索建议。核对会话后，请用会话行的${intent.action === "follow" ? "关注" : "取消关注"}按钮操作。`}</Text> : null}
          <TextInput mode="outlined" label="搜索项目、会话标题或 ID" value={typed} maxLength={DSH_DIRECTORY_SEARCH_LIMIT} onChangeText={(text) => { setTyped(text); setBadSearch(false); }} onSubmitEditing={findTitle} returnKeyType="search" error={badSearch} />
          {badSearch ? <Text style={{ color: p.error }}>搜索标题不能包含控制字符。</Text> : null}
          <View style={ACTIONS}>
            <Button contentStyle={ACTION} mode="outlined" onPress={findTitle}>搜索</Button>
            <Button contentStyle={ACTION} mode="outlined" onPress={() => { setChooseProject(true); firstPage(); }}>筛选项目</Button>
            {projectId ? <Button contentStyle={ACTION} onPress={() => { setProjectId(undefined); firstPage(); }}>清除项目筛选</Button> : null}
          </View>
          {projectId ? <Text style={{ color: p.muted }}>项目：{entries[0]?.project.title ?? "已选择"}</Text> : null}
        </>
      ) : null}
      <Button icon="refresh" contentStyle={ACTION} disabled={waiting || !request} onPress={refresh}>刷新</Button>
      {waiting ? <ActivityIndicator accessibilityLabel="正在读取 DSH 目录" /> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: p.error }}>{PROBLEM[error]}</Text> : null}
      {data?.view === "projects" ? (data.projects.length ? data.projects.map((project) => (
        <Card key={project.id} flat accessibilityLabel={`筛选项目：${project.title}`} onPress={() => {
          if (!current() || !isRuntimeId(project.id)) return;
          setProjectId(project.id); setChooseProject(false); firstPage();
        }} style={{ minHeight: 48, justifyContent: "center", padding: space.md }}>
          <Text style={{ color: p.ink, fontFamily: fonts.bodySemi }}>{project.title}</Text>
        </Card>
      )) : <Text style={{ color: p.muted }}>没有可见项目。</Text>) : null}
      {data?.view === "sessions" && !entries.length ? <Text style={{ color: p.muted }}>{search ? "没有匹配的可见会话。" : "没有可见会话。"}</Text> : null}
      {data?.view === "sessions" ? entries.map((entry) => (
        <SessionRow key={entry.session.id} {...{ entry, sending, changeFollow, chooseTarget }} follow={saved.get(entry.session.id)} />
      )) : null}
      {followTab && !waiting ? (data?.view === "exact" ? (
        <>
          {follows.map((follow) => {
            const entry = exact.get(follow.sessionId);
            return entry ? <SessionRow key={follow.sessionId} {...{ entry, follow, sending, changeFollow, chooseTarget }} /> : null;
          })}
          {follows.some((item) => !exact.has(item.sessionId)) ? <UnavailableFollows items={follows.filter((item) => !exact.has(item.sessionId))} onRemove={(id) => changeFollow(id, "unfollow")} /> : null}
        </>
      ) : <UnavailableFollows items={follows} onRemove={(id) => changeFollow(id, "unfollow")} />) : null}
      {data && data.view !== "exact" && (cursors.length > 1 || next) ? (
        <View style={ACTIONS}>
          <Button contentStyle={ACTION} disabled={cursors.length < 2} onPress={() => { setCursors(cursors.slice(0, -1)); scrollTop(); }}>上一页</Button>
          <Button contentStyle={ACTION} disabled={!next} onPress={() => { if (next) { setCursors([...cursors, next]); scrollTop(); } }}>下一页</Button>
        </View>
      ) : null}
    </>
  );
}

function SessionRow({ entry, follow, sending, changeFollow, chooseTarget }: {
  entry: DshDirectoryEntry; follow?: DshFollow; sending: boolean; changeFollow: (id: string, mode: FollowAction) => void; chooseTarget: (entry: DshDirectoryEntry) => void;
}) {
  const p = usePalette();
  const { session, project, archived } = entry;
  const writable = !archived && session.canSend === true;
  const followLabel = follow ? "取消关注" : "关注";
  const remindLabel = follow?.remind ? "关闭空闲提醒" : "开启空闲提醒";
  return (
    <Card flat style={{ padding: space.md, gap: space.xs }}>
      <Text style={{ color: p.ink, fontFamily: fonts.bodyBold }}>{session.title}</Text>
      <Text style={{ color: p.muted }}>{project.title} · {archived ? "已归档 · 只读" : `${STATE[session.state] ?? "状态未知"}${writable ? "" : " · 只读"}`} · {session.id.slice(-8)}</Text>
      <View style={ACTIONS}>
        <Button contentStyle={ACTION} accessibilityLabel={`${followLabel}：${session.title}`} onPress={() => changeFollow(session.id, follow ? "unfollow" : "follow")}>{followLabel}</Button>
        {follow && (!archived || follow.remind) ? <Button contentStyle={ACTION} accessibilityLabel={`${remindLabel}：${session.title}`} onPress={() => changeFollow(session.id, follow.remind ? "mute" : "remind")}>{remindLabel}</Button> : null}
        {writable ? <Button contentStyle={ACTION} disabled={sending} accessibilityLabel={`选择发送目标：${project.title}／${session.title}`} onPress={() => chooseTarget(entry)}>选为发送目标</Button> : null}
      </View>
    </Card>
  );
}

function Composer({ hostId, target, current, dispatch, setNotice, onClose, initialDraft }: {
  hostId: string; target: Target; current: () => boolean; dispatch: (target: Target, input: string) => Promise<void>;
  setNotice: (notice: Notice) => void; onClose: (clear: boolean) => void; initialDraft?: string;
}) {
  const p = usePalette();
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [confirm, setConfirm] = useState(false);
  const [checking, setChecking] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const request = useMemo(() => ({ view: "exact" as const, sessionIds: [target.sessionId] }), [target.sessionId]);
  const result = useBrowse(hostId, request, 0, current);
  const verified = writable(result?.data, target);
  const canSend = !!verified && !!draft.trim() && !/[\0\uD800-\uDFFF]/u.test(draft) && draft.length <= RUNTIME_SESSION_TEXT_LIMIT;

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function submit() {
    if (!confirm || !canSend || !verified || pending.current || !current()) return;
    pending.current = true;
    setChecking(true);
    try {
      // Re-read immediately before dispatch. A moved or renamed session must be selected again.
      const fresh = writable(await browse(hostId, request), target);
      if (!mounted.current || !current()) return;
      if (!fresh || fresh.project.title !== verified.project.title || fresh.session.title !== verified.session.title) {
        setNotice({ text: "未发送：目标已变化或不可发送，请重新选择。", warn: true });
        onClose(true);
        return;
      }
    } catch (error) {
      if (mounted.current && current()) {
        setNotice({ text: `未发送：${PROBLEM[problem(error)]}`, warn: true });
        onClose(true);
      }
      return;
    }
    void dispatch(target, draft);
    onClose(false);
  }

  return (
    <Card flat style={{ padding: space.md, gap: space.sm }}>
      <Button contentStyle={ACTION} disabled={checking} onPress={() => onClose(!verified)}>返回会话列表</Button>
      {!result ? <ActivityIndicator accessibilityLabel="正在核对发送目标" /> : null}
      {result && !verified ? <Text accessibilityLiveRegion="polite" style={{ color: p.error }}>{result.problem ? PROBLEM[result.problem] : "目标已移动、不可见或只读。请重新选择。"}</Text> : null}
      {verified ? (
        <>
          <Text style={{ color: p.ink, fontFamily: fonts.bodyBold }}>发送到：{verified.project.title}／{verified.session.title}</Text>
          <TextInput label="发送内容" mode="outlined" multiline maxLength={RUNTIME_SESSION_TEXT_LIMIT} value={draft} editable={!checking} onChangeText={setDraft} />
          <Button contentStyle={ACTION} mode="contained" disabled={!canSend || checking} onPress={() => { if (current()) { Keyboard.dismiss(); setConfirm(true); } }}>确认发送目标</Button>
        </>
      ) : null}
      {confirm && verified ? (
        <Portal>
          <Dialog visible dismissable={!checking} onDismiss={() => { if (!pending.current) setConfirm(false); }} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
            <Dialog.Title>发送给这个 DSH 会话？</Dialog.Title>
            <Dialog.Content style={{ gap: space.sm }}>
              <Text>{verified.project.title}／{verified.session.title}</Text>
              <Text variant="bodySmall" style={{ color: p.muted }}>会话 ID：{verified.session.id}</Text>
              <Text numberOfLines={5}>{draft}</Text>
              {checking ? <Text accessibilityLiveRegion="polite" style={{ color: p.muted }}>正在重新核对目标…</Text> : null}
            </Dialog.Content>
            <Dialog.Actions>
              <Button contentStyle={ACTION} disabled={checking} onPress={() => { if (!pending.current) setConfirm(false); }}>取消</Button>
              <Button contentStyle={ACTION} disabled={checking || !canSend} loading={checking} onPress={() => void submit()}>发送一次</Button>
            </Dialog.Actions>
          </Dialog>
        </Portal>
      ) : null}
    </Card>
  );
}
