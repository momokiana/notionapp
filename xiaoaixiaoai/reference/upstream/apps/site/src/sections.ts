import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SITE } from "./config";
import { onLang, t } from "./i18n";
import {
  agentListScreen,
  agentListScenario,
  chatScreen,
  chatScenario,
  termScreen,
  termScenario,
  pairScreen,
  pairScenario,
  assistantScreen,
  assistantScenario,
  callScreen,
  callController,
  callScenario,
  CALL_STATES,
  callStateName,
  type CallState,
} from "./demo";
import { $, $$, h, loopWhileVisible, reducedMotion, finePointer, isNarrow, slowNetwork, sleep, copyText, toast, renderQr } from "./util";

// ------------------------------------------------------------------ vendors marquee
export function initMarquee(): void {
  const list: [string, string][] = [
    ["claude-code", "Claude Code"],
    ["codex", "Codex"],
    ["gemini", "Gemini CLI"],
    ["opencode", "OpenCode"],
    ["kimi", "Kimi"],
    ["qwen", "Qwen Code"],
    ["cursor", "Cursor Agent"],
    ["pi", "pi"],
    ["", "Droid"],
    ["", "CodeBuddy"],
    ["", "Qoder"],
    ["", "omp"],
    ["hermes", "Hermes"],
    ["shell", "Shell"],
  ];
  const m = $("#marquee")!;
  // Agents without an avatar in the app get a lettered badge.
  const face = (v: string, n: string) =>
    v ? `<img src="assets/vendors/${v}.webp" alt="" width="38" height="38" loading="lazy" />` : `<span class="vendor-mono">${n[0].toUpperCase()}</span>`;
  const track = () => h(`<div class="marquee-track">${list.map(([v, n]) => `<span class="vendor">${face(v, n)}${n}</span>`).join("")}</div>`);
  m.append(track(), track());
  m.lastElementChild!.setAttribute("aria-hidden", "true");
}

// ------------------------------------------------------------------ statement scrub
export function initStatement(): void {
  const el = $("[data-scrub]");
  if (!el) return;
  let st: ScrollTrigger | null = null;
  const split = () => {
    const text = el.textContent!.trim().replace(/\s+/g, " ");
    const lang = document.documentElement.lang;
    let parts: string[];
    if ("Segmenter" in Intl) {
      const seg = new Intl.Segmenter(lang, { granularity: "word" });
      parts = Array.from(seg.segment(text), (s) => s.segment);
    } else parts = text.split(/(\s+)/);
    el.innerHTML = parts.map((p) => (p.trim() ? `<span class="w">${p}</span>` : p)).join("");
    const words = $$(".w", el);
    if (reducedMotion()) {
      words.forEach((w) => w.classList.add("is-lit"));
      return;
    }
    st?.kill();
    st = ScrollTrigger.create({
      trigger: el,
      start: "top 82%",
      end: "bottom 45%",
      scrub: true,
      onUpdate: (self) => {
        const n = Math.round(self.progress * words.length);
        words.forEach((w, i) => w.classList.toggle("is-lit", i < n));
      },
    });
  };
  split();
  onLang(() => {
    split();
    ScrollTrigger.refresh();
  });
}

// ------------------------------------------------------------------ hero title intro
export function wrapTitleLines(el: HTMLElement): HTMLElement[] {
  const parts = el.innerHTML.split(/<br\s*\/?>/i);
  el.innerHTML = parts.map((p) => `<span class="line"><span class="line-in">${p.trim()}</span></span>`).join("");
  return $$(".line-in", el);
}

// ------------------------------------------------------------------ views (sticky phone)
export function initViews(): void {
  const screen = $("#views-screen")!;
  const steps = $$(".view-step");
  const kinds = ["list", "chat", "term", "pair"] as const;
  type Kind = (typeof kinds)[number];
  const builders: Record<Kind, () => HTMLElement> = { list: agentListScreen, chat: chatScreen, term: termScreen, pair: pairScreen };
  const scenarios: Record<Kind, (el: HTMLElement, s: AbortSignal) => Promise<void>> = {
    list: agentListScenario,
    chat: chatScenario,
    term: termScenario,
    pair: pairScenario,
  };
  let screens: Record<Kind, HTMLElement> = {} as never;
  let active: Kind = "list";
  const render = () => {
    screen.innerHTML = "";
    for (const k of kinds) {
      const el = builders[k]();
      if (k !== active) el.classList.add("is-out");
      screen.appendChild(el);
      screens[k] = el;
    }
  };
  render();
  const runner = loopWhileVisible(screen, (s) => scenarios[active](screens[active], s));
  const setActive = (k: Kind) => {
    if (k === active) return;
    active = k;
    for (const kk of kinds) screens[kk].classList.toggle("is-out", kk !== k);
    steps.forEach((s) => s.classList.toggle("is-active", s.dataset.view === k));
    runner.restart();
  };
  steps[0].classList.add("is-active");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) setActive((e.target as HTMLElement).dataset.view as Kind);
    },
    { rootMargin: isNarrow() ? "-62% 0px -30% 0px" : "-45% 0px -45% 0px" },
  );
  steps.forEach((s) => io.observe(s));
  onLang(() => {
    render();
    runner.restart();
  });
  // Fit the phone on short mobile screens.
  const fit = () => {
    if (!isNarrow()) return;
    const z = Math.min(0.78, (window.innerHeight * 0.54) / 690);
    $("#views-phone")!.style.setProperty("--pz", z.toFixed(3));
  };
  fit();
  window.addEventListener("resize", fit);
}

// ------------------------------------------------------------------ assistant
export function initAssistant(): void {
  const screen = $("#as-screen")!;
  const stack = $("#notif-stack")!;
  let el = assistantScreen();
  screen.appendChild(el);
  const notify = (title: string, body: string) => {
    const n = h(`<div class="notif"><img src="assets/brand/logo-64.webp" alt="" /><div><div class="notif-meta"><b>Herdr Pocket</b><span>· ${title} · ${t("刚刚", "now")}</span></div>${body}</div></div>`);
    stack.prepend(n);
    n.animate([{ opacity: 0, transform: "translateY(-16px) scale(.95)" }, { opacity: 1, transform: "none" }], { duration: 550, easing: "cubic-bezier(.34,1.56,.64,1)" });
    const all = $$(".notif", stack);
    all.slice(2).forEach((o) => o.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }).finished.then(() => o.remove()));
  };
  const runner = loopWhileVisible(screen, async (s) => {
    stack.innerHTML = "";
    await assistantScenario(el, s, notify);
  });
  onLang(() => {
    el.remove();
    el = assistantScreen();
    screen.appendChild(el);
    stack.innerHTML = "";
    runner.restart();
  });
}

// ------------------------------------------------------------------ call
export function initCall(): void {
  const screen = $("#call-screen")!;
  const chips = $("#call-states")!;
  let el = callScreen();
  screen.appendChild(el);
  let ctl = callController(el);
  let manualUntil = 0;

  const renderChips = () => {
    chips.innerHTML = CALL_STATES.map(
      (s) => `<button class="cs" type="button" role="tab" data-s="${s}"><img src="assets/call/${s}.webp" alt="" width="34" height="34" loading="lazy" />${callStateName(s)}</button>`,
    ).join("");
  };
  const mark = (s: CallState) => $$(".cs", chips).forEach((c) => c.classList.toggle("is-on", c.dataset.s === s));
  renderChips();
  chips.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".cs");
    if (!b) return;
    const s = b.dataset.s as CallState;
    manualUntil = performance.now() + 7000;
    runner.setEnabled(false);
    ctl.set(s);
    ctl.start();
    mark(s);
    setTimeout(() => {
      if (performance.now() >= manualUntil) runner.setEnabled(true);
    }, 7100);
  });

  const runner = loopWhileVisible(
    screen,
    async (sig) => {
      ctl.start();
      try {
        await callScenario(ctl, sig, mark);
      } finally {
        ctl.stop();
      }
    },
  );
  // keep the waveform alive while a state is pinned manually
  const keepAlive = new IntersectionObserver(([e]) => (e.isIntersecting ? ctl.start() : ctl.stop()));
  keepAlive.observe(screen);
  onLang(() => {
    ctl.stop();
    el.remove();
    el = callScreen();
    screen.appendChild(el);
    ctl = callController(el);
    renderChips();
    runner.restart();
  });
}

// ------------------------------------------------------------------ commands + deploy tabs
export function initCommands(): void {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fill = (box: HTMLElement) => {
    const key = box.dataset.cmd as keyof typeof SITE.commands;
    $(".cmd-text", box)!.innerHTML = SITE.commands[key]
      .split(/(\s+)/)
      // PowerShell's `::Create((irm`: keep `irm` whole when the long part before it wraps.
      .flatMap((w) => w.split(/(?<=\(\()/))
      .map((w) => (w.trim() && w.length <= 16 ? `<span class="nw">${esc(w)}</span>` : esc(w)))
      .join("");
  };
  $$("[data-cmd]").forEach((box) => {
    fill(box);
    $(".cmd-copy", box)?.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLElement;
      const ok = await copyText(SITE.commands[box.dataset.cmd as keyof typeof SITE.commands]);
      toast(ok ? t("已复制到剪贴板", "Copied to clipboard") : t("复制失败，请手动选择", "Copy failed; select it manually"));
      if (ok) {
        btn.classList.add("is-done");
        setTimeout(() => btn.classList.remove("is-done"), 1400);
      }
    });
  });
  const server = $("#server-cmd")!;
  // What each relay route needs to know, under the command.
  const note = $("#server-note")!;
  const notes = (): Record<string, string> => ({
    serverCompose: t(
      "Compose 版在 7420 端口提供普通 HTTP。最后一行找出一次性设置码，在 App 里和服务器地址一起填上就能连上。",
      "The Compose route serves plain HTTP on port 7420. The last line finds the one-time setup code; enter it in the app together with the server address.",
    ),
    serverScript: t(
      "有 Docker 就用 Docker，没有就装 Node 和 systemd 服务；Caddy 负责 HTTPS 证书。先把域名解析到这台服务器，并开放 80 和 443 端口。",
      "Uses Docker when it's there, otherwise Node and a systemd service; Caddy handles the HTTPS certificate. Point your domain at the server and open ports 80 and 443 first.",
    ),
    serverCloudflare: t(
      "走 Cloudflare Tunnel：不用开端口，也不用管证书。只想先试试？改用 <code>--tunnel quick</code>，会拿到一个临时的 trycloudflare.com 地址。",
      "Runs through Cloudflare Tunnel: no open ports, no certificates. Just trying it out? Use <code>--tunnel quick</code> for a temporary trycloudflare.com address.",
    ),
  });
  const showNote = () => (note.innerHTML = notes()[server.dataset.cmd!] ?? "");
  showNote();
  onLang(showNote);
  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.toggle("is-on", x === tab));
      server.dataset.cmd = tab.dataset.tab!;
      fill(server);
      showNote();
      if (!reducedMotion()) $(".cmd-text", server)!.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 300 });
    }),
  );
  $$<HTMLAnchorElement>("[data-href]").forEach((a) => {
    a.href = SITE[a.dataset.href as "githubUrl" | "releasesUrl" | "issuesUrl" | "docsUrl" | "licenseUrl"];
  });
  const qr = $("#qr-ascii");
  if (qr) renderQr(qr, 21, 3);
  // small QR in the bento card
  const art = $(".art-qr .qr");
  if (art) renderQr(art, 13, 5);
}

// ------------------------------------------------------------------ bento
export function initBento(): void {
  const cards = $$("[data-tilt]");
  cards.forEach((c, i) => {
    c.setAttribute("data-reveal", "");
    c.style.transitionDelay = `${(i % 4) * 70}ms`;
  });
  if (finePointer() && !reducedMotion()) {
    cards.forEach((c) => {
      c.addEventListener("pointermove", (e) => {
        const r = c.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        c.style.setProperty("--mx", `${x * 100}%`);
        c.style.setProperty("--my", `${y * 100}%`);
        c.style.transform = `rotateX(${(0.5 - y) * 6}deg) rotateY(${(x - 0.5) * 6}deg) translateZ(0)`;
      });
      c.addEventListener("pointerleave", () => {
        c.style.transform = "";
      });
    });
  }
  // countdown in the QR card
  const b = $(".art-qr b");
  if (b && !reducedMotion()) {
    let s = 600;
    setInterval(() => {
      s = s <= 1 ? 600 : s - 1;
      b.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
  }
  // hash scramble
  const hash = $(".art-hash span");
  if (hash && !reducedMotion()) {
    const hex = "0123456789abcdef";
    const rnd = (n: number) => Array.from({ length: n }, () => hex[Math.floor(Math.random() * 16)]).join("");
    const card = hash.closest(".card")!;
    let busy = false;
    const scramble = async () => {
      if (busy) return;
      busy = true;
      for (let i = 0; i < 14; i++) {
        hash.textContent = `${rnd(4)}…${rnd(4)}`;
        await sleep(45);
      }
      busy = false;
    };
    card.addEventListener("pointerenter", scramble);
    new IntersectionObserver(([e]) => e.isIntersecting && scramble()).observe(card);
  }
}

// ------------------------------------------------------------------ reveal
export function initReveal(): void {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  $$("[data-reveal]").forEach((el) => io.observe(el));
}

// ------------------------------------------------------------------ faq
export function initFaq(): void {
  $$<HTMLDetailsElement>(".faq details").forEach((d) => {
    const sum = $("summary", d)!;
    const body = $(".faq-a", d)!;
    sum.addEventListener("click", (e) => {
      if (reducedMotion()) return;
      e.preventDefault();
      if (d.open) {
        const a = body.animate([{ height: `${body.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 280, easing: "ease-in" });
        a.onfinish = () => (d.open = false);
      } else {
        d.open = true;
        body.animate([{ height: "0px", opacity: 0 }, { height: `${body.offsetHeight}px`, opacity: 1 }], { duration: 380, easing: "cubic-bezier(.22,1,.36,1)" });
      }
    });
  });
}

// ------------------------------------------------------------------ video
export function initVideo(): void {
  const frame = $("#video-frame")!;
  const video = $<HTMLVideoElement>("#intro-video")!;
  const play = $("#video-play")!;
  // The poster loads only once the section comes near, not with the first screen.
  const near = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      near.disconnect();
      video.poster = SITE.video.poster;
      frame.style.backgroundImage = `url("${SITE.video.poster}")`;
    },
    { rootMargin: "800px 0px" },
  );
  near.observe(frame);

  // Quality: 720p (about a third of the size) on phones and slow connections,
  // 1080p on desktops; either way the other one is a tap away.
  type Q = "sd" | "hd";
  const qBtns = $$<HTMLButtonElement>("#video-q button");
  let q: Q = finePointer() && !isNarrow() && !slowNetwork() ? "hd" : "sd";
  const url = () => (q === "hd" ? SITE.video.src : SITE.video.srcSd);
  const markQ = () =>
    qBtns.forEach((b) => {
      b.classList.toggle("is-on", b.dataset.q === q);
      b.setAttribute("aria-pressed", String(b.dataset.q === q));
    });
  markQ();
  qBtns.forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.q === q) return;
      q = b.dataset.q as Q;
      markQ();
      if (!video.getAttribute("src")) return;
      // switch mid-film: keep the position and the playing state
      const at = video.currentTime;
      const playing = !video.paused;
      video.src = url();
      video.currentTime = at;
      if (playing) video.play().catch(() => {});
    }),
  );

  play.addEventListener("click", () => {
    if (!video.getAttribute("src")) video.src = url();
    frame.classList.add("is-playing");
    video.play().catch(() => {
      frame.classList.remove("is-playing");
      toast(t("视频暂时无法播放", "The video can't play right now"));
    });
  });
  video.addEventListener("pause", () => {
    if (video.ended) frame.classList.remove("is-playing");
  });
}

// ------------------------------------------------------------------ nav
export function initNav(): void {
  const nav = $("#nav")!;
  let lastY = window.scrollY;
  const onScroll = () => {
    const y = window.scrollY;
    nav.classList.toggle("is-scrolled", y > 24);
    nav.classList.toggle("is-hidden", y > 600 && y > lastY + 4);
    if (y < lastY - 4 || y < 600) nav.classList.remove("is-hidden");
    lastY = y;
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  const links = $$<HTMLAnchorElement>(".nav-links a");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) links.forEach((a) => a.classList.toggle("is-current", a.getAttribute("href") === `#${e.target.id}`));
    },
    { rootMargin: "-45% 0px -50% 0px" },
  );
  ["how", "views", "assistant", "deploy", "faq"].forEach((id) => {
    const s = document.getElementById(id);
    if (s) io.observe(s);
  });
}
