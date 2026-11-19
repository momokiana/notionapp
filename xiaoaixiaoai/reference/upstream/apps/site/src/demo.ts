// Live, scripted phone screens. All names here are fictional demo data.
import { t } from "./i18n";
import { h, sleep, typeInto, renderQr } from "./util";

export type Status = "work" | "wait" | "done" | "idle" | "err";

const A = "assets/";
const ICON = {
  wifi: '<svg viewBox="0 0 24 24"><path d="M12 19.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2ZM4.2 10.6a11 11 0 0 1 15.6 0l-1.6 1.6a8.8 8.8 0 0 0-12.4 0l-1.6-1.6Zm3.2 3.2a6.5 6.5 0 0 1 9.2 0L15 15.4a4.3 4.3 0 0 0-6 0l-1.6-1.6Z"/></svg>',
  bat: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="16" height="10" rx="2.5"/><rect x="20" y="10" width="1.8" height="4" rx=".9"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></svg>',
  term: '<svg viewBox="0 0 24 24"><path d="m6 8 4 4-4 4M12.5 16.5h6"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M6.6 4.5h2.6l1.4 3.6-1.9 1.2a10 10 0 0 0 5.9 5.9l1.2-1.9 3.6 1.4v2.6a1.9 1.9 0 0 1-2 1.9A15 15 0 0 1 4.7 6.5a1.9 1.9 0 0 1 1.9-2Z"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 12h16"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><path d="M9 9V6.5a3 3 0 0 1 6 0V11M5.5 11.5a6.5 6.5 0 0 0 10.6 5M12 18v2.5M4 4l16 16"/></svg>',
  hang: '<svg viewBox="0 0 24 24"><path d="M3.5 14.2c4.7-4.3 12.3-4.3 17 0l-2.1 2.6-3.3-1.3v-2.4a10 10 0 0 0-6.2 0v2.4l-3.3 1.3-2.1-2.6Z"/></svg>',
  kbd: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8 14h8"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  cc: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="3"/><path d="M10.5 10.2a2 2 0 1 0 0 3.6M16.5 10.2a2 2 0 1 0 0 3.6"/></svg>',
  bot: '<svg viewBox="0 0 24 24"><rect x="4.5" y="8" width="15" height="11" rx="4"/><path d="M12 4.5V8M9.5 13h.01M14.5 13h.01"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 4 8 4.5-8 4.5-8-4.5L12 4Z"/><path d="m4 13 8 4.5 8-4.5"/></svg>',
  laptop: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M4.6 7.2l1.9 1.1M17.5 15.7l1.9 1.1M4.6 16.8l1.9-1.1M17.5 8.3l1.9-1.1"/></svg>',
};

export const statusLabel = (s: Status): string =>
  ({
    work: t("工作中", "Working"),
    wait: t("等你", "Needs you"),
    done: t("已完成", "Done"),
    idle: t("空闲", "Idle"),
    err: t("出错", "Error"),
  })[s];

interface Agent {
  v: string;
  name: string;
  proj: string;
  task: [string, string];
  host: [string, string];
  turn: number;
  st: Status;
  ago: [string, string];
}

export const AGENTS: Agent[] = [
  { v: "claude-code", name: "Claude Code", proj: "web-shop", task: ["结账页重构", "Checkout refactor"], host: ["MacBook Pro", "MacBook Pro"], turn: 22, st: "work", ago: ["9 分钟前", "9 min ago"] },
  { v: "codex", name: "Codex", proj: "docs-site", task: ["文档生成", "Docs generation"], host: ["MacBook Pro", "MacBook Pro"], turn: 7, st: "wait", ago: ["2 分钟前", "2 min ago"] },
  { v: "gemini", name: "Gemini", proj: "api-gateway", task: ["补全测试", "Test coverage"], host: ["Linux 工作站", "Linux box"], turn: 41, st: "work", ago: ["5 分钟前", "5 min ago"] },
  { v: "kimi", name: "Kimi", proj: "data-report", task: ["报表脚本", "Report script"], host: ["云主机", "Cloud VM"], turn: 15, st: "done", ago: ["1 小时前", "1 h ago"] },
  { v: "opencode", name: "OpenCode", proj: "mobile-app", task: ["组件迁移", "Component migration"], host: ["Linux 工作站", "Linux box"], turn: 3, st: "idle", ago: ["3 小时前", "3 h ago"] },
];

const pick = (p: [string, string]) => t(p[0], p[1]);

function statusBar(): string {
  return `<div class="sb"><span>12:00</span><span class="sb-i">${ICON.wifi}${ICON.bat}</span></div>`;
}

function pill(s: Status): string {
  return `<span class="a-pill st-${s}">${statusLabel(s)}</span>`;
}

// ---------------------------------------------------------------- Agent list
export function agentListScreen(): HTMLElement {
  const el = h(`<div class="scr" data-scr="list">
    ${statusBar()}
    <div class="scr-body">
      <div class="a-top">
        <span class="a-round">${ICON.menu}</span>
        <div class="a-hello"><b>${t("夜深啦", "Late night")}</b><span class="a-busy"></span></div>
        <img class="a-mini-mascot" src="${A}mascot/hello.webp" alt="" />
      </div>
      <div class="a-tiles">
        <div class="a-tile t-wait">${t("需要你", "Needs you")}<b data-c="wait">0</b></div>
        <div class="a-tile t-work">${t("工作中", "Working")}<b data-c="work">0</b></div>
        <div class="a-tile t-done">${t("已完成", "Done")}<b data-c="done">0</b></div>
      </div>
      <div class="a-sec">${t("全部 agent", "All agents")}</div>
      <div class="a-cards"></div>
      <span class="a-fab">+</span>
    </div>
    <div class="a-tabbar">
      <span>${ICON.bot}${t("助理", "Assistant")}</span>
      <span class="on">${ICON.layers}Agents</span>
      <span>${ICON.laptop}${t("设备", "Devices")}</span>
      <span>${ICON.gear}${t("设置", "Settings")}</span>
    </div>
  </div>`);
  const cards = el.querySelector(".a-cards")!;
  for (const a of AGENTS) {
    cards.appendChild(
      h(`<div class="a-card" data-v="${a.v}">
        <img src="${A}vendors/${a.v}.webp" alt="" />
        <div class="a-card-main"><b>${a.proj} · ${pick(a.task)}</b><span>${a.name} · ${pick(a.host)} · ${t(`第 ${a.turn} 轮`, `turn ${a.turn}`)}</span></div>
        <div class="a-card-side">${pill(a.st)}<span>${pick(a.ago)}</span></div>
      </div>`),
    );
  }
  updateCounts(el, AGENTS.map((a) => a.st));
  return el;
}

function updateCounts(el: HTMLElement, sts: Status[]): void {
  for (const k of ["wait", "work", "done"] as const) {
    const b = el.querySelector<HTMLElement>(`[data-c="${k}"]`)!;
    const n = String(sts.filter((s) => s === k).length);
    if (b.textContent !== n) {
      b.textContent = n;
      b.classList.add("bump");
      setTimeout(() => b.classList.remove("bump"), 300);
    }
  }
  const busy = sts.filter((s) => s === "work").length;
  el.querySelector(".a-busy")!.textContent = t(`${busy} 个 agent 正在忙`, `${busy} agents busy`);
}

export async function agentListScenario(el: HTMLElement, signal: AbortSignal): Promise<void> {
  const sts = AGENTS.map((a) => a.st);
  const steps: [number, Status][] = [
    [2, "done"],
    [1, "work"],
    [0, "wait"],
    [4, "work"],
    [2, "work"],
    [0, "work"],
    [1, "wait"],
    [4, "idle"],
  ];
  const cards = Array.from(el.querySelectorAll<HTMLElement>(".a-card"));
  for (const [i, s] of steps) {
    await sleep(2300, signal);
    sts[i] = s;
    const card = cards[i];
    card.querySelector(".a-pill")!.outerHTML = pill(s);
    card.querySelector(".a-card-side span:last-child")!.textContent = t("刚刚", "just now");
    card.classList.add("flash");
    updateCounts(el, sts);
    await sleep(700, signal);
    card.classList.remove("flash");
  }
}

// ---------------------------------------------------------------- Detail header
function detailHead(tab: 0 | 1, s: Status = "work"): string {
  const a = AGENTS[0];
  return `<div class="a-head"><span class="a-round">${ICON.back}</span><b>${pick(a.task)}</b></div>
    <div class="a-meta"><img src="${A}vendors/${a.v}.webp" alt="" /><span>${a.name} · ${pick(a.host)} · ${a.proj}</span>${pill(s)}</div>
    <div class="a-seg"><span class="${tab === 0 ? "on" : ""}">${t("对话", "Chat")}</span><span class="${tab === 1 ? "on" : ""}">${t("终端", "Terminal")}</span><span>${t("信息", "Info")}</span></div>`;
}

// ---------------------------------------------------------------- Conversation
export function chatScreen(): HTMLElement {
  return h(`<div class="scr" data-scr="chat">
    ${statusBar()}
    <div class="scr-body">
      ${detailHead(0)}
      <div class="feed-wrap" style="position:absolute;left:14px;right:14px;top:122px;bottom:84px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;-webkit-mask-image:linear-gradient(transparent,#000 14%);mask-image:linear-gradient(transparent,#000 14%)">
        <div class="a-feed"></div>
      </div>
      <div class="a-composer"><span class="cmp">${t("回它一句…", "Reply…")}</span><span class="a-send">${ICON.send}</span></div>
    </div>
  </div>`);
}

const TOOL_ICON = {
  bash: "&gt;_",
  edit: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 19.5 5.5 15 15.8 4.7a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L9 18.5l-4.5 1Z"/></svg>',
  grep: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m19 19-4.2-4.2"/></svg>',
};
const tool = (k: "bash" | "edit" | "grep", name: string, arg: string, ok = true, failText = "") =>
  `<div class="a-tool${ok ? "" : " fail"}"><i class="k-${k}">${TOOL_ICON[k]}</i><b>${name}</b><code>${arg}</code>${ok ? '<span class="ok"></span>' : `<span class="bad">${failText}</span>`}</div>`;

export async function chatScenario(el: HTMLElement, signal: AbortSignal): Promise<void> {
  const feed = el.querySelector<HTMLElement>(".a-feed")!;
  const cmp = el.querySelector<HTMLElement>(".cmp")!;
  feed.innerHTML = "";
  const add = async (html: string, wait = 900) => {
    feed.appendChild(h(html));
    while (feed.children.length > 12) feed.firstElementChild!.remove();
    await sleep(wait, signal);
  };
  await sleep(300, signal);
  await add(`<p class="a-text">${t("我先把结账流程的测试跑一遍，看看哪里挂了。", "Let me run the checkout tests first and see what fails.")}</p>`);
  await add(tool("bash", "Bash", "pnpm test checkout"), 700);
  await add(tool("edit", "Edit", "src/cart/total.ts", false, t("1 个失败", "1 failed")), 700);
  await add(tool("grep", "Grep", 'rg "applyCoupon" src/'), 900);
  await add(`<p class="a-think">${t("优惠券在运费之后才扣，顺序反了，我来改……", "The coupon is applied after shipping; fixing the order…")}</p>`, 1200);
  cmp.classList.add("typed");
  await typeInto(cmp, t("顺便把金额四舍五入也测一下", "Also test the rounding while you're at it"), signal, 16);
  await sleep(400, signal);
  cmp.classList.remove("typed");
  cmp.textContent = t("回它一句…", "Reply…");
  await add(`<div class="a-user">${t("顺便把金额四舍五入也测一下", "Also test the rounding while you're at it")}</div>`, 1000);
  await add(`<p class="a-text">${t("好的，补两个用例。", "Sure, adding two cases.")}</p>`, 700);
  await add(tool("edit", "Edit", "test/cart/total.test.ts"), 700);
  await add(tool("bash", "Bash", "pnpm test checkout"), 800);
  await add(
    `<div class="a-working"><img src="${A}mascot/working.webp" alt="" />${t("正在干活", "Working")}<span>${t("2 分 13 秒", "2m 13s")}</span></div>`,
    3200,
  );
}

// ---------------------------------------------------------------- Terminal
export function termScreen(): HTMLElement {
  return h(`<div class="scr" data-scr="term">
    ${statusBar()}
    <div class="scr-body">
      ${detailHead(1)}
      <div class="a-term">
        <div class="a-term-bar"><span>t42 · web-shop · 96×40</span><span class="live">${t("实时", "Live")}</span></div>
        <div class="a-term-out"></div>
      </div>
      <div class="a-keys">
        <span class="kb">${ICON.kbd}</span><span data-k="esc">Esc</span><span data-k="tab">Tab</span><span data-k="up">↑</span><span data-k="down">↓</span><span data-k="enter">${t("回车", "Enter")}</span><span class="cc" data-k="cc">^C</span>
      </div>
    </div>
  </div>`);
}

export async function termScenario(el: HTMLElement, signal: AbortSignal): Promise<void> {
  const out = el.querySelector<HTMLElement>(".a-term-out")!;
  out.innerHTML = "";
  const line = (html: string) => {
    const d = document.createElement("div");
    d.innerHTML = html;
    out.appendChild(d);
    while (out.children.length > 22) out.firstElementChild!.remove();
    return d;
  };
  const typeCmd = async (prefix: string, cmd: string) => {
    const d = line(`${prefix}<span class="t"></span><span class="cur"></span>`);
    await typeInto(d.querySelector<HTMLElement>(".t")!, cmd, signal, 26);
    d.querySelector(".cur")!.remove();
  };
  const press = async (k: string) => {
    const key = el.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
    key.classList.add("press");
    await sleep(180, signal);
    key.classList.remove("press");
  };
  await sleep(300, signal);
  await typeCmd('<span class="p">$ </span>', "claude");
  await sleep(400, signal);
  line(`<span class="m">&gt; </span><span class="y">${t("目标：", "Goal: ")}</span>${t("修复结账金额计算，并补回归测试。", "fix the checkout total and add a regression test.")}`);
  await sleep(600, signal);
  line(`<span class="g">✓</span> ${t("读取", "Read")} src/cart/total.ts`);
  await sleep(380, signal);
  line(`<span class="g">✓</span> ${t("定位：优惠券在运费之后才扣", "Found: coupon applied after shipping")}`);
  await sleep(520, signal);
  line('<span class="d">@@ -18,3 +18,3 @@ export function total(cart)</span>');
  line('<span class="r">-  return subtotal + shipping - coupon</span>');
  line('<span class="g">+  return round(subtotal - coupon) + shipping</span>');
  await sleep(800, signal);
  await typeCmd('<span class="p">$ </span>', "pnpm test checkout");
  await sleep(700, signal);
  line(`<span class="g">✓ 24 passed</span> <span class="d">(1.8s)</span>`);
  await sleep(500, signal);
  line(`<span class="y">* ${t("思考中…", "Thinking…")}</span> <span class="d">(3m 12s · 18.4k tokens)</span>`);
  await sleep(900, signal);
  line(`${t("要应用这处修改吗？", "Apply this edit?")}`);
  const o1 = line(`<span class="p">❯</span> 1. ${t("应用", "Yes")}`);
  const o2 = line(`  2. ${t("应用，并且不再询问", "Yes, don't ask again")}`);
  line(`  3. ${t("不要", "No")}`);
  const sel = (n: 1 | 2) => {
    o1.innerHTML = `${n === 1 ? '<span class="p">❯</span>' : " "} 1. ${t("应用", "Yes")}`;
    o2.innerHTML = `${n === 2 ? '<span class="p">❯</span>' : " "} 2. ${t("应用，并且不再询问", "Yes, don't ask again")}`;
  };
  await sleep(1000, signal);
  await press("down");
  sel(2);
  await sleep(800, signal);
  await press("up");
  sel(1);
  await sleep(700, signal);
  await press("enter");
  line(`<span class="g">✓ ${t("已应用", "Applied")}</span>`);
  await sleep(500, signal);
  line('<span class="p">&gt; </span><span class="cur"></span>');
  await sleep(3000, signal);
}

// ---------------------------------------------------------------- Devices / pairing
export function pairScreen(): HTMLElement {
  const el = h(`<div class="scr" data-scr="pair">
    ${statusBar()}
    <div class="scr-body">
      <div class="a-head"><b style="flex:1">${t("设备", "Devices")}</b><span class="a-round">${ICON.scan}</span></div>
      <div class="dev-list">
        <div class="a-dev"><i></i><span>MacBook Pro</span><small>${t("在线", "Online")}</small></div>
        <div class="a-dev"><i></i><span>${t("Linux 工作站", "Linux box")}</span><small>${t("在线", "Online")}</small></div>
        <div class="a-dev"><i></i><span>${t("云主机", "Cloud VM")}</span><small>${t("在线", "Online")}</small></div>
      </div>
      <div class="a-scan"><div class="qr-ascii"></div></div>
      <div class="a-join hide">
        <b>${t("新电脑请求加入", "A new computer wants to join")}</b>
        <p>${t("Mac mini · 来自 herdr-pocket up", "Mac mini · via herdr-pocket up")}</p>
        <div class="a-btns"><span class="a-btn">${t("拒绝", "Deny")}</span><span class="a-btn primary">${t("允许加入", "Allow")}</span></div>
      </div>
    </div>
    <div class="a-tabbar">
      <span>${ICON.bot}${t("助理", "Assistant")}</span>
      <span>${ICON.layers}Agents</span>
      <span class="on">${ICON.laptop}${t("设备", "Devices")}</span>
      <span>${ICON.gear}${t("设置", "Settings")}</span>
    </div>
  </div>`);
  renderQr(el.querySelector<HTMLElement>(".qr-ascii")!, 21, 11);
  return el;
}

export async function pairScenario(el: HTMLElement, signal: AbortSignal): Promise<void> {
  const join = el.querySelector<HTMLElement>(".a-join")!;
  const list = el.querySelector<HTMLElement>(".dev-list")!;
  const scan = el.querySelector<HTMLElement>(".a-scan")!;
  const allow = join.querySelector<HTMLElement>(".a-btn.primary")!;
  list.querySelector(".a-dev.new")?.remove();
  join.classList.add("hide");
  scan.style.display = "";
  allow.classList.remove("done");
  allow.textContent = t("允许加入", "Allow");
  await sleep(2600, signal);
  join.classList.remove("hide");
  await sleep(1600, signal);
  allow.classList.add("press");
  await sleep(200, signal);
  allow.classList.remove("press");
  allow.classList.add("done");
  allow.textContent = t("已加入", "Joined");
  await sleep(700, signal);
  scan.style.display = "none";
  join.classList.add("hide");
  list.appendChild(h(`<div class="a-dev new" style="animation:msg-in .5s var(--ease-out) both"><i></i><span>${"Mac mini"}</span><small>${t("刚刚加入", "Just joined")}</small></div>`));
  await sleep(3200, signal);
}

// ---------------------------------------------------------------- Assistant chat
export function assistantScreen(): HTMLElement {
  return h(`<div class="scr" data-scr="as">
    ${statusBar()}
    <div class="scr-body">
      <div class="as-head"><img src="${A}mascot/default.webp" alt="" /><div><b>${t("小羊", "Xiaoyang")}</b><span>${t("在线 · 看着 3 台电脑", "Online · watching 3 computers")}</span></div><span class="a-round">${ICON.phone}</span></div>
      <div style="position:absolute;left:14px;right:14px;top:66px;bottom:84px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;-webkit-mask-image:linear-gradient(transparent,#000 12%);mask-image:linear-gradient(transparent,#000 12%)">
        <div class="a-feed"></div>
      </div>
      <div class="a-composer"><span class="cmp">${t("问问小羊…", "Ask Xiaoyang…")}</span><span class="a-send">${ICON.send}</span></div>
    </div>
  </div>`);
}

export async function assistantScenario(
  el: HTMLElement,
  signal: AbortSignal,
  notify: (title: string, body: string) => void,
): Promise<void> {
  const feed = el.querySelector<HTMLElement>(".a-feed")!;
  const cmp = el.querySelector<HTMLElement>(".cmp")!;
  const placeholder = t("问问小羊…", "Ask Xiaoyang…");
  feed.innerHTML = "";
  const add = (html: string) => {
    const n = h(html);
    feed.appendChild(n);
    while (feed.children.length > 10) feed.firstElementChild!.remove();
    return n;
  };
  const say = async (text: string) => {
    cmp.classList.add("typed");
    await typeInto(cmp, text, signal, 18);
    await sleep(300, signal);
    cmp.classList.remove("typed");
    cmp.textContent = placeholder;
    add(`<div class="a-user">${text}</div>`);
  };
  const bot = async (html: string, label = "", think = 900) => {
    const n = add(`<div class="as-bot${label ? " proactive" : ""}"><img src="${A}mascot/default.webp" alt="" /><div><span class="as-typing"><i></i><i></i><i></i></span></div></div>`);
    await sleep(think, signal);
    n.querySelector(":scope > div")!.innerHTML = `${label ? `<small>${label}</small>` : ""}${html}`;
    return n;
  };

  // She acts right away and reports what actually happened; no confirm card.
  const did = async (what: string, arg: string) => {
    const n = add(`<div class="as-did is-run"><span class="did-ico"></span><div><b>${what}</b><code>${arg}</code></div></div>`);
    await sleep(1100, signal);
    n.classList.replace("is-run", "is-ok");
    await sleep(350, signal);
  };

  await sleep(500, signal);
  await say(t("现在谁在等我？", "Who's waiting on me?"));
  await sleep(300, signal);
  await bot(
    t(
      "docs-site 的 Codex 在问要不要覆盖 README，其余 3 个都在干活。",
      "Codex on docs-site is asking whether to overwrite the README; the other 3 are busy.",
    ),
  );
  await sleep(1600, signal);
  await say(t("让它覆盖吧", "Tell it to go ahead"));
  await did(t("发给 docs-site · Codex", "Sent to docs-site · Codex"), t("可以，覆盖吧", "Yes, overwrite it"));
  await bot(t("发了，它还没回。", "Sent. It hasn't replied yet."), "", 600);
  await sleep(1800, signal);
  const doneText = t("web-shop 的 Claude Code 跑完了，24 个测试全过。", "Claude Code finished on web-shop; all 24 tests pass.");
  await bot(doneText, t("主动提醒 · 刚刚", "Heads-up · just now"), 500);
  notify(t("小羊", "Xiaoyang"), doneText);
  await sleep(1800, signal);
  await say(t("在 Linux 那台开个 Codex，给 api-gateway 补测试", "Start Codex on the Linux box to add tests to api-gateway"));
  await did(t("在 Linux 工作站启动 Codex", "Started Codex on the Linux box"), t("api-gateway · 补齐单元测试", "api-gateway · add unit tests"));
  await bot(t("开好了，任务已经交给它。跑完我叫你。", "It's running with the task. I'll tell you when it's done."), "", 700);
  add(`<span class="as-reminder">${t("盯着 · api-gateway 的 Codex", "Watching · Codex on api-gateway")}</span>`);
  await sleep(1600, signal);
  await say(t("今天花了多少？", "What did today cost?"));
  await bot(t("今天一共 $3.40，web-shop 的 Claude Code 最多，$1.90。", "$3.40 so far today; Claude Code on web-shop is the most, $1.90."));
  await sleep(1600, signal);
  notify(t("小羊", "Xiaoyang"), t("docs-site 的 Codex 回了：README 已经覆盖好。", "Codex on docs-site replied: the README is overwritten."));
  await sleep(3600, signal);
}

// ---------------------------------------------------------------- Voice call
export const CALL_STATES = ["connecting", "idle", "listening", "thinking", "speaking", "muted"] as const;
export type CallState = (typeof CALL_STATES)[number];

export const callStateName = (s: CallState): string =>
  ({
    connecting: t("连接中", "Connecting"),
    idle: t("待机", "Idle"),
    listening: t("在听", "Listening"),
    thinking: t("在想", "Thinking"),
    speaking: t("在说", "Speaking"),
    muted: t("静音", "Muted"),
  })[s];

const callLabel = (s: CallState): string =>
  ({
    connecting: t("正在接通…", "Connecting…"),
    idle: t("小羊在线", "Xiaoyang is here"),
    listening: t("小羊在听", "Listening"),
    thinking: t("小羊在想", "Thinking"),
    speaking: t("小羊在说", "Speaking"),
    muted: t("已静音", "Muted"),
  })[s];

export function callScreen(): HTMLElement {
  return h(`<div class="scr call-scr" data-scr="call">
    ${statusBar()}
    <div class="c-top"><span class="a-round">${ICON.down}</span><span class="c-timer">${t("通话中", "On call")} <span class="c-time">02:31</span></span><span class="a-round">${ICON.cc}</span></div>
    <div class="c-face" data-state="connecting">
      <span class="c-ring"></span><span class="c-ring"></span>
      <img class="f-a" src="${A}call/connecting.webp" alt="" loading="lazy" />
      <img class="f-b is-off" alt="" />
      <span class="c-mute">${ICON.micOff}</span>
    </div>
    <div class="c-label"><span class="c-label-t">${callLabel("connecting")}</span><span class="c-wave"><i></i><i></i><i></i><i></i><i></i></span></div>
    <div class="c-caps"></div>
    <div class="c-btns">
      <span class="c-btn c-mic"><span>${ICON.mic}</span>${t("静音", "Mute")}</span>
      <span class="c-btn hang"><span>${ICON.hang}</span>${t("挂断", "Hang up")}</span>
      <span class="c-btn"><span>${ICON.kbd}</span>${t("打字", "Type")}</span>
    </div>
  </div>`);
}

/** Controller for the call screen: face swapping, waveform, captions. */
export function callController(el: HTMLElement) {
  const face = el.querySelector<HTMLElement>(".c-face")!;
  let front = el.querySelector<HTMLImageElement>(".f-a")!;
  let back = el.querySelector<HTMLImageElement>(".f-b")!;
  const label = el.querySelector<HTMLElement>(".c-label-t")!;
  const bars = Array.from(el.querySelectorAll<HTMLElement>(".c-wave i"));
  const caps = el.querySelector<HTMLElement>(".c-caps")!;
  const time = el.querySelector<HTMLElement>(".c-time")!;
  const mic = el.querySelector<HTMLElement>(".c-mic")!;
  let state: CallState = "connecting";
  let secs = 151;
  let waveTimer = 0;
  let clockTimer = 0;

  const wave = () => {
    const amp = state === "speaking" ? 1 : state === "listening" ? 0.7 : state === "thinking" ? 0.25 : 0.08;
    const tt = performance.now() / 1000;
    bars.forEach((b, i) => {
      const v = state === "thinking" ? 0.3 + 0.25 * Math.sin(tt * 4 + i) : 0.15 + amp * Math.random();
      b.style.height = `${Math.round(Math.min(1, v) * 100)}%`;
    });
  };

  return {
    get state() {
      return state;
    },
    set(s: CallState) {
      if (s === state && front.getAttribute("src")) return;
      state = s;
      face.dataset.state = s;
      back.src = `${A}call/${s}.webp`;
      const swap = () => {
        back.classList.remove("is-off");
        front.classList.add("is-off");
        [front, back] = [back, front];
      };
      if (back.complete) swap();
      else back.onload = swap;
      label.textContent = callLabel(s);
      mic.classList.toggle("on", s === "muted");
    },
    start() {
      clearInterval(waveTimer);
      clearInterval(clockTimer);
      waveTimer = window.setInterval(wave, 120);
      clockTimer = window.setInterval(() => {
        secs++;
        time.textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
      }, 1000);
    },
    stop() {
      clearInterval(waveTimer);
      clearInterval(clockTimer);
    },
    caption(html: string) {
      const n = h(html);
      caps.appendChild(n);
      n.style.animation = "msg-in .45s var(--ease-out) both";
      while (caps.children.length > 3) caps.firstElementChild!.remove();
      return n;
    },
    clear() {
      caps.innerHTML = "";
    },
  };
}

export type CallCtl = ReturnType<typeof callController>;

export async function callScenario(ctl: CallCtl, signal: AbortSignal, onState: (s: CallState) => void): Promise<void> {
  const go = (s: CallState) => {
    ctl.set(s);
    onState(s);
  };
  ctl.clear();
  go("connecting");
  await sleep(1800, signal);
  go("idle");
  await sleep(1400, signal);
  go("listening");
  const u = ctl.caption(`<div class="c-cap-user"></div>`);
  await typeInto(u, t("帮我看看谁跑完了", "Can you check what finished?"), signal, 10);
  await sleep(500, signal);
  go("thinking");
  const tl = ctl.caption(`<div class="c-tool">${t("正在查：谁跑完了", "Checking: what finished")}</div>`);
  await sleep(2000, signal);
  tl.remove();
  go("speaking");
  const b = ctl.caption(`<div class="c-cap-bot"><img src="${A}mascot/default.webp" alt="" /><div></div></div>`);
  await typeInto(
    b.querySelector<HTMLElement>("div")!,
    t("web-shop 的 Claude Code 跑完了，测试全过。Codex 还在问要不要覆盖 README。", "Claude Code on web-shop is done, tests all pass. Codex is still asking about overwriting the README."),
    signal,
    14,
  );
  await sleep(1400, signal);
  go("muted");
  await sleep(2000, signal);
  go("idle");
  await sleep(1600, signal);
}
