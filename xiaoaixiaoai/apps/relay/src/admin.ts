/**
 * GET /admin: a small control panel for whoever runs the relay. Plain HTML and
 * script, no build step. The admin token is typed once and kept in this tab's
 * sessionStorage; every request sends it as a Bearer header. Paths are relative
 * to wherever the page is served (the relay often sits under /pocket).
 */
export function adminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>小爱小爱 控制台</title>
<style>
  :root { --pink:#FF7EA8; --pink-dark:#EE5F8E; --pink-soft:#FFE3EC; --ink:#2B1B24; --muted:#8A7380; --bg:#FBF4FC; --card:#fff; --line:#F1DCE6; --warn:#B26A00; --warn-bg:#FFF3DC; --err:#B8336A; --err-bg:#FFE3EC; --ok:#2E7D5B; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px; background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:2; }
  header h1 { font-size:17px; margin:0; }
  header .dot { width:10px; height:10px; border-radius:50%; background:var(--pink); }
  header .spacer { flex:1; }
  main { max-width:1200px; margin:0 auto; padding:16px 20px 60px; display:grid; gap:16px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 16px; }
  section h2 { font-size:15px; margin:0 0 10px; display:flex; align-items:center; gap:8px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:10px; }
  .stat { background:var(--bg); border-radius:10px; padding:8px 12px; }
  .stat b { display:block; font-size:18px; }
  .stat span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-weight:600; color:var(--muted); font-size:12px; }
  td.msg { word-break:break-word; }
  td.time { white-space:nowrap; color:var(--muted); font-variant-numeric:tabular-nums; }
  tr.warn td { background:var(--warn-bg); }
  tr.error td { background:var(--err-bg); }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; background:var(--pink-soft); color:var(--err); }
  .pill.on { background:#DFF5EA; color:var(--ok); }
  .pill.off { background:#EEE; color:var(--muted); }
  button { font:inherit; border:0; border-radius:10px; padding:6px 12px; background:var(--pink); color:#fff; cursor:pointer; }
  button:hover { background:var(--pink-dark); }
  button.ghost { background:var(--pink-soft); color:var(--err); }
  input, select { font:inherit; border:1px solid var(--line); border-radius:10px; padding:5px 8px; background:#fff; color:var(--ink); }
  .filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:10px; }
  .muted { color:var(--muted); }
  .data { color:var(--muted); font-size:12px; }
  #login { max-width:420px; margin:12vh auto; text-align:center; }
  #login input { width:100%; margin:12px 0; }
  .error-line { color:var(--err); min-height:1.5em; }
  .scroll { max-height:60vh; overflow:auto; }
</style>
</head>
<body>
<div id="login" hidden>
  <section>
    <h2 style="justify-content:center"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:var(--pink);display:inline-block"></span>小爱小爱 控制台</h2>
    <p class="muted">输入服务器的管理员令牌（POCKET_ADMIN_TOKEN）。只保存在这个标签页里，关掉就清除。</p>
    <input id="token" type="password" autocomplete="off" placeholder="管理员令牌">
    <button id="enter">进入</button>
    <p class="error-line" id="loginError"></p>
  </section>
</div>
<div id="app" hidden>
<header>
  <span class="dot"></span><h1>小爱小爱 控制台</h1>
  <span class="muted" id="health"></span>
  <span class="spacer"></span>
  <button class="ghost" id="refresh">刷新</button>
  <button class="ghost" id="logout">退出</button>
</header>
<main>
  <section>
    <h2>概况</h2>
    <div class="stats" id="stats"></div>
  </section>
  <section>
    <h2>设备</h2>
    <div class="scroll"><table id="devices"><thead><tr><th>名字</th><th>类型</th><th>状态</th><th>最后在线</th><th>版本</th><th>平台</th><th>id</th><th></th></tr></thead><tbody></tbody></table></div>
  </section>
  <section>
    <h2>日志 <span class="muted" id="logCount"></span></h2>
    <div class="filters">
      <select id="since"><option value="15m">15 分钟</option><option value="1h" selected>1 小时</option><option value="6h">6 小时</option><option value="1d">1 天</option><option value="7d">7 天</option><option value="14d">14 天</option></select>
      <select id="device"><option value="">所有设备</option></select>
      <select id="source"><option value="">所有来源</option><option value="relay">服务器</option><option value="host">电脑</option><option value="viewer">手机</option></select>
      <input id="kind" placeholder="类别，如 assistant、action、rpc" size="22">
      <select id="level"><option value="">所有级别</option><option value="info">info 以上</option><option value="warn">warn 以上</option><option value="error">只看 error</option></select>
      <input id="text" placeholder="包含文字" size="16">
      <select id="limit"><option>100</option><option selected>300</option><option>1000</option></select>
      <button id="search">查询</button>
      <label class="muted"><input type="checkbox" id="follow"> 跟随新日志</label>
    </div>
    <div class="scroll" id="logBox"><table id="logs"><thead><tr><th>时间</th><th>级别</th><th>来源</th><th>类别</th><th>内容</th></tr></thead><tbody></tbody></table></div>
  </section>
  <section>
    <h2>助理最近的操作</h2>
    <p class="muted" id="confirmLine"></p>
    <div class="scroll"><table id="actions"><thead><tr><th>时间</th><th>类型</th><th>状态</th><th>内容</th><th>结果</th></tr></thead><tbody></tbody></table></div>
  </section>
</main>
</div>
<script>
(() => {
  const KEY = "xiaoaixiaoai-admin";
  const base = location.pathname.replace(/\\/admin\\/?$/, "");
  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem(KEY) || "";
  let lastId = 0;
  let followTimer = null;
  let names = {};

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const time = (t) => t ? new Date(t).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); if (s < 60) return s + " 秒前"; const m = Math.round(s / 60); if (m < 60) return m + " 分钟前"; const h = Math.round(m / 60); if (h < 48) return h + " 小时前"; return Math.round(h / 24) + " 天前"; };

  async function api(path, init = {}) {
    const res = await fetch(base + path, { ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin("令牌不对，或者已经换了"); throw new Error("unauthorized"); }
    if (!res.ok) throw new Error(body?.error?.message || ("HTTP " + res.status));
    return body;
  }

  function showLogin(msg) {
    sessionStorage.removeItem(KEY);
    token = "";
    $("app").hidden = true;
    $("login").hidden = false;
    $("loginError").textContent = msg || "";
    stopFollow();
  }

  async function enter() {
    token = $("token").value.trim();
    if (!token) return;
    try {
      await api("/v1/admin/overview");
      sessionStorage.setItem(KEY, token);
      $("token").value = "";
      $("login").hidden = true;
      $("app").hidden = false;
      await loadAll();
    } catch (e) {
      if (e.message !== "unauthorized") $("loginError").textContent = e.message;
    }
  }

  async function loadOverview() {
    const o = await api("/v1/admin/overview");
    const up = ago(o.startedAt).replace("前", "");
    $("health").textContent = "v" + o.version + " · 已运行 " + up;
    const stat = (v, l) => '<div class="stat"><b>' + esc(v) + "</b><span>" + esc(l) + "</span></div>";
    $("stats").innerHTML = [
      stat(o.online + " / " + o.devices, "在线设备 / 全部"),
      stat(o.agents, "agent（不含普通终端）"),
      stat(o.assistant.ready ? (o.assistant.models[0] || "已配置") : "没配置", "文字模型" + (o.assistant.endpoint ? "（" + o.assistant.endpoint + "）" : "")),
      stat(o.voice ? o.voice.model : "没开", "语音通话"),
      stat(o.assistant.confirm === "always" ? "先问" : "直接做", "助理动手前"),
      stat(o.last24h.warn + " / " + o.last24h.error, "24 小时 warn / error"),
    ].join("");
    $("confirmLine").innerHTML = "动手前要不要先问：<b>" + (o.assistant.confirm === "always" ? "先问（打字聊天里）" : "直接做") + '</b> <button class="ghost" id="flip">改成' + (o.assistant.confirm === "always" ? "直接做" : "先问") + "</button>";
    $("flip").onclick = async () => {
      await api("/v1/assistant/settings", { method: "POST", body: JSON.stringify({ confirm: o.assistant.confirm === "always" ? "never" : "always" }) });
      loadOverview();
    };
    const rows = (o.actions || []).map((a) =>
      "<tr class=\\"" + (a.state === "failed" ? "error" : a.state === "pending" ? "warn" : "") + "\\"><td class=\\"time\\">" + time(a.createdAt) + "</td><td>" + esc(a.kind) + "</td><td>" + esc(a.state) + '</td><td class="msg">' + esc(a.summary) + '</td><td class="msg">' + esc(a.result || "") + "</td></tr>");
    $("actions").querySelector("tbody").innerHTML = rows.join("") || '<tr><td colspan="5" class="muted">还没有操作</td></tr>';
  }

  async function loadDevices() {
    const { devices } = await api("/v1/devices");
    names = {};
    const sel = $("device");
    const keep = sel.value;
    sel.innerHTML = '<option value="">所有设备</option>';
    for (const d of devices) {
      names[d.id] = d.name;
      sel.insertAdjacentHTML("beforeend", '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>");
    }
    sel.value = keep;
    $("devices").querySelector("tbody").innerHTML = devices
      .map((d) =>
        "<tr><td>" + esc(d.name) + "</td><td>" + (d.kind === "host" ? "电脑" : "手机") + '</td><td><span class="pill ' + (d.online ? "on" : "off") + '">' + (d.online ? "在线" : "离线") + '</span></td><td class="time">' + (d.online ? "现在" : ago(d.lastSeenAt)) + "</td><td>" + esc(d.version || "") + "</td><td>" + esc(d.platform || "") + '</td><td class="muted">' + esc(d.id) + '</td><td><button class="ghost" data-revoke="' + esc(d.id) + '" data-name="' + esc(d.name) + '">吊销</button></td></tr>')
      .join("") || '<tr><td colspan="8" class="muted">还没有设备</td></tr>';
    for (const b of document.querySelectorAll("[data-revoke]")) {
      b.onclick = async () => {
        if (!confirm("吊销「" + b.dataset.name + "」？它会立刻断开，要重新配对才能再连。")) return;
        await api("/v1/devices/" + encodeURIComponent(b.dataset.revoke), { method: "DELETE" });
        loadDevices();
      };
    }
  }

  function query(after) {
    const q = new URLSearchParams();
    if (after) q.set("after", String(after));
    else q.set("since", $("since").value);
    for (const k of ["device", "source", "kind", "level", "text"]) if ($(k).value.trim()) q.set(k, $(k).value.trim());
    q.set("limit", after ? "500" : $("limit").value);
    return "/v1/logs?" + q.toString();
  }

  function row(e) {
    const who = e.source === "relay" ? "服务器" : (e.deviceName || names[e.device] || e.device || e.source);
    const data = e.data ? Object.entries(e.data).map(([k, v]) => k + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join("  ") : "";
    return '<tr class="' + esc(e.level) + '"><td class="time">' + time(e.ts) + "</td><td>" + esc(e.level) + "</td><td>" + esc(who) + "</td><td>" + esc(e.kind) + '</td><td class="msg">' + esc(e.msg) + (data ? '<div class="data">' + esc(data) + "</div>" : "") + "</td></tr>";
  }

  async function loadLogs() {
    const { entries } = await api(query());
    lastId = entries.length ? entries[entries.length - 1].id : lastId;
    // Newest on top.
    $("logs").querySelector("tbody").innerHTML = entries.slice().reverse().map(row).join("") || '<tr><td colspan="5" class="muted">这段时间没有日志</td></tr>';
    $("logCount").textContent = entries.length + " 条";
  }

  async function follow() {
    try {
      const { entries } = await api(query(lastId));
      if (!entries.length) return;
      lastId = entries[entries.length - 1].id;
      const body = $("logs").querySelector("tbody");
      if (body.querySelector("td[colspan]")) body.innerHTML = "";
      body.insertAdjacentHTML("afterbegin", entries.slice().reverse().map(row).join(""));
    } catch (e) {
      /* keep following */
    }
  }

  function stopFollow() {
    if (followTimer) clearInterval(followTimer);
    followTimer = null;
  }

  async function loadAll() {
    await Promise.all([loadOverview(), loadDevices()]);
    await loadLogs();
  }

  $("enter").onclick = enter;
  $("token").addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); });
  $("logout").onclick = () => showLogin("");
  $("refresh").onclick = () => loadAll();
  $("search").onclick = () => loadLogs();
  for (const id of ["since", "device", "source", "level", "limit"]) $(id).onchange = () => loadLogs();
  for (const id of ["kind", "text"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") loadLogs(); });
  $("follow").onchange = () => {
    stopFollow();
    if ($("follow").checked) followTimer = setInterval(follow, 4000);
  };
  setInterval(() => { if (token && !document.hidden) { loadOverview().catch(() => {}); } }, 30000);

  if (token) {
    $("app").hidden = false;
    loadAll().catch((e) => { if (e.message !== "unauthorized") $("health").textContent = e.message; });
  } else showLogin("");
})();
</script>
</body>
</html>`;
}
