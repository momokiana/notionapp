// "How it works": computers -> relay -> phone, driven by scroll.
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { t, onLang } from "./i18n";
import { $, $$, reducedMotion, isNarrow } from "./util";
import type Lenis from "lenis";

const NS = "http://www.w3.org/2000/svg";

interface Path {
  track: SVGPathElement;
  lit: SVGPathElement;
  len: number;
  packets: SVGCircleElement[];
}

export function initFlow(lenis: Lenis | null): void {
  const section = $("#how")!;
  const pin = $(".flow-pin", section)!;
  const diagram = $("#flow-diagram")!;
  const svg = $<SVGSVGElement>("#flow-svg")!;
  const steps = $$(".flow-step", section);
  const computers = $$(".computer", diagram);
  const relay = $(".relay", diagram)!;
  const phone = $(".phone-node", diagram)!;
  const mini = $("#mini-list")!;
  const still = reducedMotion();

  const rows = () => [
    ["claude-code", "web-shop", "work"],
    ["codex", "docs-site", "wait"],
    ["gemini", "api-gateway", "work"],
    ["opencode", "mobile-app", "idle"],
    ["kimi", "data-report", "done"],
    ["qwen", "infra", "work"],
  ];
  const renderMini = () => {
    mini.innerHTML =
      `<div style="font-weight:900;font-size:12px;margin:0 2px 2px">${t("全部 agent", "All agents")}</div>` +
      rows()
        .map(([v, n, s]) => `<div class="mini-row"><img src="assets/vendors/${v}.webp" alt="" /><span>${n}</span><i class="${s}"></i></div>`)
        .join("");
  };
  renderMini();
  onLang(() => {
    renderMini();
    apply(progress, true);
  });

  let paths: Path[] = [];
  let reverse: SVGCircleElement[] = [];

  const center = (el: Element) => {
    const d = diagram.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - d.left + r.width / 2, y: r.top - d.top + r.height / 2, w: r.width, h: r.height, l: r.left - d.left, t: r.top - d.top };
  };

  const build = () => {
    svg.innerHTML = "";
    const defs = document.createElementNS(NS, "defs");
    const dw = diagram.clientWidth;
    const dh = diagram.clientHeight;
    // userSpaceOnUse: a perfectly straight path has a zero-height bounding box,
    // which would make an objectBoundingBox gradient (and the stroke) vanish.
    defs.innerHTML = isNarrow()
      ? `<linearGradient id="flow-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${dh}"><stop offset="0" stop-color="#f27ba6"/><stop offset="1" stop-color="#b9a2f5"/></linearGradient>`
      : `<linearGradient id="flow-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${dw}" y2="0"><stop offset="0" stop-color="#f27ba6"/><stop offset="1" stop-color="#b9a2f5"/></linearGradient>`;
    svg.appendChild(defs);
    const narrow = isNarrow();
    const rc = center(relay.querySelector(".relay-core")!);
    const mk = (d: string, n: number, color: string): Path => {
      const track = document.createElementNS(NS, "path");
      track.setAttribute("d", d);
      track.setAttribute("class", "track");
      const lit = document.createElementNS(NS, "path");
      lit.setAttribute("d", d);
      lit.setAttribute("class", "lit");
      svg.append(track, lit);
      const len = lit.getTotalLength();
      lit.style.strokeDasharray = `${len}`;
      lit.style.strokeDashoffset = `${len}`;
      const packets: SVGCircleElement[] = [];
      for (let i = 0; i < n; i++) {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("r", "4.5");
        c.setAttribute("fill", color);
        c.setAttribute("class", "packet");
        c.style.opacity = "0";
        svg.appendChild(c);
        packets.push(c);
      }
      return { track, lit, len, packets };
    };
    paths = computers.map((c, i) => {
      const b = center(c);
      const sx = narrow ? b.x : b.l + b.w;
      const sy = narrow ? b.t + b.h : b.y;
      const ex = narrow ? rc.x : rc.x - 40;
      const ey = narrow ? rc.y - 40 : rc.y;
      const d = narrow
        ? `M${sx},${sy} C${sx},${sy + 60} ${ex},${ey - 60} ${ex},${ey}`
        : `M${sx},${sy} C${sx + 90},${sy} ${ex - 90},${ey} ${ex},${ey}`;
      return mk(d, 3, ["#f27ba6", "#b9a2f5", "#2e8a6a"][i]);
    });
    const p = center(phone.querySelector(".mini-phone")!);
    const sx = narrow ? rc.x : rc.x + 40;
    const sy = narrow ? rc.y + 40 : rc.y;
    const ex = narrow ? p.x : p.l;
    const ey = narrow ? p.t : p.y;
    const d = narrow ? `M${sx},${sy} C${sx},${sy + 50} ${ex},${ey - 50} ${ex},${ey}` : `M${sx},${sy} C${sx + 70},${sy} ${ex - 70},${ey} ${ex},${ey}`;
    paths.push(mk(d, 4, "#f27ba6"));
    reverse = [];
    for (let i = 0; i < 3; i++) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("r", "5");
      c.setAttribute("fill", "#7a5cc8");
      c.setAttribute("class", "packet");
      c.style.opacity = "0";
      svg.appendChild(c);
      reverse.push(c);
    }
    apply(progress, true);
  };

  let progress = still ? 1 : 0;
  let stage = -1;

  const apply = (p: number, force = false) => {
    progress = p;
    const s = Math.min(3, Math.floor(p * 4));
    const local = p * 4 - s;
    // computers in
    const cIn = Math.min(1, p * 4 * 1.4);
    computers.forEach((c, i) => {
      const k = Math.min(1, Math.max(0, cIn * 1.4 - i * 0.2));
      c.style.opacity = String(0.25 + 0.75 * k);
      c.classList.toggle("is-hot", s === 0 || s === 3);
    });
    // computer -> relay paths
    const a = s >= 1 ? 1 : 0;
    const drawA = s === 1 ? Math.min(1, local * 1.6) : a;
    for (let i = 0; i < 3; i++) paths[i] && (paths[i].lit.style.strokeDashoffset = String(paths[i].len * (1 - drawA)));
    relay.classList.toggle("is-hot", s >= 1);
    relay.style.opacity = s >= 1 ? "1" : "0.45";
    // relay -> phone
    const drawB = s === 2 ? Math.min(1, local * 1.6) : s > 2 ? 1 : 0;
    const pb = paths[3];
    if (pb) pb.lit.style.strokeDashoffset = String(pb.len * (1 - drawB));
    phone.style.opacity = s >= 2 ? "1" : "0.45";
    phone.classList.toggle("is-hot", s >= 2);
    const mrows = $$(".mini-row", mini);
    const shown = s < 2 ? 0 : s === 2 ? Math.floor(Math.min(1, local * 1.5) * mrows.length + 0.5) : mrows.length;
    mrows.forEach((r, i) => r.classList.toggle("is-in", i < shown));
    if (s !== stage || force) {
      stage = s;
      steps.forEach((st, i) => st.classList.toggle("is-active", i === s));
    }
  };

  // packets animation, only while the diagram is on screen
  let tPrev = performance.now();
  let clock = 0;
  let raf = 0;
  const animate = (now: number) => {
    const dt = Math.min(0.1, (now - tPrev) / 1000);
    tPrev = now;
    clock += dt;
    const s = Math.min(3, Math.floor(progress * 4));
    paths.forEach((p, pi) => {
      const on = pi < 3 ? s >= 1 : s >= 2;
      p.packets.forEach((c, k) => {
        if (!on) {
          c.style.opacity = "0";
          return;
        }
        const f = (clock * (pi < 3 ? 0.42 : 0.55) + k / p.packets.length + pi * 0.13) % 1;
        const pt = p.lit.getPointAtLength(f * p.len);
        c.setAttribute("cx", pt.x.toFixed(1));
        c.setAttribute("cy", pt.y.toFixed(1));
        c.style.opacity = String(Math.sin(f * Math.PI) * 0.95);
      });
    });
    // step 4: commands travel phone -> relay -> computer
    reverse.forEach((c, k) => {
      if (s < 3 || !paths[3]) {
        c.style.opacity = "0";
        return;
      }
      const f = (clock * 0.32 + k / reverse.length) % 1;
      const target = paths[k % 3];
      let pt: DOMPoint;
      if (f < 0.5) {
        const g = 1 - f / 0.5;
        pt = paths[3].lit.getPointAtLength(g * paths[3].len);
      } else {
        const g = 1 - (f - 0.5) / 0.5;
        pt = target.lit.getPointAtLength(g * target.len);
      }
      c.setAttribute("cx", pt.x.toFixed(1));
      c.setAttribute("cy", pt.y.toFixed(1));
      c.style.opacity = String(Math.sin(f * Math.PI) * 0.6 + 0.35);
    });
    raf = requestAnimationFrame(animate);
  };
  new IntersectionObserver(([e]) => {
    cancelAnimationFrame(raf);
    if (e.isIntersecting && !still) {
      tPrev = performance.now();
      raf = requestAnimationFrame(animate);
    }
  }).observe(diagram);

  build();
  let rt = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = window.setTimeout(build, 120);
  });

  if (still) {
    section.classList.add("is-static");
    steps.forEach((s) => s.classList.add("is-active"));
    apply(1, true);
    steps.forEach((s) => s.classList.add("is-active"));
    return;
  }

  const st = ScrollTrigger.create({
    trigger: section,
    pin,
    start: "top top",
    end: () => `+=${window.innerHeight * 2.6}`,
    scrub: 0.6,
    anticipatePin: 1,
    invalidateOnRefresh: true,
    onUpdate: (self) => apply(Math.min(0.999, self.progress)),
    onRefresh: () => build(),
  });

  steps.forEach((el, i) => {
    el.addEventListener("click", () => {
      const y = st.start + (st.end - st.start) * ((i + 0.5) / 4);
      if (lenis) lenis.scrollTo(y, { duration: 1.2 });
      else window.scrollTo({ top: y, behavior: "smooth" });
    });
  });
}
