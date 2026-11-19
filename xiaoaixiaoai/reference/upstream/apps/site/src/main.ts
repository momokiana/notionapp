import "./styles/base.css";
import "./styles/sections.css";
import "./styles/phone.css";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { initI18n, setLang, getLang, onLang } from "./i18n";
import { initHero } from "./hero";
import { initFlow } from "./flow";
import {
  initMarquee,
  initStatement,
  initViews,
  initAssistant,
  initCall,
  initCommands,
  initBento,
  initReveal,
  initFaq,
  initVideo,
  initNav,
  wrapTitleLines,
} from "./sections";
import { $, $$, afterLoad, finePointer, isNarrow, reducedMotion, slowNetwork } from "./util";

gsap.registerPlugin(ScrollTrigger);
document.documentElement.classList.add("js");

initI18n();

// ---- smooth wheel scrolling on mouse and trackpad (skipped for reduced motion).
// Touch screens keep native scrolling: Lenis does not smooth touch anyway, and
// native scrolling runs off the main thread, so it stays fluid while the page works.
let lenis: Lenis | null = null;
if (!reducedMotion() && finePointer()) {
  lenis = new Lenis({ lerp: 0.1, smoothWheel: true, anchors: { offset: -72 } });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis!.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
} else if (!reducedMotion()) {
  // the same gentle glide to in-page anchors that Lenis gives on desktop
  document.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
    const target = a && !a.classList.contains("skip") ? document.getElementById(a.hash.slice(1)) : null;
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: "smooth" });
  });
}

// ---- theme + language toggles
const themeMeta = () => document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
$("#theme-toggle")!.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("hp-theme", next);
  } catch {}
  themeMeta().forEach((m) => (m.content = next === "dark" ? "#1C1722" : "#FFF6F9"));
});
$("#lang-toggle")!.addEventListener("click", () => setLang(getLang() === "zh" ? "en" : "zh"));

// ---- hero title intro
const title = $(".hero-title")!;
const animateTitle = (first: boolean) => {
  const lines = wrapTitleLines(title);
  if (!first || reducedMotion()) return;
  gsap.from(lines, { yPercent: 110, duration: 1.1, ease: "expo.out", stagger: 0.12, delay: 0.1 });
  gsap.from([".hero-pill", ".hero-sub", ".hero-ctas", ".hero-cmd"], {
    y: 24,
    opacity: 0,
    duration: 0.9,
    ease: "power3.out",
    stagger: 0.08,
    delay: 0.35,
  });
  gsap.from("#stage", { scale: 0.86, opacity: 0, duration: 1.3, ease: "expo.out", delay: 0.2 });
};
animateTitle(true);
onLang(() => animateTitle(false));

// ---- pause the CSS loops of sections that are off screen (see .is-offscreen)
const offscreen = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.target.classList.toggle("is-offscreen", !e.isIntersecting)),
  { rootMargin: "200px 0px" },
);
$$("main > section, body > footer").forEach((s) => offscreen.observe(s));

initNav();
initHero();
initMarquee();
initStatement();
initFlow(lenis);
initViews();
initAssistant();
initCall();
initCommands();
initBento();
initReveal();
initFaq();
initVideo();

// ---- section headings: soft rise on enter
if (!reducedMotion()) {
  gsap.utils.toArray<HTMLElement>(".h2, .eyebrow, .lead").forEach((el) => {
    if (el.closest(".flow-pin") || el.closest(".hero")) return;
    gsap.from(el, {
      y: 30,
      opacity: 0,
      duration: 1,
      ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 88%", once: true },
    });
  });
  // the hero copy drifts up and fades as you leave
  gsap.to(".hero-copy", {
    yPercent: -12,
    opacity: 0.2,
    ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });
  gsap.to("#stage", {
    yPercent: 10,
    scale: 0.94,
    ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
  });
}

// ---- the 3D background: desktop-class devices only, after load, once the hero is on screen.
// Phones and small or weak machines keep the CSS gradient under #hero-canvas;
// the shader sky and glossy materials cost more GPU than they can spare.
const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
const desktopClass = finePointer() && !isNarrow() && (navigator.hardwareConcurrency || 4) >= 4 && memory >= 4;
const canWebGL = () => {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
};
if (desktopClass && !reducedMotion() && !slowNetwork() && canWebGL()) {
  afterLoad(() => {
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      import("./hero3d")
        .then((m) => m.startHero3D($("#hero-canvas")!))
        .catch((err) => console.warn("hero 3D disabled:", err));
    });
    io.observe($(".hero")!);
  });
}

window.addEventListener("load", () => ScrollTrigger.refresh());
document.fonts?.ready.then(() => ScrollTrigger.refresh());
