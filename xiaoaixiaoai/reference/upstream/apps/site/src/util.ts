export const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const finePointer = (): boolean => matchMedia("(hover: hover) and (pointer: fine)").matches;
export const isNarrow = (): boolean => matchMedia("(max-width: 900px)").matches;

type Conn = { saveData?: boolean; effectiveType?: string };
const conn = (): Conn | undefined => (navigator as Navigator & { connection?: Conn }).connection;
/** Data saver on, or the browser rates the connection 3G or slower (Chromium only). */
export const slowNetwork = (): boolean => !!conn()?.saveData || /2g|3g/.test(conn()?.effectiveType ?? "");

/** Run `fn` once the page has loaded and the main thread is idle. */
export function afterLoad(fn: () => void): void {
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(() => fn(), { timeout: 1500 }) : setTimeout(fn, 300));
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

export function h(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export class Aborted extends Error {}

/** With reduced motion, scenarios run once with no waiting to reach their end state. */
let instant = false;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (instant) return signal?.aborted ? Promise.reject(new Aborted()) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted());
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new Aborted());
      },
      { once: true },
    );
  });
}

/**
 * Run an async scenario over and over while `el` is on screen. Leaving the
 * viewport (or calling restart) aborts the current run; coming back starts over.
 */
export function loopWhileVisible(
  el: Element,
  scenario: (signal: AbortSignal) => Promise<void>,
  opts: { rootMargin?: string } = {},
): { restart: () => void; setEnabled: (on: boolean) => void } {
  let ctrl: AbortController | null = null;
  let visible = false;
  let enabled = true;

  const stop = () => {
    ctrl?.abort();
    ctrl = null;
  };
  const start = () => {
    stop();
    if (!visible || !enabled) return;
    const c = new AbortController();
    ctrl = c;
    if (reducedMotion()) {
      // Jump straight to the end state once, without looping.
      instant = true;
      scenario(c.signal)
        .catch(() => {})
        .finally(() => (instant = false));
      return;
    }
    (async () => {
      while (!c.signal.aborted) {
        try {
          await scenario(c.signal);
        } catch (e) {
          if (e instanceof Aborted) return;
          console.error(e);
          return;
        }
      }
    })();
  };
  const io = new IntersectionObserver(
    ([e]) => {
      const v = e.isIntersecting;
      if (v === visible) return;
      visible = v;
      if (v) start();
      else stop();
    },
    { rootMargin: opts.rootMargin ?? "0px" },
  );
  io.observe(el);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (visible) start();
  });
  return {
    restart: start,
    setEnabled(on: boolean) {
      enabled = on;
      if (on) start();
      else stop();
    },
  };
}

/** Type text into an element one character at a time. */
export async function typeInto(el: HTMLElement, text: string, signal: AbortSignal, cps = 22): Promise<void> {
  if (instant) {
    el.textContent = text;
    return;
  }
  const chars = Array.from(text);
  el.textContent = "";
  for (let i = 0; i < chars.length; i++) {
    el.textContent += chars[i];
    await sleep(1000 / cps + (Math.random() * 30 - 10), signal);
  }
}

/** A QR-looking pixel pattern (decorative; it encodes nothing). */
export function fakeQr(n: number, seed = 7): boolean[] {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const cells: boolean[] = [];
  const finder = (x: number, y: number, ox: number, oy: number) => {
    const dx = x - ox;
    const dy = y - oy;
    if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return null;
    const edge = dx === 0 || dy === 0 || dx === 6 || dy === 6;
    const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
    return edge || core;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const f = finder(x, y, 0, 0) ?? finder(x, y, n - 7, 0) ?? finder(x, y, 0, n - 7);
      if (f !== null) cells.push(f);
      else if ((x === 7 || y === 7 || x === n - 8 || y === n - 8) && (x < 8 || y < 8) && (x < 8 || x > n - 9)) cells.push(false);
      else cells.push(rnd() > 0.52);
    }
  }
  return cells;
}

export function renderQr(el: HTMLElement, n: number, seed?: number): void {
  el.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  el.innerHTML = fakeQr(n, seed)
    .map((on) => (on ? "<i></i>" : '<i class="o"></i>'))
    .join("");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    return ok;
  }
}

let toastTimer = 0;
export function toast(msg: string): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("is-on"), 1800);
}
