/**
 * "新建 agent / 新建空间" bottom sheet. Talks to the chosen host with `spaces.list` (read-only)
 * and `agent.create`; on success jumps to the new agent (which may take a moment to appear).
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Pressable, ScrollView, TextInput as RNTextInput, View } from "react-native";
import { ActivityIndicator, Button, Text } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import type { Device } from "@xiaoaixiaoai/protocol";
import { call, type RelayError } from "../lib/relay";
import { harnessLook } from "../lib/harness";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { HarnessAvatar } from "./ui";
import { SpaceBadge } from "./agents";

export interface CreateTarget {
  /** Preferred host id. */
  host?: string | null;
  /** Existing space name to add a tab to; null = new space. */
  spaceName?: string | null;
}

const NEW = "__new__";

function Chip({ on, label, onPress, lead, a11y, disabled }: { on: boolean; label: string; onPress: () => void; lead?: React.ReactNode; a11y?: string; disabled?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled }}
      accessibilityLabel={a11y ?? label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 40,
        paddingLeft: lead ? 6 : 14,
        paddingRight: 14,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: on ? p.accentText : p.divider,
        backgroundColor: on ? p.accentContainer : pressed ? p.surface3 : p.surface,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {lead}
      <Text numberOfLines={1} style={{ maxWidth: 180, color: p.ink, fontFamily: on ? fonts.bodyBold : fonts.bodySemi, fontSize: 13.5 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Field({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  const p = usePalette();
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ fontFamily: fonts.bodyBold, color: p.ink, fontSize: 14 }}>{title}</Text>
      {children}
      {hint ? <Text style={{ color: p.faint, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

export function CreateAgentSheet({ visible, onDismiss, target, hosts }: { visible: boolean; onDismiss: () => void; target: CreateTarget; hosts: Device[] }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const online = hosts.filter((h) => h.online);
  const pickHost = () => {
    if (target.host && hosts.some((h) => h.id === target.host)) return target.host;
    const creatable = online.find((h) => h.sources?.includes("hc") || h.sources?.includes("runtime-create"));
    return creatable?.id ?? online[0]?.id ?? null;
  };
  const [host, setHost] = useState<string | null>(pickHost);
  const [spaceId, setSpaceId] = useState<string>(NEW);
  const [spaceName, setSpaceName] = useState("");
  const [folder, setFolder] = useState("");
  const [launcher, setLauncher] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["spaces.list", host],
    queryFn: () => call(host!, "spaces.list", {}),
    enabled: visible && !!host,
    staleTime: 5000,
    retry: false,
  });

  // Reset on the opening edge, before rendering the form. Keep the Modal mounted for its close animation.
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) {
      setHost(pickHost());
      setSpaceName("");
      setTask("");
      setError(null);
      setBusy(false);
    }
  }

  // Once spaces arrive: preselect the requested space, the space's folder, and a launcher.
  useEffect(() => {
    const d = q.data;
    if (!d || !visible) return;
    const sp = target.spaceName ? d.spaces.find((s) => s.name === target.spaceName) : undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initialize the form from a newly received external spaces.list snapshot.
    setSpaceId(sp ? sp.id : NEW);
    setFolder(sp?.folder ?? "");
    setLauncher((l) => (l && d.launchers.some((x) => x.id === l) ? l : d.launchers[0]?.id ?? null));
  }, [q.data, visible, target.spaceName]);

  const d = q.data;
  const selectedHost = hosts.find((h) => h.id === host);
  const isRuntimeHost = !!(selectedHost?.sources?.includes("runtime-create") && !selectedHost?.sources?.includes("hc"));
  // A computer without the desktop herdr (Windows): no spaces, just a terminal in a folder.
  const standalone = !!d?.standalone;
  const isNew = spaceId === NEW && !standalone && !isRuntimeHost;
  const chosenSpace = d?.spaces.find((s) => s.id === spaceId);
  const launch = d?.launchers.find((l) => l.id === launcher);
  // Programs that can't take a task at start get it typed in once they're up, where the computer does that.
  const takesTask = !!launch && launch.id !== "shell" && (launch.takesTask || !!d?.typesTask);
  const folders = useMemo(() => {
    const list = [...(d?.folders ?? [])];
    if (chosenSpace?.folder && !list.includes(chosenSpace.folder)) list.unshift(chosenSpace.folder);
    return list.slice(0, 8);
  }, [d?.folders, chosenSpace]);
  const canSubmit = !!host && !!d?.canCreate && !!launcher && !busy;

  async function submit() {
    if (!host || !launcher || !d) return;
    setBusy(true);
    setError(null);
    try {
      const first = takesTask && task.trim() ? task.trim() : undefined;
      // A task typed in after start makes the computer wait for the program (up to about 45 s).
      const typed = !!first && !launch?.takesTask;
      const res = await call(
        host,
        "agent.create",
        {
          ...(standalone ? {} : spaceId !== NEW ? { space: spaceId } : isRuntimeHost ? {} : { spaceName: spaceName.trim() || undefined }),
          folder: folder.trim() || undefined,
          launcher,
          task: first,
        },
        typed ? 90_000 : undefined,
      );
      onDismiss();
      if (res.task === "failed") Alert.alert("开好了，但第一句话没交给它", res.taskNote ?? "它现在空着，没在做这件事。");
      router.push({ pathname: "/agent/[key]", params: { key: res.agent, fresh: String(Date.now()) } });
    } catch (e) {
      const err = e as RelayError;
      // It may well be open already: say so, so nobody taps again and gets two.
      setError(err.code === "timeout" ? "电脑那边还没回话，它可能已经开好了。先去 Agents 列表看一眼，别重复点" : err.message);
    } finally {
      setBusy(false);
    }
  }

  const input = { backgroundColor: p.surface2, borderRadius: radius.md, borderWidth: 1, borderColor: p.divider, paddingHorizontal: space.md, minHeight: 46, color: p.ink, fontFamily: fonts.body, fontSize: 15 } as const;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable accessibilityLabel="关闭" onPress={onDismiss} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(30,26,38,0.38)" }} />
        <View style={{ maxHeight: "88%", backgroundColor: p.page, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: "hidden" }}>
          <View style={{ alignItems: "center", paddingTop: space.sm }}>
            <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: p.divider }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.sm }}>
            <Text style={{ flex: 1, fontFamily: fonts.cute, fontSize: 22, lineHeight: 30, color: p.ink }}>{isRuntimeHost ? "新建会话" : standalone ? "新建 agent" : isNew ? "新建空间" : "在这里新建 agent"}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onDismiss} hitSlop={8} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
              <MaterialCommunityIcons name="close" size={22} color={p.muted} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
            <Field title="电脑">
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                {hosts.map((h) => (
                  <Chip
                    key={h.id}
                    on={host === h.id}
                    disabled={!h.online}
                    onPress={() => setHost(h.id)}
                    label={h.name}
                    a11y={`${h.name}，${h.online ? "在线" : "离线"}`}
                    lead={<View style={{ width: 8, height: 8, borderRadius: 4, marginLeft: 6, backgroundColor: h.online ? "#3FB68B" : p.faint }} />}
                  />
                ))}
              </View>
            </Field>

            {!host ? (
              <Text style={{ color: p.muted }}>没有在线的电脑。</Text>
            ) : q.isLoading ? (
              <ActivityIndicator style={{ marginVertical: space.xxl }} />
            ) : q.isError ? (
              <Text style={{ color: p.error }}>{(q.error as Error).message}</Text>
            ) : d ? (
              <>
                {!d.canCreate ? (
                  <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center", backgroundColor: p.errorContainer, borderRadius: radius.md, padding: space.md }}>
                    <MaterialCommunityIcons name="information-outline" size={18} color={p.error} />
                    <Text style={{ flex: 1, color: p.error, fontSize: 13.5 }}>{d.reason ?? "这台电脑现在不能新建。"}</Text>
                  </View>
                ) : null}

                {standalone || (isRuntimeHost && !d.spaces.length) ? null : (
                  <Field title={isRuntimeHost ? "工作区 / 项目" : "空间"}>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                      <Chip on={spaceId === NEW} onPress={() => { setSpaceId(NEW); setFolder(""); }} label={isRuntimeHost ? "默认位置" : "新建空间"} lead={<MaterialCommunityIcons name="plus" size={18} color={p.ink} style={{ marginLeft: 4 }} />} />
                      {d.spaces.map((s) => (
                        <Chip key={s.id} on={spaceId === s.id} onPress={() => { setSpaceId(s.id); setFolder(s.folder ?? ""); }} label={s.name} lead={<SpaceBadge name={s.name} size={26} />} a11y={`${isRuntimeHost ? "项目" : "空间"} ${s.name}`} />
                      ))}
                    </View>
                  </Field>
                )}

                {isNew ? (
                  <Field title="空间名字">
                    <RNTextInput value={spaceName} onChangeText={setSpaceName} placeholder="不填就用文件夹名" placeholderTextColor={p.faint} style={input} accessibilityLabel="空间名字" />
                  </Field>
                ) : null}

                <Field title="文件夹" hint={isNew || standalone ? "不填就是 ~" : "不填就用这个空间的文件夹"}>
                  {folders.length ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
                      {folders.map((f) => (
                        <Chip key={f} on={folder === f} onPress={() => setFolder(folder === f ? "" : f)} label={f} />
                      ))}
                    </ScrollView>
                  ) : null}
                  <RNTextInput
                    value={folder}
                    onChangeText={setFolder}
                    placeholder="~/work_file/项目"
                    placeholderTextColor={p.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[input, { fontFamily: fonts.mono, fontSize: 14 }]}
                    accessibilityLabel="文件夹路径"
                  />
                </Field>

                <Field title="程序">
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    {d.launchers.map((l) => (
                      <Chip
                        key={l.id}
                        on={launcher === l.id}
                        onPress={() => setLauncher(l.id)}
                        label={l.label}
                        lead={<HarnessAvatar harness={l.id === "shell" ? "sh" : l.id} isShell={l.id === "shell"} size={28} />}
                        a11y={harnessLook(l.id, l.id === "shell").label}
                      />
                    ))}
                  </View>
                </Field>

                {takesTask ? (
                  <Field title="第一句话" hint={launch?.takesTask ? "可选，启动后直接发给它" : "可选，等它启动好后由电脑打进去"}>
                    <RNTextInput
                      value={task}
                      onChangeText={setTask}
                      multiline
                      placeholder="比如：帮我看看这个项目的测试为什么挂了"
                      placeholderTextColor={p.faint}
                      style={[input, { minHeight: 88, paddingVertical: space.sm, textAlignVertical: "top" }]}
                      accessibilityLabel="第一句话"
                    />
                  </Field>
                ) : null}

                {error ? <Text style={{ color: p.error, lineHeight: 20 }}>{error}</Text> : null}
              </>
            ) : null}
          </ScrollView>

          <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: insets.bottom + space.md, gap: space.xs, borderTopWidth: 1, borderTopColor: p.divider }}>
            <Text style={{ color: p.faint, fontSize: 12, textAlign: "center" }}>
              {busy && takesTask && task.trim() && !launch?.takesTask
                ? "等它启动好再把第一句话打进去，可能要半分钟到一分钟"
                : isRuntimeHost
                  ? "建好后会自动同步到会话列表，并可在电脑端对应工具中继续查看"
                  : standalone
                    ? "建好后，在电脑上用 hc attach 可以接手它"
                    : "建好后，电脑上的 herdr 会自动切到这个空间"}
            </Text>
            <Button mode="contained" disabled={!canSubmit} loading={busy} onPress={submit} contentStyle={{ height: 50 }} style={{ borderRadius: radius.pill }} labelStyle={{ fontSize: 16 }}>
              {isNew ? "新建空间并启动" : isRuntimeHost ? "新建会话" : "新建 agent"}
            </Button>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
