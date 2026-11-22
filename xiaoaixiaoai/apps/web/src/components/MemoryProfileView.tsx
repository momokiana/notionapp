import React, { useEffect, useState } from "react";
import {
  MEMORY_CATEGORIES,
  type AssistantMemoryItem,
  type AssistantPersonaConfig,
  type MemoryCategory,
  type PersonaPresetSummary,
} from "@xiaoaixiaoai/protocol";
import { BookHeart, Download, Plus, RotateCcw, Save, Search, Sparkles, Trash2 } from "lucide-react";

interface Props {
  profile: AssistantPersonaConfig | null;
  presets: PersonaPresetSummary[];
  memories: AssistantMemoryItem[];
  onRefreshMemories: (q?: string) => Promise<void>;
  onAddMemory: (input: { category: MemoryCategory; content: string; pinned?: boolean }) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
  onExportMemories: () => Promise<string>;
  onSaveProfile: (patch: {
    name?: string;
    userCall?: string;
    personaText?: string;
    presetId?: string;
    autoMemory?: boolean;
  }) => Promise<void>;
  onToast: (msg: string) => void;
}

export function MemoryProfileView({
  profile,
  presets,
  memories,
  onRefreshMemories,
  onAddMemory,
  onDeleteMemory,
  onExportMemories,
  onSaveProfile,
  onToast,
}: Props) {
  const safePresets = Array.isArray(presets) ? presets : [];
  const safeMemories = Array.isArray(memories) ? memories : [];

  const [name, setName] = useState(profile?.name ?? "爱弥斯");
  const [userCall, setUserCall] = useState(profile?.userCall ?? "");
  const [personaText, setPersonaText] = useState(profile?.personaText ?? "");
  const [autoMemory, setAutoMemory] = useState(profile?.autoMemory ?? true);
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<MemoryCategory>("note");
  const [newContent, setNewContent] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setName(profile.name ?? "爱弥斯");
    setUserCall(profile.userCall ?? "");
    setPersonaText(profile.personaText ?? "");
    setAutoMemory(profile.autoMemory ?? true);
  }, [profile]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveProfile({ name: name.trim(), userCall: userCall.trim(), personaText, autoMemory });
      onToast("人设配置已保存并同步到所有设备");
    } catch (err) {
      onToast(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleApplyPreset = async (preset: PersonaPresetSummary) => {
    setSaving(true);
    try {
      await onSaveProfile({
        presetId: preset.id,
        userCall: preset.userCall,
        personaText: preset.personaText,
      });
      onToast(`已切换人设模板：${preset.label}`);
    } catch (err) {
      onToast(`切换模板失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefault = async () => {
    const def = safePresets.find((p) => p.id === "wuthering_aemeath") ?? safePresets[0];
    if (!def) {
      onToast("暂未加载默认模板，请稍后重试");
      return;
    }
    setSaving(true);
    try {
      await onSaveProfile({
        name: "爱弥斯",
        presetId: def.id,
        userCall: def.userCall,
        personaText: def.personaText,
        autoMemory: true,
      });
      onToast("已恢复默认爱弥斯人设");
    } catch (err) {
      onToast(`恢复默认失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContent.trim()) return;
    setAdding(true);
    try {
      await onAddMemory({ category: cat, content: newContent.trim() });
      setNewContent("");
      onToast("已写入长期记忆");
    } catch (err) {
      onToast(`写入失败：${(err as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  const handleSearch = async () => {
    try {
      await onRefreshMemories(query.trim() || undefined);
    } catch (err) {
      onToast(`搜索失败：${(err as Error).message}`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await onDeleteMemory(id);
      onToast("已删除该条记忆");
    } catch (err) {
      onToast(`删除失败：${(err as Error).message}`);
    }
  };

  const handleExport = async () => {
    try {
      const md = await onExportMemories();
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `xiaoaixiaoai-memories-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
      onToast("已导出 Markdown 记忆文件");
    } catch (err) {
      onToast(`导出失败：${(err as Error).message}`);
    }
  };

  return (
    <div className="page-scroll">
      <div className="dashboard-grid" style={{ alignItems: "start" }}>
        {/* Persona editor */}
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
              <Sparkles size={16} style={{ color: "var(--accent-text)" }} /> 人设与称呼设置
            </h3>
            <button type="button" className="mini-btn" disabled={saving} onClick={() => void handleResetDefault()}>
              <RotateCcw size={12} /> 恢复默认
            </button>
          </div>

          {safePresets.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {safePresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={saving}
                  className={`chip-btn ${profile?.presetId === p.id ? "active" : ""}`}
                  onClick={() => void handleApplyPreset(p)}
                  title={p.summary}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="field">
              <label>助手名字</label>
              <input className="search-input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label>她怎么称呼你</label>
              <input className="search-input" value={userCall} onChange={(e) => setUserCall(e.target.value)} placeholder="例如：哥哥" />
            </div>
          </div>

          <div className="field">
            <label style={{ display: "flex", justifyContent: "space-between" }}>
              <span>人设提示词</span>
              <span>{personaText.length} / 8000</span>
            </label>
            <textarea
              className="search-input"
              rows={10}
              maxLength={8000}
              value={personaText}
              onChange={(e) => setPersonaText(e.target.value)}
              style={{ resize: "vertical", lineHeight: 1.55 }}
            />
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 14, cursor: "pointer" }}>
            <input type="checkbox" checked={autoMemory} onChange={(e) => setAutoMemory(e.target.checked)} />
            允许对话与语音通话时自动记住长期个人习惯与事实
          </label>

          <button type="button" className="icon-btn primary" disabled={saving} onClick={() => void handleSave()}>
            <Save size={14} /> {saving ? "保存中…" : "保存人设配置"}
          </button>
        </div>

        {/* Memory bank */}
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
              <BookHeart size={16} style={{ color: "var(--accent-text)" }} /> 长期记忆库 ({safeMemories.length})
            </h3>
            <button type="button" className="mini-btn" onClick={() => void handleExport()}>
              <Download size={12} /> 导出 Markdown
            </button>
          </div>

          <form onSubmit={handleAddMemory} style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <select className="search-input" style={{ width: 120 }} value={cat} onChange={(e) => setCat(e.target.value as MemoryCategory)}>
                {MEMORY_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                className="search-input"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="新增一条想让爱弥斯长期记住的事…"
              />
              <button type="submit" className="icon-btn primary" disabled={adding || !newContent.trim()}>
                <Plus size={14} />
              </button>
            </div>
          </form>

          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <input
              className="search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSearch();
              }}
              placeholder="搜索记忆关键词…"
            />
            <button type="button" className="icon-btn" onClick={() => void handleSearch()}>
              <Search size={14} />
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 520, overflowY: "auto" }}>
            {safeMemories.length === 0 && <div style={{ fontSize: 13, color: "var(--faint)" }}>暂无记忆条目</div>}
            {safeMemories.map((m) => {
              const catLabel = MEMORY_CATEGORIES.find((c) => c.id === m.category)?.label ?? m.category;
              return (
                <div key={m.id} style={{ padding: "9px 11px", borderRadius: 12, background: "var(--surface-2)", display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                      <span className="tag">{catLabel}</span>
                      {m.pinned && <span className="status-pill status-working">置顶</span>}
                    </div>
                    <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{m.content}</div>
                  </div>
                  <button
                    type="button"
                    className="mini-btn"
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => void handleDelete(m.id)}
                    title="删除记忆"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
