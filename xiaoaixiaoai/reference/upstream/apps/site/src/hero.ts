// Hero stage: mascot interactions, orbiting agent avatars, status bubbles.
import { onLang, t } from "./i18n";
import { reducedMotion, finePointer, slowNetwork, afterLoad, h, $ } from "./util";

const VENDORS: [string, string, "work" | "wait" | "done"][] = [
  ["claude-code", "Claude Code", "work"],
  ["codex", "Codex", "wait"],
  ["gemini", "Gemini", "work"],
  ["opencode", "OpenCode", "done"],
  ["kimi", "Kimi", "work"],
  ["qwen", "Qwen", "done"],
  ["cursor", "Cursor", "work"],
  ["pi", "pi", "wait"],
];

export function initHero(): void {
  const stage = $("#stage")!;
  const orbit = $("#orbit")!;
  const mascotBtn = $<HTMLButtonElement>("#mascot")!;
  const img = mascotBtn.querySelector<HTMLImageElement>("img")!;
  const say = $("#mascot-say")!;
  const bubbles = $("#bubbles")!;
  const still = reducedMotion();

  // ---- Swap the static poster for the animated loop (about 1 MB) once the page
  // has loaded and the stage is on screen. Data saver and 2G/3G keep the poster.
  const idleUrl = img.dataset.anim!;
  const tapUrl = img.dataset.tap!;
  if (!still && !slowNetwork()) {
    afterLoad(() => {
      const io = new IntersectionObserver(([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const pre = new Image();
        pre.decoding = "async";
        pre.src = idleUrl;
        pre.onload = () => {
          img.src = idleUrl;
        };
      });
      io.observe(stage);
    });
  }

  // ---- Orbit
  const items = VENDORS.map(([v, name, st]) => {
    const el = h(`<div class="orbit-item" title="${name}"><img src="assets/vendors/${v}.webp" alt="" width="62" height="62" /><b class="${st}"></b></div>`);
    orbit.appendChild(el);
    return el;
  });
  let visible = true;
  const TAU = Math.PI * 2;
  const PERIOD = TAU / 0.00018; // ms per revolution, about 35 s
  const STEPS = 48;
  const tilt = (-14 * Math.PI) / 180;
  // Position, size and fade of an avatar at angle `a` on a stage `w` px wide.
  const pose = (a: number, w: number) => {
    const ex = Math.cos(a) * w * 0.47;
    const ey = Math.sin(a) * w * 0.13;
    const x = ex * Math.cos(tilt) - ey * Math.sin(tilt);
    const y = ex * Math.sin(tilt) + ey * Math.cos(tilt);
    const depth = Math.sin(a); // +1 front, -1 back
    const s = 0.62 + 0.38 * ((depth + 1) / 2);
    return {
      transform: `translate3d(${x.toFixed(1)}px, ${(w * 0.14 + y).toFixed(1)}px, 0) scale(${s.toFixed(3)})`,
      opacity: (0.55 + 0.45 * ((depth + 1) / 2)).toFixed(2),
    };
  };
  const angleOf = (i: number, ms: number) => (ms / PERIOD) * TAU + (i / items.length) * TAU;
  // Front avatars pass over the mascot, back ones under it, slightly out of focus.
  const layer = (ms: number) =>
    items.forEach((el, i) => {
      const depth = Math.sin(angleOf(i, ms));
      const z = depth > 0.05 ? "5" : "2";
      const blur = depth < -0.2 ? `blur(${((-depth - 0.2) * 2.2).toFixed(1)}px)` : "none";
      if (el.style.zIndex !== z) el.style.zIndex = z;
      if (el.style.filter !== blur) el.style.filter = blur;
    });

  // The orbit is a precomputed Web Animation of transform and opacity, which the
  // browser runs on the compositor: no script or layout per frame. Stacking order
  // and blur (which Chrome can't animate on the compositor) are set from script
  // four times a second; over 250 ms the blur moves by at most 0.1 px.
  let anims: Animation[] = [];
  let builtFor = 0;
  let layerTimer = 0;
  const now = () => Number(anims[0]?.currentTime ?? 0);
  const build = () => {
    const w = stage.clientWidth;
    if (!w || w === builtFor) return;
    builtFor = w;
    if (still) {
      items.forEach((el, i) => Object.assign(el.style, pose(angleOf(i, 0), w)));
      layer(0);
      return;
    }
    const t = now();
    anims.forEach((a) => a.cancel());
    anims = items.map((el, i) => {
      const frames = Array.from({ length: STEPS + 1 }, (_, k) => pose(angleOf(i, 0) + (k / STEPS) * TAU, w));
      const anim = el.animate(frames, { duration: PERIOD, iterations: Infinity });
      anim.currentTime = t;
      if (!visible) anim.pause();
      return anim;
    });
    layer(t);
  };
  build();
  window.addEventListener("resize", build);

  // Runs only while the stage is on screen.
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    clearInterval(layerTimer);
    if (still) return;
    if (!builtFor) build();
    anims.forEach((a) => (visible ? a.play() : a.pause()));
    if (visible) layerTimer = window.setInterval(() => layer(now()), 250);
  }).observe(stage);

  // ---- Parallax tilt toward the pointer
  if (finePointer() && !still) {
    const hero = stage.closest(".hero") as HTMLElement;
    hero.addEventListener("pointermove", (e) => {
      const r = stage.getBoundingClientRect();
      const mx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width * 0.9)));
      const my = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height * 0.9)));
      stage.style.setProperty("--mx", mx.toFixed(3));
      stage.style.setProperty("--my", my.toFixed(3));
    });
  }

  // ---- Speech bubble lines
  const lines = () => [
    t("要我帮你看看谁在等你吗？", "Want me to check who's waiting on you?"),
    t("Codex 刚跑完，测试全过。", "Codex just finished. All tests pass."),
    t("我在盯着 3 台电脑哦。", "I'm keeping an eye on 3 computers."),
    t("说一声，我直接去办。", "Say the word and I'll do it."),
    t("戳我一下试试？", "Go on, give me a poke."),
  ];
  let li = 0;
  let sayTimer = 0;
  const showSay = (text: string, ms = 3200) => {
    say.textContent = text;
    say.classList.add("is-on");
    clearTimeout(sayTimer);
    sayTimer = window.setTimeout(() => say.classList.remove("is-on"), ms);
  };
  if (!still) {
    setTimeout(() => showSay(lines()[0]), 1600);
    setInterval(() => {
      if (!visible || document.hidden) return;
      li = (li + 1) % lines().length;
      showSay(lines()[li]);
    }, 6500);
  }
  onLang(() => say.classList.remove("is-on"));

  // ---- Tap: play the tap animation, burst hearts
  let tapBlob: Blob | null = null;
  let busy = false;
  const heartSvg =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1Z"/></svg>';
  mascotBtn.addEventListener("click", async () => {
    showSay(
      [t("嘿嘿，在呢！", "Hehe, I'm here!"), t("我会盯好它们的。", "I'll keep watch."), t("有事随时叫我～", "Call me anytime.")][
        Math.floor(Math.random() * 3)
      ],
      2200,
    );
    if (still) return;
    // hearts
    for (let i = 0; i < 6; i++) {
      const el = h(`<span class="heart">${heartSvg}</span>`);
      stage.appendChild(el);
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
      const d = 90 + Math.random() * 80;
      el.style.left = "50%";
      el.style.top = "26%";
      el.animate(
        [
          { transform: "translate(-50%,-50%) scale(.3)", opacity: 0 },
          { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: 0.2 },
          {
            transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(${0.6 + Math.random() * 0.6}) rotate(${(Math.random() - 0.5) * 60}deg)`,
            opacity: 0,
          },
        ],
        { duration: 1100 + Math.random() * 500, easing: "cubic-bezier(.22,1,.36,1)" },
      ).onfinish = () => el.remove();
    }
    if (busy) return;
    busy = true;
    try {
      tapBlob ??= await (await fetch(tapUrl)).blob();
      const url = URL.createObjectURL(tapBlob);
      img.src = url;
      setTimeout(() => {
        img.src = idleUrl;
        URL.revokeObjectURL(url);
        busy = false;
      }, 2350);
    } catch {
      busy = false;
    }
  });

  // ---- Status bubbles popping around the stage
  const narrow = window.matchMedia("(max-width: 520px)").matches;
  const slots = narrow
    ? [
        { left: "0%", top: "14%" },
        { left: "60%", top: "34%" },
        { left: "0%", top: "48%" },
      ]
    : [
        { left: "-8%", top: "16%" },
        { left: "70%", top: "30%" },
        { left: "-10%", top: "52%" },
      ];
  const msgs = () => [
    ["claude-code", "Claude Code", "st-wait", t("等你确认", "Needs your OK")],
    ["codex", "Codex", "st-done", t("跑完了 · 测试全过", "Done · tests pass")],
    ["gemini", "Gemini", "st-work", t("工作中 · 第 41 轮", "Working · turn 41")],
    ["kimi", "Kimi", "st-done", t("报表生成好了", "Report is ready")],
    ["opencode", "OpenCode", "st-work", t("工作中 · 组件迁移", "Working · migration")],
    ["qwen", "Qwen", "st-wait", t("想跑 rm -rf dist，等你批准", "Wants to run rm -rf dist")],
  ];
  const live: (HTMLElement | null)[] = [null, null, null];
  let mi = 0;
  const pop = (slot: number) => {
    const [v, name, cls, text] = msgs()[mi % msgs().length];
    mi++;
    const el = h(`<div class="bubble"><img src="assets/vendors/${v}.webp" alt="" /><div><b>${name}</b><small class="${cls}">${text}</small></div></div>`);
    Object.assign(el.style, slots[slot]);
    bubbles.appendChild(el);
    if (!still) el.animate([{ opacity: 0, transform: "translateY(14px) scale(.85)" }, { opacity: 1, transform: "none" }], { duration: 600, easing: "cubic-bezier(.34,1.56,.64,1)" });
    const old = live[slot];
    if (old) {
      if (still) old.remove();
      else old.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-12px) scale(.9)" }], { duration: 350, fill: "forwards" }).onfinish = () => old.remove();
    }
    live[slot] = el;
  };
  pop(0);
  pop(1);
  pop(2);
  let si = 0;
  if (!still) {
    setInterval(() => {
      if (!visible || document.hidden) return;
      pop(si % 3);
      si++;
    }, 2600);
  }
  onLang(() => {
    for (let s = 0; s < 3; s++) pop(s);
  });
}
