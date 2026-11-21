/**
 * GET /admin: unified tri-tier control workbench & AI diagnostics console for
 * whoever runs the relay. Plain HTML + inline CSS + inline script (CSP `self`,
 * zero build step, works cleanly under reverse-proxy subpaths such as /xiaoaixiaoai).
 */
import { LOGO_SVG } from "./logo.ts";

export function adminPage(): string {
  const logoData = `data:image/svg+xml;utf8,${encodeURIComponent(LOGO_SVG)}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>小爱小爱 工作台</title>
<style>
  :root {
    --pink:#F46898; --pink-dark:#DF4D80; --pink-soft:#FFE7F0; --pink-line:#F7C6D7;
    --ink:#2C1E26; --muted:#7F6A76; --bg:#FDF6FA; --sidebar:#FFFFFF; --card:#FFFFFF;
    --subcard:#FAF1F6; --line:#EFE0E8; --chip:#F3E8EE; --chip-ink:#5C4652;
    --warn:#B26400; --warn-bg:#FFF4DE; --err:#B82E63; --err-bg:#FFE3ED;
    --ok:#1D7A56; --ok-bg:#DFF6EA; --info:#5C4B9E; --info-bg:#EDE8FF;
    --shadow:0 6px 20px rgba(96, 40, 68, 0.05);
  }
  [data-theme="dark"] {
    --pink:#FF79A8; --pink-dark:#FF5B93; --pink-soft:rgba(255,121,168,0.16); --pink-line:rgba(255,121,168,0.38);
    --ink:#F4EAF0; --muted:#AA96A2; --bg:#161116; --sidebar:#1D161C; --card:#221A21;
    --subcard:#2B212A; --line:#352933; --chip:#312530; --chip-ink:#DECBD6;
    --warn:#FFB84D; --warn-bg:rgba(255,184,77,0.13); --err:#FF7AA8; --err-bg:rgba(255,100,150,0.16);
    --ok:#55D69E; --ok-bg:rgba(85,214,158,0.14); --info:#B3A2FF; --info-bg:rgba(179,162,255,0.14);
    --shadow:0 8px 24px rgba(0, 0, 0, 0.35);
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; font:14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--ink); }
  button, input, select, textarea { font:inherit; color:var(--ink); }
  button { border:0; border-radius:10px; padding:7px 13px; background:var(--pink); color:#fff; cursor:pointer; font-weight:500; transition:background .15s, opacity .15s; }
  button:hover { background:var(--pink-dark); }
  button:disabled { opacity:.55; cursor:default; }
  button.ghost { background:var(--subcard); color:var(--ink); border:1px solid var(--line); }
  button.ghost:hover { background:var(--pink-soft); border-color:var(--pink-line); color:var(--pink-dark); }
  button.sm { padding:4px 9px; font-size:12px; border-radius:8px; }
  input, select, textarea { border:1px solid var(--line); border-radius:10px; padding:6px 10px; background:var(--card); }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--pink-line); border-color:var(--pink); }
  .muted { color:var(--muted); }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }

  #login { max-width:420px; margin:11vh auto; padding:20px; }
  .login-card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:26px 24px; box-shadow:var(--shadow); text-align:center; }
  .login-card img { width:56px; height:56px; border-radius:16px; border:2px solid var(--pink-line); margin-bottom:8px; }
  .login-card input { width:100%; margin:12px 0; }
  .error-line { color:var(--err); min-height:1.4em; margin:8px 0 0; font-size:13px; }

  .shell { display:flex; min-height:100vh; }
  .side { width:240px; flex-shrink:0; background:var(--sidebar); border-right:1px solid var(--line); padding:16px 12px; display:flex; flex-direction:column; gap:14px; position:sticky; top:0; height:100vh; }
  .brand { display:flex; align-items:center; gap:10px; padding:4px 6px; }
  .brand img { width:38px; height:38px; border-radius:12px; border:1px solid var(--pink-line); object-fit:cover; }
  .brand b { display:block; font-size:15px; line-height:1.2; }
  .brand span { font-size:12px; color:var(--muted); }
  nav { display:flex; flex-direction:column; gap:4px; }
  .nav-btn { display:flex; align-items:center; justify-content:space-between; width:100%; text-align:left; background:transparent; color:var(--ink); padding:9px 12px; border-radius:11px; font-weight:500; }
  .nav-btn:hover { background:var(--subcard); color:var(--ink); }
  .nav-btn.active { background:var(--pink-soft); color:var(--pink-dark); }
  .nav-badge { font-size:11px; padding:1px 7px; border-radius:999px; background:var(--chip); color:var(--chip-ink); }
  .nav-btn.active .nav-badge { background:var(--pink); color:#fff; }
  .side-spacer { flex:1; }
  .guard-box { background:var(--subcard); border:1px solid var(--line); border-radius:13px; padding:10px 11px; display:flex; align-items:center; gap:9px; }
  .guard-box img { width:32px; height:32px; border-radius:50%; object-fit:cover; }
  .guard-box b { display:block; font-size:13px; }
  .guard-box span { font-size:11px; color:var(--muted); display:block; }
  .side-actions { display:flex; flex-direction:column; gap:6px; }

  .content { flex:1; min-width:0; display:flex; flex-direction:column; }
  .topbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:12px 20px; background:var(--sidebar); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:4; }
  .topbar-greet { font-size:15px; font-weight:600; margin-right:auto; }
  .topbar-greet small { font-weight:400; color:var(--muted); margin-left:8px; font-size:13px; }
  main { padding:18px 20px 64px; max-width:1360px; width:100%; margin:0 auto; display:grid; gap:16px; }
  .tab-view { display:grid; gap:14px; }

  .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:12px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:15px; padding:14px 16px; box-shadow:var(--shadow); cursor:pointer; transition:transform .12s; }
  .kpi:hover { transform:translateY(-1px); }
  .kpi.warn-tint { background:var(--err-bg); border-color:var(--pink-line); }
  .kpi.work-tint { background:var(--ok-bg); }
  .kpi.done-tint { background:var(--info-bg); }
  .kpi-head { display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--muted); margin-bottom:6px; }
  .kpi-val { font-size:26px; font-weight:700; line-height:1.15; }
  .kpi-sub { font-size:12px; color:var(--muted); margin-top:4px; display:flex; gap:6px; flex-wrap:wrap; align-items:center; }

  .card { background:var(--card); border:1px solid var(--line); border-radius:15px; padding:15px 17px; box-shadow:var(--shadow); }
  .card h2 { font-size:15px; margin:0 0 11px; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .row-wrap { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .pill { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; font-size:11.5px; font-weight:600; background:var(--chip); color:var(--chip-ink); white-space:nowrap; }
  .pill.on, .pill.working { background:var(--ok-bg); color:var(--ok); }
  .pill.blocked, .pill.err { background:var(--err-bg); color:var(--err); }
  .pill.warn { background:var(--warn-bg); color:var(--warn); }
  .pill.done { background:var(--info-bg); color:var(--info); }
  .pill.pink { background:var(--pink-soft); color:var(--pink-dark); }

  .agent-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(310px, 1fr)); gap:12px; }
  .agent-card { background:var(--subcard); border:1px solid var(--line); border-radius:14px; padding:13px 14px; display:flex; flex-direction:column; gap:8px; }
  .agent-top { display:flex; justify-content:space-between; gap:8px; align-items:flex-start; }
  .agent-title { font-weight:600; font-size:14px; word-break:break-word; }
  .agent-meta { font-size:12px; color:var(--muted); }
  .agent-preview { font-size:12.5px; color:var(--ink); opacity:.86; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:1.4em; word-break:break-word; }
  .ctx-bar { height:5px; background:var(--line); border-radius:999px; overflow:hidden; margin-top:2px; }
  .ctx-fill { height:100%; background:var(--pink); border-radius:999px; }

  .chips-bar { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  .chip-btn { padding:4px 10px; border-radius:999px; font-size:12px; background:var(--subcard); color:var(--chip-ink); border:1px solid var(--line); }
  .chip-btn.active { background:var(--pink-soft); color:var(--pink-dark); border-color:var(--pink-line); }

  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:7px 9px; border-bottom:1px solid var(--line); vertical-align:top; font-size:13px; }
  th { font-weight:600; color:var(--muted); font-size:12px; position:sticky; top:0; background:var(--card); z-index:1; }
  td.time { white-space:nowrap; color:var(--muted); font-variant-numeric:tabular-nums; font-size:12px; }
  td.msg { word-break:break-word; }
  tr.warn td { background:var(--warn-bg); }
  tr.error td { background:var(--err-bg); }
  tr.debug td { opacity:.82; }
  .data-chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
  .data-chip { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; padding:1px 6px; border-radius:6px; background:var(--chip); color:var(--chip-ink); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .scroll { max-height:62vh; overflow:auto; border:1px solid var(--line); border-radius:11px; }

  .split-2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:14px; }
  .field-grid { display:grid; gap:10px; }
  .field-grid label { display:grid; gap:4px; font-size:12.5px; color:var(--muted); }
  .probe-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 11px; border:1px solid var(--line); border-radius:11px; background:var(--subcard); }

  .modal-bg { position:fixed; inset:0; background:rgba(16,10,15,0.52); display:flex; align-items:center; justify-content:center; padding:18px; z-index:50; }
  .modal-bg[hidden] { display:none; }
  .modal { background:var(--card); border:1px solid var(--line); border-radius:16px; width:min(900px, 100%); max-height:86vh; display:flex; flex-direction:column; padding:16px 18px; box-shadow:var(--shadow); gap:10px; }
  .modal pre { margin:0; padding:12px; background:var(--subcard); border:1px solid var(--line); border-radius:10px; overflow:auto; max-height:56vh; font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space:pre-wrap; word-break:break-word; }

  @media (max-width: 860px) {
    .shell { flex-direction:column; }
    .side { width:100%; height:auto; position:static; flex-direction:row; flex-wrap:wrap; align-items:center; padding:10px 12px; }
    nav { flex-direction:row; flex-wrap:wrap; }
    .guard-box, .side-spacer { display:none; }
  }
</style>
</head>
<body>
<div id="login" hidden>
  <div class="login-card">
    <img src="${logoData}" alt="小爱小爱">
    <h2 style="margin:0 0 6px">小爱小爱 控制台</h2>
    <p class="muted" style="margin:0">输入中转服管理员令牌（POCKET_ADMIN_TOKEN），仅缓存在当前标签页。</p>
    <input id="token" type="password" autocomplete="off" placeholder="管理员令牌">
    <button id="enter" style="width:100%">进入工作台</button>
    <p class="error-line" id="loginError"></p>
  </div>
</div>

<div id="app" hidden>
  <div class="shell">
    <aside class="side">
      <div class="brand">
        <img src="${logoData}" alt="爱弥斯">
        <div>
          <b>小爱小爱</b>
          <span id="sideVer">加载中…</span>
        </div>
      </div>
      <nav id="nav">
        <button class="nav-btn active" data-tab="overview"><span>概览与智能体</span><span class="nav-badge" id="nb-agents">0</span></button>
        <button class="nav-btn" data-tab="devices"><span>设备与配对</span><span class="nav-badge" id="nb-devices">0/0</span></button>
        <button class="nav-btn" data-tab="models"><span>模型与语音</span><span class="nav-badge" id="nb-voice">-</span></button>
        <button class="nav-btn" data-tab="data"><span>人设记忆与账单</span><span class="nav-badge" id="nb-mem">0</span></button>
        <button class="nav-btn" data-tab="logs"><span>实时日志与诊断</span><span class="nav-badge" id="nb-warn">0</span></button>
      </nav>
      <div class="side-spacer"></div>
      <div class="guard-box">
        <img src="${logoData}" alt="值守">
        <div>
          <b id="guardName">爱弥斯 在岗</b>
          <span id="guardSub">通知通道: 0 · 语音: -</span>
        </div>
      </div>
      <div class="side-actions">
        <button class="ghost sm" id="themeBtn">切换暗夜模式</button>
        <button class="ghost sm" id="logout">退出登录</button>
      </div>
    </aside>

    <div class="content">
      <header class="topbar">
        <div class="topbar-greet" id="greetTitle">小爱小爱工作台 <small id="greetSub"></small></div>
        <button class="ghost sm" id="quickBtn">快速跳转 (Ctrl+K)</button>
        <button class="sm" id="exportTopBtn">导出 AI 排障包</button>
        <button class="ghost sm" id="refreshBtn">刷新</button>
      </header>

      <main>
        <section id="view-overview" class="tab-view">
          <div class="kpi-grid" id="kpis"></div>
          <div class="card">
            <h2>
              <span>在线 Agent 看板 <span class="muted" id="agentBoardCount"></span></span>
              <span class="row-wrap">
                <input id="agentSearch" placeholder="筛选标题/目录/电脑" size="18">
                <select id="agentDeviceFilter"><option value="">全部电脑</option></select>
                <label class="muted" style="font-size:12.5px"><input type="checkbox" id="showShells"> 显示普通终端</label>
              </span>
            </h2>
            <div class="chips-bar" id="boardChips">
              <button class="chip-btn active" data-bstat="">全部</button>
              <button class="chip-btn" data-bstat="blocked">需要你</button>
              <button class="chip-btn" data-bstat="working">工作中</button>
              <button class="chip-btn" data-bstat="done">已完成</button>
              <button class="chip-btn" data-bstat="idle">空闲</button>
            </div>
            <div class="agent-grid" id="agentGrid"></div>
          </div>
        </section>

        <section id="view-devices" class="tab-view" hidden>
          <div class="card">
            <h2><span>生成配对码</span><span class="muted" style="font-size:12px">可用于加入新电脑或手机</span></h2>
            <div class="row-wrap">
              <select id="pairKind"><option value="">不限类型</option><option value="viewer">手机</option><option value="host">电脑</option></select>
              <button id="genPairBtn">生成一次性配对码</button>
              <span id="pairResult" class="mono"></span>
            </div>
          </div>
          <div class="card">
            <h2><span>已配对设备</span></h2>
            <div class="scroll"><table id="devices"><thead><tr><th>名字</th><th>类型</th><th>状态</th><th>最后在线</th><th>版本</th><th>平台</th><th>能力来源</th><th>操作</th></tr></thead><tbody></tbody></table></div>
          </div>
        </section>

        <section id="view-models" class="tab-view" hidden>
          <div class="split-2">
            <div class="card">
              <h2><span>文字模型链与连通测速</span><button class="sm" id="probeBtn">一键测速</button></h2>
              <div id="modelList" style="display:grid;gap:8px"></div>
            </div>
            <div class="card">
              <h2><span>实时语音与助理策略</span></h2>
              <div id="voicePanel" style="display:grid;gap:10px"></div>
            </div>
          </div>
          <div class="card">
            <h2><span>助理最近操作（30 条）</span></h2>
            <div class="scroll"><table id="actions"><thead><tr><th>时间</th><th>类型</th><th>状态</th><th>内容</th><th>结果</th></tr></thead><tbody></tbody></table></div>
          </div>
        </section>

        <section id="view-data" class="tab-view" hidden>
          <div class="split-2">
            <div class="card">
              <h2><span>助理人设配置</span><span class="muted" id="profileHint" style="font-size:12px"></span></h2>
              <div class="field-grid">
                <label>助理名字<input id="pfName" maxlength="20"></label>
                <label>对你的称呼<input id="pfCall" maxlength="20" placeholder="比如：哥哥"></label>
                <label>人设补充说明<textarea id="pfPersona" rows="4"></textarea></label>
                <div class="row-wrap"><button id="saveProfileBtn">保存人设</button><span id="profileMsg" class="muted" style="font-size:12px"></span></div>
              </div>
            </div>
            <div class="card">
              <h2><span>长期记忆库 <span class="muted" id="memTotal"></span></span><span class="row-wrap"><input id="memQuery" placeholder="搜索记忆" size="14"><button class="ghost sm" id="memSearchBtn">搜索</button><button class="ghost sm" id="memExportBtn">导出 Markdown</button></span></h2>
              <div class="scroll" style="max-height:280px"><table id="memTable"><thead><tr><th>分类</th><th>记忆内容</th><th>更新</th></tr></thead><tbody></tbody></table></div>
            </div>
          </div>
          <div class="card">
            <h2><span>微信账单与抓捕核查</span><span class="muted" id="ledgerMeta"></span></h2>
            <div class="scroll" style="max-height:300px"><table id="ledgerTable"><thead><tr><th>时间</th><th>方向</th><th>金额</th><th>标题</th><th>来源</th><th>备注</th></tr></thead><tbody></tbody></table></div>
          </div>
        </section>

        <section id="view-logs" class="tab-view" hidden>
          <div class="card">
            <h2>
              <span>三端实时运行日志 <span class="muted" id="logCount"></span></span>
              <span class="row-wrap">
                <label class="muted" style="font-size:12.5px"><input type="checkbox" id="follow"> 跟随新日志</label>
                <button class="sm" id="exportLogBtn">导出当前条件 AI 排障包</button>
              </span>
            </h2>
            <div class="row-wrap" style="margin-bottom:10px">
              <select id="since"><option value="15m">最近 15 分钟</option><option value="1h" selected>最近 1 小时</option><option value="6h">最近 6 小时</option><option value="1d">最近 1 天</option><option value="7d">最近 7 天</option><option value="14d">最近 14 天</option></select>
              <select id="device"><option value="">所有设备</option></select>
              <select id="source"><option value="">所有来源</option><option value="relay">服务器 relay</option><option value="host">电脑 host</option><option value="viewer">手机 viewer</option></select>
              <select id="level"><option value="">所有级别（含 debug）</option><option value="info">info 及以上</option><option value="warn">warn 及以上</option><option value="error">只看 error</option></select>
              <input id="kind" placeholder="类别如 wake/runtime" size="16">
              <input id="text" placeholder="关键词/agent key" size="18">
              <select id="limit"><option>100</option><option selected>300</option><option>500</option><option>1000</option></select>
              <button id="search">查询</button>
            </div>
            <div class="chips-bar" id="kindChips">
              <button class="chip-btn active" data-k="">全部</button>
              <button class="chip-btn" data-k="notice">notice</button>
              <button class="chip-btn" data-k="wake">wake</button>
              <button class="chip-btn" data-k="assistant">assistant</button>
              <button class="chip-btn" data-k="rpc">rpc</button>
              <button class="chip-btn" data-k="runtime">runtime</button>
              <button class="chip-btn" data-k="ledger">ledger</button>
              <button class="chip-btn" data-k="voice">voice</button>
              <button class="chip-btn" data-k="model">model</button>
              <button class="chip-btn" data-k="notify">notify</button>
              <button class="chip-btn" data-k="app">app</button>
              <button class="chip-btn" data-k="js">js</button>
            </div>
            <div class="scroll" id="logBox"><table id="logs"><thead><tr><th>时间</th><th>级别</th><th>来源</th><th>类别</th><th>内容与上下文</th></tr></thead><tbody></tbody></table></div>
          </div>
        </section>
      </main>
    </div>
  </div>
</div>

<div class="modal-bg" id="diagModal" hidden>
  <div class="modal">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <b id="diagTitle">AI 排障诊断包</b>
      <span class="row-wrap">
        <button class="ghost sm" id="diagFormatBtn">切换 JSON / Markdown</button>
        <button class="sm" id="diagCopyBtn">一键复制</button>
        <button class="ghost sm" id="diagDownloadBtn">下载文件</button>
        <button class="ghost sm" id="diagCloseBtn">关闭</button>
      </span>
    </div>
    <span class="muted" id="diagMeta" style="font-size:12px"></span>
    <pre id="diagBody"></pre>
  </div>
</div>

<div class="modal-bg" id="quickModal" hidden>
  <div class="modal" style="width:min(540px,100%)">
    <div style="display:flex;gap:8px;align-items:center">
      <input id="quickInput" placeholder="输入页签或 Agent 名称 / 目录跳转…" style="flex:1">
      <button class="ghost sm" id="quickCloseBtn">Esc</button>
    </div>
    <div id="quickList" style="display:grid;gap:6px;max-height:50vh;overflow:auto"></div>
  </div>
</div>

<script>
(() => {
  const KEY = "xiaoaixiaoai-admin";
  const THEME_KEY = "xiaoaixiaoai-admin-theme";
  const base = location.pathname.replace(/\\/admin\\/?$/, "");
  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem(KEY) || "";
  let activeTab = "overview";
  let boardStatusFilter = "";
  let lastId = 0;
  let followTimer = null;
  let pollTimer = null;
  let lastOverview = null;
  let lastAgents = [];
  let names = {};
  let diagState = { format: "markdown", agent: "", text: "" };

  const savedTheme = localStorage.getItem(THEME_KEY) || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  const updateThemeBtn = () => {
    $("themeBtn").textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "切换到日间模式" : "切换到暗夜模式";
  };
  updateThemeBtn();
  $("themeBtn").onclick = () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
    updateThemeBtn();
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const time = (t) => t ? new Date(t).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const ago = (t) => {
    if (!t) return "-";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + " 秒前";
    const m = Math.round(s / 60);
    if (m < 60) return m + " 分钟前";
    const h = Math.round(m / 60);
    if (h < 48) return h + " 小时前";
    return Math.round(h / 24) + " 天前";
  };
  const greetText = () => {
    const h = new Date().getHours();
    if (h < 6) return "夜深啦";
    if (h < 12) return "早上好";
    if (h < 18) return "下午好";
    return "晚上好";
  };
  const statusLabel = (s) => ({ blocked: "需要你", working: "工作中", done: "已完成", idle: "空闲" }[s] || s || "未知");

  async function api(path, init = {}, raw = false) {
    const res = await fetch(base + path, { ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(init.headers || {}) } });
    if (res.status === 401) { showLogin("令牌不对，或者已经更换"); throw new Error("unauthorized"); }
    if (raw) {
      const text = await res.text();
      if (!res.ok) throw new Error(text || ("HTTP " + res.status));
      return text;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || ("HTTP " + res.status));
    return body;
  }

  function showLogin(msg) {
    sessionStorage.removeItem(KEY);
    token = "";
    stopFollow();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    $("app").hidden = true;
    $("login").hidden = false;
    $("loginError").textContent = msg || "";
  }

  function switchTab(tab) {
    activeTab = tab;
    for (const b of document.querySelectorAll("[data-tab]")) b.classList.toggle("active", b.dataset.tab === tab);
    for (const s of document.querySelectorAll(".tab-view")) s.hidden = s.id !== "view-" + tab;
    window.scrollTo(0, 0);
    if (tab === "logs") loadLogs().catch(() => {});
    else if (tab === "data") loadDataTab().catch(() => {});
  }

  for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => switchTab(b.dataset.tab);

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
    lastOverview = o;
    const up = ago(o.startedAt).replace("前", "");
    $("sideVer").textContent = "v" + o.version + " · 运行 " + up;
    const b = o.board || { blocked: 0, working: 0, done: 0, idle: 0 };
    $("greetTitle").innerHTML = greetText() + ' <small id="greetSub">工作中 ' + b.working + " · 需要你 " + b.blocked + " · 通知监听 " + (o.notifySubs ?? 0) + " 台</small>";
    $("nb-agents").textContent = String(o.agents ?? 0);
    $("nb-devices").textContent = o.online + "/" + o.devices;
    $("nb-voice").textContent = o.assistant.replyMode === "voice" ? "双轨语音" : "文字";
    $("nb-mem").textContent = String(o.assistant.memoryCount ?? 0);
    const troubleSum = (o.last24h?.warn || 0) + (o.last24h?.error || 0);
    $("nb-warn").textContent = troubleSum ? ("!" + troubleSum) : "正常";
    $("guardName").textContent = (o.assistant.name || "爱弥斯") + " 在岗";
    $("guardSub").textContent = "推送订阅: " + (o.notifySubs ?? 0) + " · 音库: " + (o.assistant.voiceHostOnline ? "本机在线" : (o.voice ? o.voice.provider : "未开"));

    $("kpis").innerHTML = [
      '<div class="kpi warn-tint" data-kpi="blocked"><div class="kpi-head"><span>需要你</span><span class="pill blocked">待处理</span></div><div class="kpi-val">' + esc(b.blocked) + '</div><div class="kpi-sub"><span>等待确认或报错停住</span></div></div>',
      '<div class="kpi work-tint" data-kpi="working"><div class="kpi-head"><span>工作中</span><span class="pill working">执行中</span></div><div class="kpi-val">' + esc(b.working) + '</div><div class="kpi-sub"><span>正在运行或思考中</span></div></div>',
      '<div class="kpi done-tint" data-kpi="done"><div class="kpi-head"><span>已完成</span><span class="pill done">待查看</span></div><div class="kpi-val">' + esc(b.done) + '</div><div class="kpi-sub"><span>本轮停稳尚未点看</span></div></div>',
      '<div class="kpi" data-kpi="warn"><div class="kpi-head"><span>值守与 24h 告警</span><span class="pill ' + ((o.last24h?.error || 0) > 0 ? "err" : "on") + '">' + esc(o.online + "/" + o.devices + " 在线") + '</span></div><div class="kpi-val">' + esc((o.last24h?.warn || 0) + " / " + (o.last24h?.error || 0)) + '</div><div class="kpi-sub"><span class="pill warn">warn ' + esc(o.last24h?.warn || 0) + '</span><span class="pill err">error ' + esc(o.last24h?.error || 0) + "</span><span>点此查告警日志</span></div></div>",
    ].join("");
    for (const card of document.querySelectorAll("[data-kpi]")) {
      card.onclick = () => {
        const k = card.dataset.kpi;
        if (k === "warn") {
          $("level").value = "warn";
          switchTab("logs");
        } else {
          boardStatusFilter = k;
          for (const ch of document.querySelectorAll("[data-bstat]")) ch.classList.toggle("active", ch.dataset.bstat === k);
          renderAgents();
        }
      };
    }

    const targets = o.assistant?.models || [];
    $("modelList").innerHTML = targets.length
      ? targets.map((m, idx) => '<div class="probe-row"><div><b>' + (idx === 0 ? "主模型" : "备用 " + idx) + '</b> <span class="mono">' + esc(m) + '</span><div class="muted" style="font-size:12px">' + esc(o.assistant.endpoint || "local") + '</div></div><span class="pill" data-probe-badge="' + idx + '">未测速</span></div>').join("")
      : '<p class="muted">尚未配置文字模型</p>';

    $("voicePanel").innerHTML =
      '<div class="probe-row"><div><b>回复播报模式</b><div class="muted" style="font-size:12px">当前：' + (o.assistant.replyMode === "voice" ? "双轨语音播报" : "纯文字") + '</div></div><button class="ghost sm" id="toggleReplyBtn">切到' + (o.assistant.replyMode === "voice" ? "纯文字" : "双轨语音") + '</button></div>' +
      '<div class="probe-row"><div><b>动手前确认</b><div class="muted" style="font-size:12px">当前：' + (o.assistant.confirm === "always" ? "每次先问再做" : "直接执行") + '</div></div><button class="ghost sm" id="toggleConfirmBtn">切到' + (o.assistant.confirm === "always" ? "直接做" : "先问") + '</button></div>' +
      '<div class="probe-row"><div><b>语音通道</b><div class="muted" style="font-size:12px">' + esc(o.voice ? (o.voice.provider + " · " + o.voice.model) : "未启用") + " · Windows语音宿主 " + (o.assistant.voiceHostOnline ? "在线" : "未连") + '</div></div><span class="pill ' + (o.assistant.voiceHostOnline || o.voice ? "on" : "") + '">' + (o.voice ? "已就绪" : "未开") + "</span></div>";
    $("toggleReplyBtn").onclick = async () => {
      await api("/v1/assistant/settings", { method: "POST", body: JSON.stringify({ replyMode: o.assistant.replyMode === "voice" ? "text" : "voice" }) });
      await loadOverview();
    };
    $("toggleConfirmBtn").onclick = async () => {
      await api("/v1/assistant/settings", { method: "POST", body: JSON.stringify({ confirm: o.assistant.confirm === "always" ? "never" : "always" }) });
      await loadOverview();
    };

    const rows = (o.actions || []).map((a) =>
      '<tr class="' + (a.state === "failed" ? "error" : a.state === "pending" ? "warn" : "") + '"><td class="time">' + time(a.createdAt) + "</td><td>" + esc(a.kind) + "</td><td>" + esc(a.state) + '</td><td class="msg">' + esc(a.summary) + '</td><td class="msg">' + esc(a.result || "") + "</td></tr>");
    $("actions").querySelector("tbody").innerHTML = rows.join("") || '<tr><td colspan="5" class="muted">还没有操作记录</td></tr>';
  }

  async function loadAgents() {
    const inc = $("showShells").checked ? "?includeShell=1" : "";
    const { agents } = await api("/v1/admin/agents" + inc);
    lastAgents = agents || [];
    const devSel = $("agentDeviceFilter");
    const keepDev = devSel.value;
    const devs = [...new Set(lastAgents.map((a) => a.deviceName).filter(Boolean))];
    devSel.innerHTML = '<option value="">全部电脑</option>' + devs.map((d) => '<option value="' + esc(d) + '">' + esc(d) + "</option>").join("");
    if (devs.includes(keepDev)) devSel.value = keepDev;
    renderAgents();
  }

  function renderAgents() {
    const kw = $("agentSearch").value.trim().toLowerCase();
    const dev = $("agentDeviceFilter").value;
    const shown = lastAgents.filter((a) => {
      if (boardStatusFilter && a.status !== boardStatusFilter) return false;
      if (dev && a.deviceName !== dev) return false;
      if (kw) {
        const hay = [a.title, a.where, a.deviceName, a.key, a.harness, a.preview].join(" ").toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    $("agentBoardCount").textContent = "(" + shown.length + " / " + lastAgents.length + ")";
    $("agentGrid").innerHTML = shown.map((a) => {
      const pct = a.contextTokens && a.contextLimit ? Math.min(100, Math.round((a.contextTokens * 100) / a.contextLimit)) : null;
      return '<div class="agent-card">' +
        '<div class="agent-top"><div><div class="agent-title">' + esc(a.title || a.key) + '</div><div class="agent-meta">' + esc(a.harness) + " · " + esc(a.deviceName) + (a.where ? " / " + esc(a.where) : "") + '</div></div><span class="pill ' + esc(a.status) + '">' + esc(statusLabel(a.status)) + '</span></div>' +
        '<div class="agent-preview">' + esc(a.reason || a.preview || "（暂无输出摘要）") + '</div>' +
        '<div class="row-wrap">' +
          (a.subagentsWorking ? '<span class="pill on">子 agent ' + esc(a.subagentsWorking) + " 干活中</span>" : (a.subagents ? '<span class="pill">子 agent ' + esc(a.subagents) + "</span>" : "")) +
          (a.watcherCount ? '<span class="pill pink">已设提醒 ' + esc(a.watcherCount) + "</span>" : "") +
          (a.turn ? '<span class="pill">第 ' + esc(a.turn) + " 轮</span>" : "") +
          (a.model ? '<span class="pill">' + esc(a.model) + "</span>" : "") +
          '<span class="muted" style="font-size:11.5px;margin-left:auto">' + ago(a.updatedAt || a.statusSince) + "</span>" +
        "</div>" +
        (pct !== null ? '<div><div class="muted" style="font-size:11px;display:flex;justify-content:space-between"><span>上下文窗口</span><span>' + Math.round(a.contextTokens / 1000) + "k / " + Math.round(a.contextLimit / 1000) + "k (" + pct + '%)</span></div><div class="ctx-bar"><div class="ctx-fill" style="width:' + pct + '%"></div></div></div>' : "") +
        '<div class="row-wrap" style="margin-top:auto;padding-top:4px">' +
          '<button class="ghost sm" data-ag-log="' + esc(a.key) + '">查日志</button>' +
          '<button class="ghost sm" data-ag-diag="' + esc(a.key) + '" data-ag-name="' + esc(a.title || a.key) + '">导出 AI 排障包</button>' +
        "</div></div>";
    }).join("") || '<p class="muted">当前筛选下没有 Agent</p>';

    for (const b of document.querySelectorAll("[data-ag-log]")) {
      b.onclick = () => { $("text").value = b.dataset.agLog; $("kind").value = ""; $("level").value = ""; switchTab("logs"); };
    }
    for (const b of document.querySelectorAll("[data-ag-diag]")) {
      b.onclick = () => openDiagnostics({ agent: b.dataset.agDiag, label: b.dataset.agName });
    }
  }

  for (const ch of document.querySelectorAll("[data-bstat]")) {
    ch.onclick = () => {
      boardStatusFilter = ch.dataset.bstat;
      for (const x of document.querySelectorAll("[data-bstat]")) x.classList.toggle("active", x === ch);
      renderAgents();
    };
  }
  $("showShells").onchange = () => loadAgents().catch(() => {});
  $("agentSearch").oninput = renderAgents;
  $("agentDeviceFilter").onchange = renderAgents;

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
    $("devices").querySelector("tbody").innerHTML = devices.map((d) =>
      "<tr><td><b>" + esc(d.name) + '</b><div class="mono muted">' + esc(d.id) + "</div></td><td>" + (d.kind === "host" ? "电脑" : "手机") + '</td><td><span class="pill ' + (d.online ? "on" : "") + '">' + (d.online ? "在线" : "离线") + '</span></td><td class="time">' + (d.online ? "现在" : ago(d.lastSeenAt)) + "</td><td>" + esc(d.version || "-") + "</td><td>" + esc(d.platform || "-") + '</td><td><div class="row-wrap">' + (d.sources || []).map((s) => '<span class="pill">' + esc(s) + "</span>").join("") + '</div></td><td><div class="row-wrap"><button class="ghost sm" data-dev-log="' + esc(d.id) + '">日志</button><button class="ghost sm" data-revoke="' + esc(d.id) + '" data-name="' + esc(d.name) + '">吊销</button></div></td></tr>'
    ).join("") || '<tr><td colspan="8" class="muted">还没有设备</td></tr>';

    for (const b of document.querySelectorAll("[data-dev-log]")) {
      b.onclick = () => { $("device").value = b.dataset.devLog; switchTab("logs"); };
    }
    for (const b of document.querySelectorAll("[data-revoke]")) {
      b.onclick = async () => {
        if (!confirm("吊销「" + b.dataset.name + "」？它会立刻断开，要重新配对才能再连。")) return;
        await api("/v1/devices/" + encodeURIComponent(b.dataset.revoke), { method: "DELETE" });
        await loadDevices();
      };
    }
  }

  $("genPairBtn").onclick = async () => {
    const kind = $("pairKind").value;
    const out = await api("/v1/pair/codes", { method: "POST", body: JSON.stringify(kind ? { kind } : {}) });
    $("pairResult").textContent = "配对码: " + out.code + " · 链接: " + out.link;
  };

  $("probeBtn").onclick = async () => {
    $("probeBtn").disabled = true;
    $("probeBtn").textContent = "测速中…";
    try {
      const { results } = await api("/v1/admin/probe", { method: "POST", body: "{}" });
      for (const r of results || []) {
        const badge = document.querySelector('[data-probe-badge="' + (r.index - 1) + '"]');
        if (badge) {
          badge.className = "pill " + (r.ok ? "on" : "err");
          badge.textContent = r.ok ? (r.latencyMs + "ms · " + (r.reply || "ok")) : ("失败 " + r.latencyMs + "ms: " + (r.error || ""));
        }
      }
    } finally {
      $("probeBtn").disabled = false;
      $("probeBtn").textContent = "一键测速";
    }
  };

  async function loadDataTab() {
    const [pf, mem, led] = await Promise.all([
      api("/v1/assistant/profile"),
      api("/v1/assistant/memories?limit=60" + ($("memQuery").value.trim() ? "&q=" + encodeURIComponent($("memQuery").value.trim()) : "")),
      api("/v1/ledger"),
    ]);
    if (pf?.profile) {
      $("pfName").value = pf.profile.name || "";
      $("pfCall").value = pf.profile.userCall || "";
      $("pfPersona").value = pf.profile.personaText || "";
      $("profileHint").textContent = pf.profile.updatedBy ? ("最后由 " + pf.profile.updatedBy + " 修改于 " + ago(pf.profile.updatedAt)) : "";
    }
    $("memTotal").textContent = "(共 " + (mem?.total ?? 0) + " 条)";
    $("memTable").querySelector("tbody").innerHTML = (mem?.memories || []).map((m) =>
      '<tr><td><span class="pill pink">' + esc(m.category) + (m.pinned ? " · 置顶" : "") + '</span></td><td class="msg">' + esc(m.content) + (m.slotKey ? '<div class="mono muted">' + esc(m.slotKey) + "</div>" : "") + '</td><td class="time">' + ago(m.updatedAt) + "</td></tr>"
    ).join("") || '<tr><td colspan="3" class="muted">暂无记忆</td></tr>';

    const p = led?.plan || {};
    const fmtY = (c) => c === null || c === undefined ? "-" : ("¥" + (c / 100).toFixed(2));
    $("ledgerMeta").textContent = (led?.config?.enabled ? "已开启" : "未开启") + " · 余额 " + fmtY(p.balanceCents) + " · 今日剩余 " + fmtY(p.todayRemainingCents);
    $("ledgerTable").querySelector("tbody").innerHTML = (led?.recentTransactions || []).slice(0, 30).map((tx) =>
      '<tr><td class="time">' + time(tx.ts) + '</td><td><span class="pill ' + (tx.direction === "income" ? "on" : "warn") + '">' + (tx.direction === "income" ? "收入" : "支出") + "</span></td><td><b>" + fmtY(tx.amountCents) + '</b></td><td class="msg">' + esc(tx.title) + '</td><td><span class="pill">' + esc(tx.source) + '</span></td><td class="msg muted">' + esc(tx.note || "") + "</td></tr>"
    ).join("") || '<tr><td colspan="6" class="muted">暂无账单记录</td></tr>';
  }

  $("saveProfileBtn").onclick = async () => {
    await api("/v1/assistant/profile", {
      method: "POST",
      body: JSON.stringify({ name: $("pfName").value.trim(), userCall: $("pfCall").value.trim(), personaText: $("pfPersona").value }),
    });
    $("profileMsg").textContent = "已保存";
    setTimeout(() => { $("profileMsg").textContent = ""; }, 2000);
    await loadOverview();
  };
  $("memSearchBtn").onclick = () => loadDataTab().catch(() => {});
  $("memExportBtn").onclick = async () => {
    const res = await api("/v1/assistant/memories/export");
    openTextModal("长期记忆 Markdown 导出", res.markdown || "");
  };

  function query(after) {
    const q = new URLSearchParams();
    if (after) q.set("after", String(after));
    else q.set("since", $("since").value);
    for (const k of ["device", "source", "kind", "level", "text"]) if ($(k).value.trim()) q.set(k, $(k).value.trim());
    q.set("limit", after ? "500" : $("limit").value);
    return "/v1/logs?" + q.toString();
  }

  function logRow(e) {
    const who = e.source === "relay" ? "服务器 relay" : ((e.source === "host" ? "电脑 · " : "手机 · ") + (e.deviceName || names[e.device] || e.device || e.source));
    const chips = e.data
      ? '<div class="data-chips">' + Object.entries(e.data).map(([k, v]) => '<span class="data-chip">' + esc(k + "=" + (typeof v === "string" ? v : JSON.stringify(v))) + "</span>").join("") + "</div>"
      : "";
    const lvlPill = e.level === "error" ? "err" : e.level === "warn" ? "warn" : e.level === "debug" ? "" : "done";
    return '<tr class="' + esc(e.level) + '"><td class="time">' + time(e.ts) + '</td><td><span class="pill ' + lvlPill + '">' + esc(e.level) + "</span></td><td>" + esc(who) + '</td><td><span class="pill">' + esc(e.kind) + '</span></td><td class="msg">' + esc(e.msg) + chips + "</td></tr>";
  }

  async function loadLogs() {
    const { entries } = await api(query());
    lastId = entries.length ? entries[entries.length - 1].id : lastId;
    $("logs").querySelector("tbody").innerHTML = entries.slice().reverse().map(logRow).join("") || '<tr><td colspan="5" class="muted">这段时间没有日志</td></tr>';
    $("logCount").textContent = "(" + entries.length + " 条)";
    for (const ch of document.querySelectorAll("[data-k]")) ch.classList.toggle("active", ch.dataset.k === $("kind").value.trim());
  }

  async function follow() {
    try {
      const { entries } = await api(query(lastId));
      if (!entries.length) return;
      lastId = entries[entries.length - 1].id;
      const body = $("logs").querySelector("tbody");
      if (body.querySelector("td[colspan]")) body.innerHTML = "";
      body.insertAdjacentHTML("afterbegin", entries.slice().reverse().map(logRow).join(""));
    } catch {
      /* ignore transient poll failure */
    }
  }

  function stopFollow() {
    if (followTimer) clearInterval(followTimer);
    followTimer = null;
  }

  for (const ch of document.querySelectorAll("[data-k]")) {
    ch.onclick = () => { $("kind").value = ch.dataset.k; loadLogs().catch(() => {}); };
  }
  $("search").onclick = () => loadLogs();
  for (const id of ["since", "device", "source", "level", "limit"]) $(id).onchange = () => loadLogs();
  for (const id of ["kind", "text"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") loadLogs(); });
  $("follow").onchange = () => {
    stopFollow();
    if ($("follow").checked) followTimer = setInterval(follow, 4000);
  };

  function diagParams(opts = {}) {
    const q = new URLSearchParams();
    q.set("since", $("since").value || "1h");
    q.set("limit", $("limit").value || "300");
    if (opts.agent) q.set("agent", opts.agent);
    else {
      for (const k of ["device", "source", "kind", "level", "text"]) if ($(k).value.trim()) q.set(k, $(k).value.trim());
    }
    q.set("format", diagState.format);
    return "/v1/diagnostics?" + q.toString();
  }

  function openTextModal(title, text) {
    diagState = { format: "markdown", agent: "", text, staticOnly: true };
    $("diagTitle").textContent = title;
    $("diagFormatBtn").hidden = true;
    $("diagMeta").textContent = text.length + " 字符";
    $("diagBody").textContent = text;
    $("diagModal").hidden = false;
  }

  async function openDiagnostics(opts = {}) {
    diagState = { format: "markdown", agent: opts.agent || "", text: "", staticOnly: false, label: opts.label || "" };
    $("diagFormatBtn").hidden = false;
    $("diagTitle").textContent = opts.label ? ("AI 排障包 · " + opts.label) : "AI 排障诊断包（三端合并 · 已脱敏）";
    await fetchDiagnostics();
    $("diagModal").hidden = false;
  }

  async function fetchDiagnostics() {
    const url = diagParams({ agent: diagState.agent });
    $("diagMeta").textContent = "加载中…";
    let text = await api(url, {}, true);
    if (diagState.format === "json") {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* keep raw text */
      }
    }
    diagState.text = text;
    $("diagMeta").textContent = "格式: " + diagState.format.toUpperCase() + " · " + text.split("\\n").length + " 行 · " + text.length + " 字符（密钥已自动脱敏）";
    $("diagBody").textContent = text;
  }

  $("exportTopBtn").onclick = () => openDiagnostics();
  $("exportLogBtn").onclick = () => openDiagnostics();
  $("diagFormatBtn").onclick = async () => {
    if (diagState.staticOnly) return;
    diagState.format = diagState.format === "markdown" ? "json" : "markdown";
    await fetchDiagnostics();
  };
  $("diagCopyBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText(diagState.text);
      $("diagCopyBtn").textContent = "已复制";
      setTimeout(() => { $("diagCopyBtn").textContent = "一键复制"; }, 1800);
    } catch {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($("diagBody"));
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("copy");
      $("diagCopyBtn").textContent = "已选中复制";
      setTimeout(() => { $("diagCopyBtn").textContent = "一键复制"; }, 1800);
    }
  };
  $("diagDownloadBtn").onclick = () => {
    const ext = diagState.format === "json" ? "json" : "md";
    const blob = new Blob([diagState.text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "xiaoaixiaoai-diagnostics-" + new Date().toISOString().replace(/[:.]/g, "-") + "." + ext;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("diagCloseBtn").onclick = () => { $("diagModal").hidden = true; };

  function renderQuickList() {
    const q = $("quickInput").value.trim().toLowerCase();
    const tabs = [
      { label: "页签 · 概览与智能体看板", run: () => switchTab("overview") },
      { label: "页签 · 设备与配对", run: () => switchTab("devices") },
      { label: "页签 · 模型与语音诊断", run: () => switchTab("models") },
      { label: "页签 · 人设记忆与账单核查", run: () => switchTab("data") },
      { label: "页签 · 实时日志与 AI 排障包", run: () => switchTab("logs") },
    ];
    const agItems = lastAgents.slice(0, 60).map((a) => ({
      label: "Agent [" + statusLabel(a.status) + "] " + (a.title || a.key) + " · " + a.deviceName,
      run: () => { $("text").value = a.key; switchTab("logs"); },
    }));
    const list = [...tabs, ...agItems].filter((x) => !q || x.label.toLowerCase().includes(q)).slice(0, 20);
    $("quickList").innerHTML = list.map((x, i) => '<button class="ghost" style="text-align:left;justify-content:flex-start" data-qidx="' + i + '">' + esc(x.label) + "</button>").join("") || '<span class="muted">没有匹配项</span>';
    for (const b of document.querySelectorAll("[data-qidx]")) {
      b.onclick = () => { $("quickModal").hidden = true; list[Number(b.dataset.qidx)].run(); };
    }
  }
  const openQuick = () => { $("quickModal").hidden = false; $("quickInput").value = ""; renderQuickList(); $("quickInput").focus(); };
  $("quickBtn").onclick = openQuick;
  $("quickCloseBtn").onclick = () => { $("quickModal").hidden = true; };
  $("quickInput").oninput = renderQuickList;
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openQuick(); }
    if (e.key === "Escape") { $("quickModal").hidden = true; $("diagModal").hidden = true; }
  });

  async function loadAll() {
    await Promise.all([loadOverview(), loadDevices(), loadAgents()]);
    if (activeTab === "logs") await loadLogs();
    else if (activeTab === "data") await loadDataTab();
  }

  $("enter").onclick = enter;
  $("token").addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); });
  $("logout").onclick = () => showLogin("");
  $("refreshBtn").onclick = () => loadAll().catch(() => {});

  const startPoll = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (token && !document.hidden) {
        loadOverview().catch(() => {});
        if (activeTab === "overview") loadAgents().catch(() => {});
      }
    }, 20000);
  };

  if (token) {
    $("app").hidden = false;
    loadAll().then(startPoll).catch((e) => { if (e.message !== "unauthorized") $("greetSub").textContent = e.message; });
  } else {
    showLogin("");
  }
})();
</script>
</body>
</html>`;
}
