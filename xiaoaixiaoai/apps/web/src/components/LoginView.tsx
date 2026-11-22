import React, { useEffect, useRef, useState } from "react";
import { parsePairInput, type JoinTicket } from "@xiaoaixiaoai/protocol";
import { KeyRound, Link2, Loader2, ShieldCheck, Smartphone } from "lucide-react";
import {
  claimJoin,
  detectDefaultServer,
  getHealth,
  normalizeServer,
  pairWithAdminToken,
  pairWithCode,
  requestJoin,
  type HealthInfo,
  type StoredAuth,
} from "../lib/api";

interface Props {
  onAuthed: (auth: StoredAuth) => void;
}

type Mode = "code" | "join" | "admin";

export function LoginView({ onAuthed }: Props) {
  const [server, setServer] = useState(() => detectDefaultServer() || "https://45.192.104.210:8443/xiaoaixiaoai");
  const [name, setName] = useState(() => `桌面浏览器 (${navigator.platform || "Desktop"})`.slice(0, 32));
  const [mode, setMode] = useState<Mode>("code");
  const [codeInput, setCodeInput] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [joinTicket, setJoinTicket] = useState<JoinTicket | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    const s = normalizeServer(server);
    if (!s) {
      setHealth(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      getHealth(s)
        .then((h) => {
          if (alive) setHealth(h);
        })
        .catch(() => {
          if (alive) setHealth(null);
        });
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [server]);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setJoinTicket(null);
  };

  const handlePairCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = parsePairInput(codeInput);
    const targetServer = normalizeServer(parsed?.server || server);
    const code = parsed?.code || codeInput.trim();
    if (!targetServer || !code) {
      setError("请填写中转站地址和配对码（或直接粘贴完整配对链接）");
      return;
    }
    setBusy(true);
    try {
      const res = await pairWithCode(targetServer, code, name);
      onAuthed({
        server: targetServer,
        token: res.token,
        deviceId: res.device.id,
        deviceName: res.device.name,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleAdminPair = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const targetServer = normalizeServer(server);
    if (!targetServer || !adminToken.trim()) {
      setError("请填写中转站地址和管理员 Token");
      return;
    }
    setBusy(true);
    try {
      const res = await pairWithAdminToken(targetServer, adminToken.trim(), name);
      onAuthed({
        server: targetServer,
        token: res.token,
        deviceId: res.device.id,
        deviceName: res.device.name,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleStartJoin = async () => {
    setError(null);
    stopPolling();
    const targetServer = normalizeServer(server);
    if (!targetServer) {
      setError("请先填写中转站地址");
      return;
    }
    setBusy(true);
    try {
      const ticket = await requestJoin(targetServer, name);
      setJoinTicket(ticket);
      pollRef.current = window.setInterval(async () => {
        try {
          const claim = await claimJoin(targetServer, ticket.id, ticket.secret);
          if (claim.status === "approved") {
            stopPolling();
            onAuthed({
              server: targetServer,
              token: claim.token,
              deviceId: claim.device.id,
              deviceName: claim.device.name,
            });
          } else if (claim.status === "denied") {
            stopPolling();
            setError("加入申请已被拒绝");
          }
        } catch (err) {
          stopPolling();
          setError((err as Error).message);
        }
      }, 2200);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
          <img src="./aimisi-avatar.jpg" alt="爱弥斯" style={{ width: 56, height: 56, borderRadius: 18, objectFit: "cover", border: "2px solid var(--primary)" }} />
          <div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>小爱小爱 · 桌面总控台</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
              {health ? (
                <span style={{ color: "var(--ok)", fontWeight: 600 }}>
                  已检测到中转站 v{health.version}（在线 {health.online}/{health.devices}）
                </span>
              ) : (
                "多电脑 Agent 总控 · 爱弥斯对话与实时语音通话"
              )}
            </div>
          </div>
        </div>

        <div className="nav-tabs" style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}>
          <button type="button" className={`nav-tab ${mode === "code" ? "active" : ""}`} style={{ flex: 1, justifyContent: "center" }} onClick={() => { stopPolling(); setMode("code"); setError(null); }}>
            <Link2 size={14} /> 配对码
          </button>
          <button type="button" className={`nav-tab ${mode === "join" ? "active" : ""}`} style={{ flex: 1, justifyContent: "center" }} onClick={() => { setMode("join"); setError(null); }}>
            <Smartphone size={14} /> 手机审批
          </button>
          <button type="button" className={`nav-tab ${mode === "admin" ? "active" : ""}`} style={{ flex: 1, justifyContent: "center" }} onClick={() => { stopPolling(); setMode("admin"); setError(null); }}>
            <ShieldCheck size={14} /> 管理员一键
          </button>
        </div>

        <div className="field">
          <label>中转站地址</label>
          <input className="search-input" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://45.192.104.210:8443/xiaoaixiaoai" />
        </div>

        <div className="field">
          <label>这台桌面端的名称</label>
          <input className="search-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Windows 桌面端" />
        </div>

        {mode === "code" && (
          <form onSubmit={handlePairCode}>
            <div className="field">
              <label>配对码或配对链接（手机 App「设置 → 添加新设备」里生成）</label>
              <input
                className="search-input"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="例如：STAR-4821 或直接粘贴 https://.../p/STAR-4821"
                autoFocus
              />
            </div>
            <button type="submit" className="icon-btn primary" disabled={busy} style={{ width: "100%", padding: "10px 14px", fontSize: 14 }}>
              {busy ? <Loader2 size={16} /> : <KeyRound size={16} />}
              {busy ? "配对中..." : "配对并进入桌面端"}
            </button>
          </form>
        )}

        {mode === "join" && (
          <div>
            {!joinTicket ? (
              <button type="button" className="icon-btn primary" disabled={busy} onClick={handleStartJoin} style={{ width: "100%", padding: "10px 14px", fontSize: 14 }}>
                {busy ? <Loader2 size={16} /> : <Smartphone size={16} />}
                发起加入申请（手机或管理后台一键批准）
              </button>
            ) : (
              <div className="card" style={{ padding: 14, background: "var(--surface-2)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>等待批准中…</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 8 }}>
                  打开手机端「设置 → 批准新设备」或访问下方链接批准：
                </div>
                <div style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12, padding: "8px 10px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--divider)", wordBreak: "break-all" }}>
                  {joinTicket.link}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button type="button" className="icon-btn" onClick={() => void navigator.clipboard.writeText(joinTicket.link)}>
                    复制审批链接
                  </button>
                  <button type="button" className="icon-btn danger" onClick={stopPolling}>
                    取消申请
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {mode === "admin" && (
          <form onSubmit={handleAdminPair}>
            <div className="field">
              <label>管理员 Token（与 /admin 控制台一致，仅本地换取一次 viewer 凭证，不保存）</label>
              <input
                type="password"
                className="search-input"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="粘贴 relay 管理员 Token"
                autoFocus
              />
            </div>
            <button type="submit" className="icon-btn primary" disabled={busy} style={{ width: "100%", padding: "10px 14px", fontSize: 14 }}>
              {busy ? <Loader2 size={16} /> : <ShieldCheck size={16} />}
              {busy ? "生成并配对中..." : "一键配对并登录"}
            </button>
          </form>
        )}

        {error && (
          <div style={{ marginTop: 12, padding: "9px 12px", borderRadius: 12, background: "var(--error-bg)", color: "var(--error)", fontSize: 12.5, fontWeight: 600 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
