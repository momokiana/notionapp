import React, { useEffect, useState } from "react";
import type { Device, LaunchOption, SpaceInfo } from "@xiaoaixiaoai/protocol";
import { Loader2, Plus, X } from "lucide-react";
import type { RelaySocket } from "../lib/relay-ws";

interface Props {
  hosts: Device[];
  socket: RelaySocket | null;
  onClose: () => void;
  onCreated: (agentKey: string) => void;
  onToast: (msg: string) => void;
}

export function NewSessionModal({ hosts, socket, onClose, onCreated, onToast }: Props) {
  const onlineHosts = hosts.filter((h) => h.kind === "host" && h.online);
  const [hostId, setHostId] = useState(onlineHosts[0]?.id ?? "");
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [spaces, setSpaces] = useState<SpaceInfo[]>([]);
  const [launchers, setLaunchers] = useState<LaunchOption[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [launcher, setLauncher] = useState("");
  const [space, setSpace] = useState("");
  const [folder, setFolder] = useState("");
  const [tabName, setTabName] = useState("");
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!socket || !hostId) return;
    let alive = true;
    setLoadingMeta(true);
    socket
      .rpc(hostId, "spaces.list", {})
      .then((res) => {
        if (!alive) return;
        setCanCreate(res.canCreate);
        setReason(res.reason);
        setSpaces(res.spaces);
        setLaunchers(res.launchers);
        setFolders(res.folders);
        setLauncher(res.launchers[0]?.id ?? "");
        setSpace(res.spaces[0]?.id ?? "");
        setFolder(res.folders[0] ?? "");
      })
      .catch((err) => {
        if (!alive) return;
        setCanCreate(false);
        setReason((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoadingMeta(false);
      });
    return () => {
      alive = false;
    };
  }, [socket, hostId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!socket || !hostId || !launcher) return;
    setSubmitting(true);
    try {
      const res = await socket.rpc(
        hostId,
        "agent.create",
        {
          launcher,
          ...(space ? { space } : {}),
          ...(folder.trim() ? { folder: folder.trim() } : {}),
          ...(tabName.trim() ? { tabName: tabName.trim() } : {}),
          ...(task.trim() ? { task: task.trim() } : {}),
        },
        65_000,
      );
      onToast(res.taskNote ? `已创建会话（${res.taskNote}）` : "已创建新 Agent 会话");
      onCreated(res.agent);
      onClose();
    } catch (err) {
      onToast(`创建失败：${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>新建 Agent 会话</h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {onlineHosts.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13.5 }}>当前没有在线的电脑端主机。</div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label>目标电脑</label>
              <select className="search-input" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                {onlineHosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({h.platform ?? "host"})
                  </option>
                ))}
              </select>
            </div>

            {loadingMeta ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", padding: "12px 0" }}>
                <Loader2 size={15} /> 正在查询可用启动器…
              </div>
            ) : !canCreate ? (
              <div style={{ padding: 10, borderRadius: 12, background: "var(--surface-2)", color: "var(--muted)", fontSize: 13 }}>
                {reason || "这台主机暂不支持远程创建新会话（例如只读主机）"}
              </div>
            ) : (
              <>
                <div className="field">
                  <label>Agent 类型</label>
                  <select className="search-input" value={launcher} onChange={(e) => setLauncher(e.target.value)}>
                    {launchers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>

                {spaces.length > 0 && (
                  <div className="field">
                    <label>空间</label>
                    <select className="search-input" value={space} onChange={(e) => setSpace(e.target.value)}>
                      <option value="">新建空间</option>
                      {spaces.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="field">
                  <label>工作目录</label>
                  <input
                    className="search-input"
                    list="folder-suggestions"
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder="留空则使用默认项目目录"
                  />
                  <datalist id="folder-suggestions">
                    {folders.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </div>

                <div className="field">
                  <label>会话名称（可选）</label>
                  <input className="search-input" value={tabName} onChange={(e) => setTabName(e.target.value)} placeholder="例如：修复构建问题" />
                </div>

                <div className="field">
                  <label>首条任务指令（可选）</label>
                  <textarea
                    className="search-input"
                    rows={3}
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                    placeholder="启动后立即交给它的任务…"
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
                  <button type="button" className="icon-btn" onClick={onClose}>
                    取消
                  </button>
                  <button type="submit" className="icon-btn primary" disabled={submitting}>
                    {submitting ? <Loader2 size={14} /> : <Plus size={14} />}
                    {submitting ? "创建中…" : "创建会话"}
                  </button>
                </div>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
