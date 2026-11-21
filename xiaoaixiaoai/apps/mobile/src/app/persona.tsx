import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Button, Dialog, Divider, Portal, Snackbar, Switch, Text, TextInput } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  MEMORY_CATEGORIES,
  type AssistantMemoryItem,
  type AssistantPersonaConfig,
  type MemoryCategory,
  type PersonaPresetSummary,
} from "@xiaoaixiaoai/protocol";
import { Card, PageBackground, SectionHeader } from "../components/ui";
import {
  clearAllMemories,
  createMemory,
  deleteMemory,
  exportMemoriesMarkdown,
  loadAssistantProfile,
  loadMemories,
  saveAssistantProfile,
  updateMemory,
  useAssistant,
} from "../lib/assistant";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";

function categoryMeta(id: MemoryCategory) {
  return MEMORY_CATEGORIES.find((c) => c.id === id) ?? MEMORY_CATEGORIES[MEMORY_CATEGORIES.length - 1]!;
}

function shortDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function PersonaMemoryScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const profile = useAssistant((s) => s.profile);
  const presets = useAssistant((s) => s.presets);
  const memories = useAssistant((s) => s.memories);
  const memoriesTotal = useAssistant((s) => s.memoriesTotal);

  const [toast, setToast] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  // Server-backed persona draft overrides (null field falls back to latest server profile)
  const [draft, setDraft] = useState<Partial<Pick<AssistantPersonaConfig, "name" | "userCall" | "presetId" | "personaText" | "autoMemory">>>({});
  const name = draft.name ?? profile?.name ?? "爱弥斯";
  const userCall = draft.userCall ?? profile?.userCall ?? "哥哥";
  const presetId = draft.presetId ?? profile?.presetId ?? "wuthering_aemeath";
  const personaText = draft.personaText ?? profile?.personaText ?? "";
  const autoMemory = draft.autoMemory ?? profile?.autoMemory ?? true;

  // Memory filter & search
  const [selectedCat, setSelectedCat] = useState<MemoryCategory | "all">("all");
  const [searchQ, setSearchQ] = useState("");

  // Add / Edit memory modal
  const [memOpen, setMemOpen] = useState(false);
  const [editingMem, setEditingMem] = useState<AssistantMemoryItem | null>(null);
  const [memCat, setMemCat] = useState<MemoryCategory>("note");
  const [memContent, setMemContent] = useState("");
  const [memSlot, setMemSlot] = useState("");
  const [memImportance, setMemImportance] = useState<1 | 2 | 3>(2);
  const [memPinned, setMemPinned] = useState(false);
  const [memTtlDays, setMemTtlDays] = useState("");
  const [savingMem, setSavingMem] = useState(false);

  // Clear confirmation dialog
  const [clearConfirm, setClearConfirm] = useState(false);

  useEffect(() => {
    void loadAssistantProfile().catch((e) => setToast((e as Error).message));
    void loadMemories({}).catch((e) => setToast((e as Error).message));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadMemories({
        category: selectedCat === "all" ? undefined : selectedCat,
        q: searchQ.trim() || undefined,
      }).catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [selectedCat, searchQ]);

  const activePreset = useMemo(
    () => presets.find((item) => item.id === presetId),
    [presets, presetId],
  );

  const profileDirty = useMemo(() => {
    if (!profile) return false;
    return (
      name.trim() !== profile.name.trim() ||
      userCall.trim() !== profile.userCall.trim() ||
      presetId !== profile.presetId ||
      personaText.trim() !== profile.personaText.trim() ||
      autoMemory !== profile.autoMemory
    );
  }, [profile, name, userCall, presetId, personaText, autoMemory]);

  function applyPreset(preset: PersonaPresetSummary) {
    setDraft((prev) => ({
      ...prev,
      presetId: preset.id,
      userCall: preset.userCall,
      personaText: preset.personaText,
    }));
  }

  async function onSaveProfile() {
    if (!name.trim()) return setToast("名字不能为空");
    setSavingProfile(true);
    try {
      await saveAssistantProfile({
        name: name.trim(),
        userCall: userCall.trim(),
        presetId,
        personaText: personaText.trim(),
        autoMemory,
      });
      setDraft({});
      setToast("人设已保存到服务器");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSavingProfile(false);
    }
  }

  function openNewMemory() {
    setEditingMem(null);
    setMemCat(selectedCat === "all" ? "note" : selectedCat);
    setMemContent("");
    setMemSlot("");
    setMemImportance(2);
    setMemPinned(false);
    setMemTtlDays("");
    setMemOpen(true);
  }

  function openEditMemory(m: AssistantMemoryItem) {
    setEditingMem(m);
    setMemCat(m.category);
    setMemContent(m.content);
    setMemSlot(m.slotKey ?? "");
    setMemImportance(m.importance);
    setMemPinned(!!m.pinned);
    setMemTtlDays("");
    setMemOpen(true);
  }

  async function onSaveMemory() {
    const content = memContent.trim();
    if (!content) return setToast("记忆内容不能为空");
    setSavingMem(true);
    try {
      if (editingMem) {
        await updateMemory(editingMem.id, {
          category: memCat,
          content,
          slotKey: memSlot.trim() || undefined,
          importance: memImportance,
          pinned: memPinned,
        });
        setToast("记忆已更新");
      } else {
        const ttl = memTtlDays.trim() ? Number(memTtlDays.trim()) : undefined;
        if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
          setSavingMem(false);
          return setToast("有效天数请填正整数，或留空代表长期保存");
        }
        const res = await createMemory({
          category: memCat,
          content,
          slotKey: memSlot.trim() || undefined,
          importance: memImportance,
          pinned: memPinned,
          ...(ttl ? { ttlDays: ttl } : {}),
        });
        setToast(res.replaced ? "同槽位旧记忆已自动更新为最新内容" : "已存入服务器记忆库");
      }
      setMemOpen(false);
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSavingMem(false);
    }
  }

  async function togglePin(m: AssistantMemoryItem) {
    try {
      await updateMemory(m.id, { pinned: !m.pinned });
      setToast(!m.pinned ? "已设为置顶核心记忆" : "已取消置顶");
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  async function removeMemory(m: AssistantMemoryItem) {
    try {
      await deleteMemory(m.id);
      setToast("已从服务器删除该条记忆");
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  async function onExportMarkdown() {
    try {
      const md = await exportMemoriesMarkdown();
      await Clipboard.setStringAsync(md);
      setToast("人设与记忆库 Markdown 已复制到剪贴板");
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  async function onClearAll() {
    try {
      const n = await clearAllMemories();
      setClearConfirm(false);
      setToast(`已清空 ${n} 条服务器记忆`);
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  const personaLen = Array.from(personaText).length;

  return (
    <PageBackground>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xxxl, paddingHorizontal: space.lg, gap: space.md }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ paddingTop: space.sm }}>
          <Text style={{ color: p.muted, fontSize: 13, lineHeight: 19 }}>
            人设与长期记忆统一保存在你的中继服务器 SQLite 中，换手机、重装 App 或清理聊天记录都不会丢失，文字和语音通话实时共用。
          </Text>
        </View>

        <SectionHeader title="人设设定" />
        <Card style={{ padding: space.lg, gap: space.md }}>
          {presets.length ? (
            <View style={{ gap: space.xs }}>
              <Text style={{ color: p.muted, fontSize: 12.5, fontFamily: fonts.bodySemi }}>人设模板</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: 2 }}>
                {presets.map((preset) => {
                  const selected = presetId === preset.id;
                  return (
                    <Pressable
                      key={preset.id}
                      onPress={() => applyPreset(preset)}
                      style={({ pressed }) => ({
                        paddingHorizontal: space.md,
                        paddingVertical: 7,
                        borderRadius: radius.pill,
                        borderWidth: 1,
                        borderColor: selected ? p.primary : p.divider,
                        backgroundColor: selected ? p.accentContainer : pressed ? p.surface3 : p.surface2,
                      })}
                    >
                      <Text style={{ fontSize: 13, fontFamily: fonts.bodySemi, color: selected ? p.accentText : p.ink }}>
                        {preset.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              {activePreset?.summary ? (
                <Text style={{ color: p.faint, fontSize: 12, lineHeight: 17 }}>{activePreset.summary}</Text>
              ) : null}
            </View>
          ) : null}

          <View style={{ flexDirection: "row", gap: space.md }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: p.muted, fontSize: 12.5, fontFamily: fonts.bodySemi }}>助理名字</Text>
              <TextInput
                mode="outlined"
                dense
                value={name}
                onChangeText={(v) => setDraft((prev) => ({ ...prev, name: v }))}
                placeholder="爱弥斯"
                maxLength={40}
              />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: p.muted, fontSize: 12.5, fontFamily: fonts.bodySemi }}>对你的称呼</Text>
              <TextInput
                mode="outlined"
                dense
                value={userCall}
                onChangeText={(v) => setDraft((prev) => ({ ...prev, userCall: v }))}
                placeholder="例如：哥哥"
                maxLength={24}
              />
            </View>
          </View>

          <View style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: p.muted, fontSize: 12.5, fontFamily: fonts.bodySemi }}>人设与相处细节</Text>
              <Text style={{ color: personaLen > 5700 ? p.error : p.faint, fontSize: 11.5 }}>{personaLen} / 6000</Text>
            </View>
            <TextInput
              mode="outlined"
              multiline
              numberOfLines={6}
              value={personaText}
              onChangeText={(t) =>
                setDraft((prev) => ({
                  ...prev,
                  personaText: t,
                  ...(presetId !== "custom" ? { presetId: "custom" } : {}),
                }))
              }
              placeholder="描述她的性格、背景羁绊和说话风格"
              style={{ minHeight: 120 }}
            />
          </View>

          <Divider />

          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: p.ink, fontSize: 15, fontFamily: fonts.bodySemi }}>对话中自动记住生活与习惯</Text>
              <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 17 }}>
                {autoMemory
                  ? "聊到作息、饮食忌口、重要的人、日程时自动记入记忆库；相同槽位新事实会自动覆盖旧事实"
                  : "仅在你明确说「记住 / 别忘了」或手动新增时保存"}
              </Text>
            </View>
            <Switch value={autoMemory} onValueChange={(v) => setDraft((prev) => ({ ...prev, autoMemory: v }))} color={p.primary} />
          </View>

          <Button
            mode="contained"
            loading={savingProfile}
            disabled={savingProfile}
            onPress={() => void onSaveProfile()}
            buttonColor={profileDirty ? p.primary : p.surface3}
            textColor={profileDirty ? p.onPrimary : p.muted}
          >
            {profileDirty ? "保存人设更改到服务器" : "人设已与服务器同步"}
          </Button>
        </Card>

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.xs }}>
          <SectionHeader title={`服务器长期记忆库（${memoriesTotal}）`} />
          <View style={{ flexDirection: "row", gap: space.xs }}>
            <Pressable
              onPress={() => void onExportMarkdown()}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: space.sm,
                paddingVertical: 5,
                borderRadius: radius.pill,
                backgroundColor: pressed ? p.surface3 : p.surface,
                borderWidth: 1,
                borderColor: p.divider,
              })}
            >
              <MaterialCommunityIcons name="content-copy" size={14} color={p.muted} />
              <Text style={{ color: p.muted, fontSize: 12 }}>导出</Text>
            </Pressable>
            <Pressable
              onPress={openNewMemory}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: space.md,
                paddingVertical: 5,
                borderRadius: radius.pill,
                backgroundColor: pressed ? p.primaryPressed : p.primary,
              })}
            >
              <MaterialCommunityIcons name="plus" size={15} color={p.onPrimary} />
              <Text style={{ color: p.onPrimary, fontSize: 12.5, fontFamily: fonts.bodyBold }}>新增记忆</Text>
            </Pressable>
          </View>
        </View>

        <Card style={{ padding: space.lg, gap: space.md }}>
          <TextInput
            mode="outlined"
            dense
            value={searchQ}
            onChangeText={setSearchQ}
            placeholder="搜索记忆关键词或槽位（如 咖啡 / coffee / 过敏）"
            left={<TextInput.Icon icon="magnify" />}
            right={searchQ ? <TextInput.Icon icon="close" onPress={() => setSearchQ("")} /> : undefined}
          />

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs }}>
            <Pressable
              onPress={() => setSelectedCat("all")}
              style={{
                paddingHorizontal: space.md,
                paddingVertical: 6,
                borderRadius: radius.pill,
                backgroundColor: selectedCat === "all" ? p.accentContainer : p.surface2,
                borderWidth: 1,
                borderColor: selectedCat === "all" ? p.primary : p.divider,
              }}
            >
              <Text style={{ fontSize: 12.5, color: selectedCat === "all" ? p.accentText : p.muted, fontFamily: fonts.bodySemi }}>
                全部
              </Text>
            </Pressable>
            {MEMORY_CATEGORIES.map((c) => {
              const active = selectedCat === c.id;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => setSelectedCat(c.id)}
                  style={{
                    paddingHorizontal: space.md,
                    paddingVertical: 6,
                    borderRadius: radius.pill,
                    backgroundColor: active ? p.accentContainer : p.surface2,
                    borderWidth: 1,
                    borderColor: active ? p.primary : p.divider,
                  }}
                >
                  <Text style={{ fontSize: 12.5, color: active ? p.accentText : p.muted, fontFamily: fonts.bodySemi }}>
                    {c.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {memories.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: space.xl, gap: space.xs }}>
              <MaterialCommunityIcons name="book-open-outline" size={28} color={p.faint} />
              <Text style={{ color: p.muted, fontSize: 14 }}>
                {searchQ || selectedCat !== "all" ? "没有符合筛选条件的记忆" : "记忆库还是空的"}
              </Text>
              <Text style={{ color: p.faint, fontSize: 12.5, textAlign: "center", lineHeight: 18 }}>
                可以直接聊天对爱弥斯说「记住我喝冰美式不加糖」，也可以点右上角“新增记忆”预先帮她记下重要信息。
              </Text>
            </View>
          ) : (
            <View style={{ gap: space.sm }}>
              {memories.map((m, idx) => {
                const meta = categoryMeta(m.category);
                const core = !!m.pinned || m.importance === 3;
                return (
                  <View key={m.id}>
                    {idx > 0 ? <Divider style={{ marginBottom: space.sm }} /> : null}
                    <View style={{ gap: 6 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                        <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: p.skyContainer }}>
                          <Text style={{ fontSize: 11.5, color: p.skyText, fontFamily: fonts.bodySemi }}>{meta.label}</Text>
                        </View>
                        {core ? (
                          <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: p.accentContainer }}>
                            <Text style={{ fontSize: 11.5, color: p.accentText, fontFamily: fonts.bodySemi }}>
                              {m.pinned ? "置顶永驻" : "核心"}
                            </Text>
                          </View>
                        ) : null}
                        {m.slotKey ? (
                          <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: p.surface3 }}>
                            <Text style={{ fontSize: 11, color: p.muted, fontFamily: fonts.mono }}>{m.slotKey}</Text>
                          </View>
                        ) : null}
                        <Text style={{ color: p.faint, fontSize: 11.5, marginLeft: "auto" }}>
                          {m.source === "assistant" ? "对话捕获" : "手动"} · {shortDate(m.updatedAt)}
                        </Text>
                      </View>

                      <Text style={{ color: p.ink, fontSize: 14.5, lineHeight: 21 }}>{m.content}</Text>

                      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
                        <Pressable
                          onPress={() => void togglePin(m)}
                          style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 3, paddingHorizontal: 8 }}
                        >
                          <MaterialCommunityIcons name={m.pinned ? "pin" : "pin-outline"} size={15} color={m.pinned ? p.accentText : p.faint} />
                          <Text style={{ fontSize: 12, color: m.pinned ? p.accentText : p.muted }}>{m.pinned ? "取消置顶" : "置顶"}</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => openEditMemory(m)}
                          style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 3, paddingHorizontal: 8 }}
                        >
                          <MaterialCommunityIcons name="pencil-outline" size={15} color={p.muted} />
                          <Text style={{ fontSize: 12, color: p.muted }}>编辑</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => void removeMemory(m)}
                          style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 3, paddingHorizontal: 8 }}
                        >
                          <MaterialCommunityIcons name="trash-can-outline" size={15} color={p.error} />
                          <Text style={{ fontSize: 12, color: p.error }}>删除</Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {memoriesTotal > 0 ? (
            <>
              <Divider />
              <Button mode="text" textColor={p.error} onPress={() => setClearConfirm(true)}>
                清空全部记忆（不影响人设）
              </Button>
            </>
          ) : null}
        </Card>
      </ScrollView>

      <Portal>
        <Dialog visible={memOpen} onDismiss={() => setMemOpen(false)} style={{ backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.bodyBold }}>{editingMem ? "编辑记忆" : "新增服务器记忆"}</Dialog.Title>
          <Dialog.Content style={{ gap: space.md }}>
            <View style={{ gap: 6 }}>
              <Text style={{ color: p.muted, fontSize: 12.5 }}>分类</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {MEMORY_CATEGORIES.map((c) => {
                  const active = memCat === c.id;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => setMemCat(c.id)}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: radius.pill,
                        backgroundColor: active ? p.accentContainer : p.surface2,
                        borderWidth: 1,
                        borderColor: active ? p.primary : p.divider,
                      }}
                    >
                      <Text style={{ fontSize: 12, color: active ? p.accentText : p.muted, fontFamily: fonts.bodySemi }}>{c.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <TextInput
              mode="outlined"
              label="事实内容"
              multiline
              numberOfLines={3}
              value={memContent}
              onChangeText={setMemContent}
              placeholder="例如：喝咖啡喜欢冰美式不加糖"
              maxLength={400}
            />

            <TextInput
              mode="outlined"
              dense
              label="覆盖槽位（可选，英文/拼音）"
              value={memSlot}
              onChangeText={setMemSlot}
              placeholder="如 coffee_pref / sleep_time，同槽位会自动新覆盖旧"
              autoCapitalize="none"
            />

            <View style={{ gap: 6 }}>
              <Text style={{ color: p.muted, fontSize: 12.5 }}>重要度</Text>
              <View style={{ flexDirection: "row", gap: space.sm }}>
                {([
                  [3, "核心档案"],
                  [2, "重要长期"],
                  [1, "日常琐事"],
                ] as const).map(([val, label]) => {
                  const active = memImportance === val;
                  return (
                    <Pressable
                      key={val}
                      onPress={() => setMemImportance(val)}
                      style={{
                        flex: 1,
                        alignItems: "center",
                        paddingVertical: 7,
                        borderRadius: radius.sm,
                        backgroundColor: active ? p.accentContainer : p.surface2,
                        borderWidth: 1,
                        borderColor: active ? p.primary : p.divider,
                      }}
                    >
                      <Text style={{ fontSize: 12.5, color: active ? p.accentText : p.muted, fontFamily: fonts.bodySemi }}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ color: p.ink, fontSize: 14 }}>置顶永驻（始终带入每次对话和通话）</Text>
              <Switch value={memPinned} onValueChange={setMemPinned} color={p.primary} />
            </View>

            {!editingMem ? (
              <TextInput
                mode="outlined"
                dense
                keyboardType="numeric"
                label="临时有效天数（可选）"
                value={memTtlDays}
                onChangeText={setMemTtlDays}
                placeholder="例如填 7 代表 7 天后自动过期；长期留空"
              />
            ) : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setMemOpen(false)}>取消</Button>
            <Button loading={savingMem} disabled={savingMem} onPress={() => void onSaveMemory()}>
              保存
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={clearConfirm} onDismiss={() => setClearConfirm(false)} style={{ backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.bodyBold }}>清空全部记忆？</Dialog.Title>
          <Dialog.Content>
            <Text style={{ color: p.muted, lineHeight: 20 }}>
              会删除服务器上的全部 {memoriesTotal} 条长期记忆（人设名字和「{userCall || "你"}」的称呼会保留）。
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setClearConfirm(false)}>取消</Button>
            <Button textColor={p.error} onPress={() => void onClearAll()}>
              确认清空
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={2600} wrapperStyle={{ bottom: 24 }}>
          {toast}
        </Snackbar>
      </Portal>
    </PageBackground>
  );
}
