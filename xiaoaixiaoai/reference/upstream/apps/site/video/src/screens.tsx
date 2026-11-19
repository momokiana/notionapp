// Frame-driven versions of the site's phone screens (same class names as
// apps/site/src/styles/phone.css, so both stay visually identical).
import React from "react";
import { AnimatedImage, Img, useCurrentFrame } from "remotion";
import { Rise, StatusBar, asset, typed } from "./kit";

type St = "work" | "wait" | "done" | "idle";
const LABEL: Record<St, string> = { work: "工作中", wait: "等你", done: "已完成", idle: "空闲" };
const Pill: React.FC<{ s: St }> = ({ s }) => <span className={`a-pill st-${s}`}>{LABEL[s]}</span>;

const AGENTS = [
  { v: "claude-code", name: "Claude Code", t: "web-shop · 结账页重构", host: "MacBook Pro · 第 22 轮" },
  { v: "codex", name: "Codex", t: "docs-site · 文档生成", host: "MacBook Pro · 第 7 轮" },
  { v: "gemini", name: "Gemini", t: "api-gateway · 补全测试", host: "Linux 工作站 · 第 41 轮" },
  { v: "kimi", name: "Kimi", t: "data-report · 报表脚本", host: "云主机 · 第 15 轮" },
  { v: "opencode", name: "OpenCode", t: "mobile-app · 组件迁移", host: "Linux 工作站 · 第 3 轮" },
];

const ICON = {
  menu: <svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14" /></svg>,
  back: <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>,
  send: <svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  phone: <svg viewBox="0 0 24 24"><path d="M6.6 4.5h2.6l1.4 3.6-1.9 1.2a10 10 0 0 0 5.9 5.9l1.2-1.9 3.6 1.4v2.6a1.9 1.9 0 0 1-2 1.9A15 15 0 0 1 4.7 6.5a1.9 1.9 0 0 1 1.9-2Z" /></svg>,
  bot: <svg viewBox="0 0 24 24"><rect x="4.5" y="8" width="15" height="11" rx="4" /><path d="M12 4.5V8M9.5 13h.01M14.5 13h.01" /></svg>,
  layers: <svg viewBox="0 0 24 24"><path d="m12 4 8 4.5-8 4.5-8-4.5L12 4Z" /><path d="m4 13 8 4.5 8-4.5" /></svg>,
  laptop: <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 19h20" /></svg>,
  gear: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M4.6 7.2l1.9 1.1M17.5 15.7l1.9 1.1M4.6 16.8l1.9-1.1M17.5 8.3l1.9-1.1" /></svg>,
  kbd: <svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2.5" /><path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8 14h8" /></svg>,
  down: <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>,
  cc: <svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="3" /><path d="M10.5 10.2a2 2 0 1 0 0 3.6M16.5 10.2a2 2 0 1 0 0 3.6" /></svg>,
  mic: <svg viewBox="0 0 24 24"><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" /></svg>,
  micOff: <svg viewBox="0 0 24 24"><path d="M9 9V6.5a3 3 0 0 1 6 0V11M5.5 11.5a6.5 6.5 0 0 0 10.6 5M12 18v2.5M4 4l16 16" /></svg>,
  hang: <svg viewBox="0 0 24 24"><path d="M3.5 14.2c4.7-4.3 12.3-4.3 17 0l-2.1 2.6-3.3-1.3v-2.4a10 10 0 0 0-6.2 0v2.4l-3.3 1.3-2.1-2.6Z" /></svg>,
};

const TabBar: React.FC<{ on: number }> = ({ on }) => (
  <div className="a-tabbar">
    {[
      [ICON.bot, "助理"],
      [ICON.layers, "Agents"],
      [ICON.laptop, "设备"],
      [ICON.gear, "设置"],
    ].map(([i, l], k) => (
      <span key={k} className={k === on ? "on" : ""}>
        {i}
        {l}
      </span>
    ))}
  </div>
);

// ------------------------------------------------------------------ agent list
export const AgentList: React.FC<{ events: [number, number, St][] }> = ({ events }) => {
  const f = useCurrentFrame();
  const sts: St[] = ["work", "wait", "work", "done", "idle"];
  const flashAt: number[] = [-99, -99, -99, -99, -99];
  for (const [at, i, s] of events)
    if (f >= at) {
      sts[i] = s;
      flashAt[i] = at;
    }
  const count = (s: St) => sts.filter((x) => x === s).length;
  return (
    <div className="scr">
      <StatusBar />
      <div className="scr-body">
        <div className="a-top">
          <span className="a-round">{ICON.menu}</span>
          <div className="a-hello">
            <b>夜深啦</b>
            <span>{count("work")} 个 agent 正在忙</span>
          </div>
          <Img className="a-mini-mascot" src={asset("mascot/hello.webp")} />
        </div>
        <div className="a-tiles">
          <div className="a-tile t-wait">需要你<b>{count("wait")}</b></div>
          <div className="a-tile t-work">工作中<b>{count("work")}</b></div>
          <div className="a-tile t-done">已完成<b>{count("done")}</b></div>
        </div>
        <div className="a-sec">全部 agent</div>
        <div className="a-cards">
          {AGENTS.map((a, i) => {
            const fl = f - flashAt[i];
            const flash = fl >= 0 && fl < 18;
            return (
              <Rise key={a.v} at={i * 4}>
                <div className={`a-card${flash ? " flash" : ""}`}>
                  <Img src={asset(`vendors/${a.v}.webp`)} />
                  <div className="a-card-main">
                    <b>{a.t}</b>
                    <span>
                      {a.name} · {a.host}
                    </span>
                  </div>
                  <div className="a-card-side">
                    <Pill s={sts[i]} />
                    <span>{flashAt[i] > 0 ? "刚刚" : `${[9, 2, 5, 60, 180][i] >= 60 ? `${[9, 2, 5, 60, 180][i] / 60} 小时前` : `${[9, 2, 5, 60, 180][i]} 分钟前`}`}</span>
                  </div>
                </div>
              </Rise>
            );
          })}
        </div>
        <span className="a-fab">+</span>
      </div>
      <TabBar on={1} />
    </div>
  );
};

// ------------------------------------------------------------------ detail header
const DetailHead: React.FC<{ tab: 0 | 1 }> = ({ tab }) => (
  <>
    <div className="a-head">
      <span className="a-round">{ICON.back}</span>
      <b>结账页重构</b>
    </div>
    <div className="a-meta">
      <Img src={asset("vendors/claude-code.webp")} />
      <span>Claude Code · MacBook Pro · web-shop</span>
      <Pill s="work" />
    </div>
    <div className="a-seg">
      <span className={tab === 0 ? "on" : ""}>对话</span>
      <span className={tab === 1 ? "on" : ""}>终端</span>
      <span>信息</span>
    </div>
  </>
);

const Ok = () => <span className="ok" />;
const Tool: React.FC<{ k: "bash" | "edit" | "grep"; name: string; arg: string; fail?: string }> = ({ k, name, arg, fail }) => (
  <div className={`a-tool${fail ? " fail" : ""}`}>
    <i className={`k-${k}`}>
      {k === "bash" ? (
        ">_"
      ) : k === "edit" ? (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 19.5 5.5 15 15.8 4.7a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L9 18.5l-4.5 1Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m19 19-4.2-4.2" />
        </svg>
      )}
    </i>
    <b>{name}</b>
    <code>{arg}</code>
    {fail ? <span className="bad">{fail}</span> : <Ok />}
  </div>
);

const Feed: React.FC<{ children: React.ReactNode; top: number }> = ({ children, top }) => (
  <div
    style={{
      position: "absolute",
      left: 14,
      right: 14,
      top,
      bottom: 84,
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
      overflow: "hidden",
      WebkitMaskImage: "linear-gradient(transparent, #000 12%)",
    }}
  >
    <div className="a-feed">{children}</div>
  </div>
);

// ------------------------------------------------------------------ conversation
export const Chat: React.FC = () => {
  const f = useCurrentFrame();
  const userText = "顺便把金额四舍五入也测一下";
  const typing = f >= 120 && f < 160;
  return (
    <div className="scr">
      <StatusBar />
      <div className="scr-body">
        <DetailHead tab={0} />
        <Feed top={122}>
          <Rise at={6}><p className="a-text">我先把结账流程的测试跑一遍，看看哪里挂了。</p></Rise>
          <Rise at={26}><Tool k="bash" name="Bash" arg="pnpm test checkout" /></Rise>
          <Rise at={44}><Tool k="edit" name="Edit" arg="src/cart/total.ts" fail="1 个失败" /></Rise>
          <Rise at={62}><Tool k="grep" name="Grep" arg='rg "applyCoupon" src/' /></Rise>
          <Rise at={84}><p className="a-think">优惠券在运费之后才扣，顺序反了，我来改……</p></Rise>
          <Rise at={162}><div className="a-user">{userText}</div></Rise>
          <Rise at={186}><p className="a-text">好的，补两个用例。</p></Rise>
          <Rise at={204}><Tool k="edit" name="Edit" arg="test/cart/total.test.ts" /></Rise>
          <Rise at={222}><Tool k="bash" name="Bash" arg="pnpm test checkout" /></Rise>
          <Rise at={244}>
            <div className="a-working">
              <AnimatedImage src={asset("mascot/working.webp")} width={34} height={34} />
              正在干活<span>2 分 13 秒</span>
            </div>
          </Rise>
        </Feed>
        <div className="a-composer">
          <span className={`cmp${typing ? " typed" : ""}`}>{typing ? typed(userText, f, 120, 14) : "回它一句…"}</span>
          <span className="a-send">{ICON.send}</span>
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ terminal
export const Term: React.FC = () => {
  const f = useCurrentFrame();
  const L = (at: number, node: React.ReactNode) => (f >= at ? <div>{node}</div> : null);
  const cmd1 = typed("claude", f, 4, 14);
  const cmd2 = typed("pnpm test checkout", f, 104, 20);
  const sel = f >= 252 && f < 276 ? 2 : 1;
  const press = (k: string) => {
    const at = { down: 252, up: 276, enter: 298 }[k];
    return at !== undefined && f >= at && f < at + 6 ? " press" : "";
  };
  return (
    <div className="scr">
      <StatusBar />
      <div className="scr-body">
        <DetailHead tab={1} />
        <div className="a-term">
          <div className="a-term-bar">
            <span>t42 · web-shop · 96×40</span>
            <span className="live">实时</span>
          </div>
          <div className="a-term-out">
            <div>
              <span className="p">$ </span>
              {cmd1}
            </div>
            {L(
              30,
              <>
                <span className="m">&gt; </span>
                <span className="y">目标：</span>修复结账金额计算，并补回归测试。
              </>,
            )}
            {L(44, <><span className="g">✓</span> 读取 src/cart/total.ts</>)}
            {L(56, <><span className="g">✓</span> 定位：优惠券在运费之后才扣</>)}
            {L(70, <span className="d">@@ -18,3 +18,3 @@ export function total(cart)</span>)}
            {L(76, <span className="r">-  return subtotal + shipping - coupon</span>)}
            {L(82, <span className="g">+  return round(subtotal - coupon) + shipping</span>)}
            {L(
              100,
              <>
                <span className="p">$ </span>
                {cmd2}
              </>,
            )}
            {L(150, <><span className="g">✓ 24 passed</span> <span className="d">(1.8s)</span></>)}
            {L(170, <><span className="y">* 思考中…</span> <span className="d">(3m 12s · 18.4k tokens)</span></>)}
            {L(200, <>要应用这处修改吗？</>)}
            {L(206, <>{sel === 1 ? <span className="p">❯</span> : " "} 1. 应用</>)}
            {L(206, <>{sel === 2 ? <span className="p">❯</span> : " "} 2. 应用，并且不再询问</>)}
            {L(206, <>  3. 不要</>)}
            {L(300, <span className="g">✓ 已应用</span>)}
          </div>
        </div>
        <div className="a-keys">
          <span className="kb">{ICON.kbd}</span>
          <span>Esc</span>
          <span>Tab</span>
          <span className={press("up").trim()}>↑</span>
          <span className={press("down").trim()}>↓</span>
          <span className={press("enter").trim()}>回车</span>
          <span className="cc">^C</span>
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ assistant
const Bot: React.FC<{ at: number; text: React.ReactNode; label?: string; think?: number }> = ({ at, text, label, think = 20 }) => {
  const f = useCurrentFrame();
  return (
    <Rise at={at}>
      <div className={`as-bot${label ? " proactive" : ""}`}>
        <Img src={asset("mascot/default.webp")} />
        <div>
          {f < at + think ? (
            <span className="as-typing">
              <i style={{ transform: `translateY(${Math.sin(f / 3) * -3}px)` }} />
              <i style={{ transform: `translateY(${Math.sin(f / 3 - 1) * -3}px)` }} />
              <i style={{ transform: `translateY(${Math.sin(f / 3 - 2) * -3}px)` }} />
            </span>
          ) : (
            <>
              {label ? <small>{label}</small> : null}
              {text}
            </>
          )}
        </div>
      </div>
    </Rise>
  );
};

// What 小羊 did: spinner while it runs, mint check once done (no confirm card).
const Did: React.FC<{ at: number; ok: number; what: string; arg: string }> = ({ at, ok, what, arg }) => {
  const f = useCurrentFrame();
  const done = f >= ok;
  return (
    <Rise at={at}>
      <div className={`as-did ${done ? "is-ok" : "is-run"}`}>
        <span className="did-ico" style={done ? undefined : { transform: `rotate(${(f - at) * 15}deg)` }} />
        <div>
          <b>{what}</b>
          <code>{arg}</code>
        </div>
      </div>
    </Rise>
  );
};

export const Assistant: React.FC = () => {
  const f = useCurrentFrame();
  const q1 = "现在谁在等我？";
  const q2 = "让它覆盖吧";
  const q3 = "在 Linux 那台开个 Codex 补测试";
  const composer =
    f >= 4 && f < 26
      ? typed(q1, f, 4, 14)
      : f >= 84 && f < 102
        ? typed(q2, f, 84, 14)
        : f >= 212 && f < 246
          ? typed(q3, f, 212, 22)
          : "";
  return (
    <div className="scr">
      <StatusBar />
      <div className="scr-body">
        <div className="as-head">
          <Img src={asset("mascot/default.webp")} />
          <div>
            <b>小羊</b>
            <span>在线 · 看着 3 台电脑</span>
          </div>
          <span className="a-round">{ICON.phone}</span>
        </div>
        <Feed top={66}>
          <Rise at={28}><div className="a-user">{q1}</div></Rise>
          <Bot at={34} text="docs-site 的 Codex 在问要不要覆盖 README，其余 3 个都在干活。" />
          <Rise at={104}><div className="a-user">{q2}</div></Rise>
          <Did at={110} ok={138} what="发给 docs-site · Codex" arg="可以，覆盖吧" />
          <Bot at={144} text="发了，它还没回。" think={14} />
          <Bot at={182} label="主动提醒 · 刚刚" think={8} text="web-shop 的 Claude Code 跑完了，24 个测试全过。" />
          <Rise at={248}><div className="a-user">{q3}</div></Rise>
          <Did at={254} ok={284} what="在 Linux 工作站启动 Codex" arg="api-gateway · 补齐单元测试" />
          <Bot at={290} text="开好了，任务已经交给它。跑完我叫你。" think={14} />
          <Rise at={318} style={{ alignSelf: "center" }}>
            <span className="as-reminder">盯着 · api-gateway 的 Codex</span>
          </Rise>
        </Feed>
        <div className="a-composer">
          <span className={`cmp${composer ? " typed" : ""}`}>{composer || "问问小羊…"}</span>
          <span className="a-send">{ICON.send}</span>
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ call
export type CallState = "connecting" | "idle" | "listening" | "thinking" | "speaking" | "muted";
export const CALL_TIMELINE: [number, CallState][] = [
  [0, "connecting"],
  [36, "idle"],
  [62, "listening"],
  [124, "thinking"],
  [166, "speaking"],
  [246, "muted"],
];
export const callStateAt = (f: number): CallState => {
  let s: CallState = "connecting";
  for (const [at, st] of CALL_TIMELINE) if (f >= at) s = st;
  return s;
};
const CALL_LABEL: Record<CallState, string> = {
  connecting: "正在接通…",
  idle: "小羊在线",
  listening: "小羊在听",
  thinking: "小羊在想",
  speaking: "小羊在说",
  muted: "已静音",
};

export const Call: React.FC = () => {
  const f = useCurrentFrame();
  const s = callStateAt(f);
  const secs = 151 + Math.floor(f / 30);
  const amp = s === "speaking" ? 1 : s === "listening" ? 0.7 : s === "thinking" ? 0.3 : 0.08;
  const q = "帮我看看谁跑完了";
  const a = "web-shop 的 Claude Code 跑完了，测试全过。Codex 还在问要不要覆盖 README。";
  const ring = (delay: number, color: string) => {
    const p = (((f + delay) % 42) / 42) as number;
    return (
      <span
        className="c-ring"
        style={{ opacity: s === "speaking" || s === "listening" ? 0.9 * (1 - p) : 0, transform: `scale(${1 + p * 0.28})`, borderColor: color }}
      />
    );
  };
  return (
    <div className="scr call-scr">
      <StatusBar />
      <div className="c-top">
        <span className="a-round">{ICON.down}</span>
        <span className="c-timer">
          通话中 {String(Math.floor(secs / 60)).padStart(2, "0")}:{String(secs % 60).padStart(2, "0")}
        </span>
        <span className="a-round">{ICON.cc}</span>
      </div>
      <div className="c-face" data-state={s}>
        {ring(0, s === "listening" ? "rgba(46,138,106,.5)" : "rgba(242,123,166,.55)")}
        {ring(21, s === "listening" ? "rgba(46,138,106,.5)" : "rgba(242,123,166,.55)")}
        {s === "connecting" ? (
          <span
            className="c-ring"
            style={{ opacity: 1, inset: -10, borderColor: "transparent", borderTopColor: "#f27ba6", borderRightColor: "rgba(242,123,166,.4)", transform: `rotate(${f * 10}deg)` }}
          />
        ) : null}
        <AnimatedImage key={s} src={asset(`call/${s}.webp`)} width={196} height={196} style={{ borderRadius: "50%", position: "absolute", inset: 0, boxShadow: "0 0 0 6px rgba(255,255,255,.7), 0 22px 40px -16px rgba(160,60,120,.6)" }} />
        <span className="c-mute" style={{ opacity: s === "muted" ? 1 : 0, transform: s === "muted" ? "none" : "scale(.5)" }}>
          {ICON.micOff}
        </span>
      </div>
      <div className="c-label">
        <span>{CALL_LABEL[s]}</span>
        <span className="c-wave">
          {[0, 1, 2, 3, 4].map((i) => {
            const v = s === "thinking" ? 0.3 + 0.25 * Math.sin(f / 4 + i) : 0.15 + amp * Math.abs(Math.sin(f * 0.9 + i * 1.7) * Math.cos(f * 0.37 + i));
            return <i key={i} style={{ height: `${Math.round(Math.min(1, v) * 100)}%` }} />;
          })}
        </span>
      </div>
      <div className="c-caps">
        {f >= 62 ? <div className="c-cap-user">{typed(q, f, 62, 9)}</div> : null}
        {f >= 124 && f < 166 ? <div className="c-tool">正在查：谁跑完了</div> : null}
        {f >= 166 ? (
          <div className="c-cap-bot">
            <Img src={asset("mascot/default.webp")} />
            <div>{typed(a, f, 166, 12)}</div>
          </div>
        ) : null}
      </div>
      <div className="c-btns">
        <span className={`c-btn${s === "muted" ? " on" : ""}`}>
          <span>{ICON.mic}</span>静音
        </span>
        <span className="c-btn hang">
          <span>{ICON.hang}</span>挂断
        </span>
        <span className="c-btn">
          <span>{ICON.kbd}</span>打字
        </span>
      </div>
    </div>
  );
};
