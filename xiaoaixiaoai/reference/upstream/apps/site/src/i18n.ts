import { SITE, type Lang } from "./config";

// Chinese is the source language and lives in index.html; English lives here.
// At boot the Chinese markup is captured from the DOM so switching back is lossless.
const en: Record<string, string> = {
  "nav.skip": "Skip to content",
  "nav.how": "How it works",
  "nav.views": "Features",
  "nav.assistant": "Assistant",
  "nav.deploy": "Deploy",
  "nav.faq": "FAQ",
  "hero.pill": "Open source · Self-hosted · Android",
  "hero.title": "All your coding agents,<br /><em>in your pocket.</em>",
  "hero.sub":
    "Herdr Pocket connects the Claude Code, Codex, Gemini, OpenCode… sessions running in herdr to your Android phone: live status, readable conversations, a real terminal. Xiaoyang, the assistant, keeps watch and tells you the moment something finishes or gets stuck.",
  "hero.cta1": "View on GitHub",
  "hero.cta2": "Watch the 90-second intro",
  "ui.copy": "Copy",
  "vendors.title": "If it runs in herdr, it shows up in your pocket",
  statement:
    "You don't have to babysit your desk. When an agent finishes, gets stuck, or waits for your OK, your pocket knows first. Glance, reply, hit enter, and the work keeps moving.",
  "how.eyebrow": "How it works",
  "how.title": "Computers → relay → phone, one live line",
  "how.s1.t": "Agents keep running on every computer",
  "how.s1.d":
    "Run your agents in herdr like always. Each computer runs <code>herdr-pocket up</code> once; the daemon reads local agents and publishes snapshots.",
  "how.s2.t": "Your own relay",
  "how.s2.d":
    "The relay runs on your server: long-lived WebSockets with compression. Device tokens are stored only as hashes, and agent ownership is rewritten from the connection identity, so no computer can impersonate another.",
  "how.s3.t": "The phone sees everything, live",
  "how.s3.d":
    "Pair the phone once with a QR code and every agent on every computer appears in one list. Conversations and terminals stream live, with polling as automatic recovery.",
  "how.s4.t": "And you steer from your pocket",
  "how.s4.d":
    "Reply, press Esc, start a new agent, or just hand it to Xiaoyang: commands travel back the same way. Computers can call each other's agents from the CLI, with read-only mode and device allowlists when you want them.",
  "how.pc2": "Linux workstation",
  "how.pc3": "Cloud VM",
  "how.relay": "Relay",
  "views.eyebrow": "Four views in your pocket",
  "views.title": "See it all at a glance, take over in one tap",
  "views.list.k": "Agent list",
  "views.list.t": "Every computer, sorted by what needs you",
  "views.list.d":
    "Needs you, working, done, idle: grouped on one screen. Each agent wears its own avatar so Claude Code and Codex are recognisable at a glance, with the computer and turn count beside it.",
  "views.chat.k": "Conversation",
  "views.chat.t": "A formatted conversation, not a wall of escape codes",
  "views.chat.d":
    "Tool calls fold into cards, failures stand out, thinking stays quietly in the background. To chime in, just reply like a chat.",
  "views.term.k": "Terminal",
  "views.term.t": "A real terminal you can type into",
  "views.term.d":
    "The live terminal screen, with typing that goes straight to the agent. A compact in-app keyboard puts Esc, Tab, arrows, Enter and Ctrl+C one tap away without the system keyboard covering the screen, so menus and interrupts never need the desk.",
  "views.pair.k": "Devices",
  "views.pair.t": "Scan once and a new computer joins",
  "views.pair.d":
    "On a new computer <code>herdr-pocket up</code> prints a QR code; scan it with a connected phone and tap Allow. Every QR is a plain https link any camera can open. Invite codes are single-use and expire after 10 minutes, and phones can invite phones too.",
  "as.eyebrow": "Xiaoyang, your assistant",
  "as.title": "Xiaoyang keeps watch <em>and gets things done</em>",
  "as.lead":
    "The first screen in the app is Xiaoyang. Say the word and she does it: messages an agent, presses keys, creates a space, or starts any installed agent on any computer with a task, then tells you what really happened. When an agent finishes or gets stuck, she lets you know first.",
  "as.p1.t": "Just ask",
  "as.p1.d": "“Who's waiting on me?” “What finished?” “What did today cost?” She checks every computer, then answers, with costs split by agent, space or computer.",
  "as.p2.t": "She reaches out",
  "as.p2.d":
    "When an agent finishes or gets stuck she messages you; ask her to watch one and she calls you when it's done. Alerts land in the notification shade even with the app closed, over a persistent connection on the phone, not Google push.",
  "as.p3.t": "She remembers, and digs in",
  "as.p3.d": "“Remind me to check the deploy in half an hour.” And when something breaks, ask “where did it get stuck?”: she reads the relay, computer and phone logs.",
  "as.p4.t": "She just does it, and tells it straight",
  "as.p4.d":
    "Sending text, pressing keys, creating a space, starting any installed agent (Claude Code, Codex, Gemini, Kimi…): she does it, then tells you how it really went, like “Sent, no reply yet” or “It's busy, so it's queued in the input box.” Rather be asked first? Turn it on in settings; it's off by default.",
  "as.p5.t": "Bring your own model",
  "as.p5.d": "Anthropic, or any OpenAI-compatible service: DeepSeek, Qwen, Kimi, GLM, OpenRouter, or a local Ollama.",
  "call.eyebrow": "Voice calls",
  "call.title": "Too lazy to type?<br />Give Xiaoyang a call.",
  "call.lead":
    "Real-time voice calls, powered by MOSS-Live by default with more realtime voice providers on the way. Ask “what finished?” on a walk; she checks, then tells you out loud. Audio goes through your own relay and the API key never leaves your server.",
  "call.hint": "Six faces follow the call state. Tap one to try it.",
  "ft.eyebrow": "Details",
  "ft.title": "The little things, already handled",
  "ft.cloud": "Cloud VM",
  "ft.1.t": "Many computers, one list",
  "ft.1.d": "Home, office and cloud machines each run their own agents; the phone merges them into one list and shows who is online.",
  "ft.2.t": "Compact in-app keyboard",
  "ft.2.d": "Esc, Tab, arrows and Ctrl+C one tap away, and the system keyboard no longer covers the terminal.",
  "ft.3.t": "No Google push needed",
  "ft.3.d": "A persistent connection delivers alerts directly; just allow background running on stricter Android skins.",
  "ft.4.t": "Tokens stored as hashes",
  "ft.4.d": "A device token is shown once at pairing; the server keeps only its SHA-256, and revoking disconnects immediately.",
  "ft.5.t": "One-time QR pairing",
  "ft.5.d": "Each QR is an https link any camera opens. Codes are single-use, expire in 10 minutes, and lock out after repeated failures.",
  "ft.6.t": "Computers call each other",
  "ft.6.d":
    "From one computer's terminal, read and steer the agents on another. <code>--read-only</code> allows viewing only; <code>--allow</code> limits control to chosen devices.",
  "ft.cli": "run the tests",
  "ft.7.t": "Deploy your way",
  "ft.7.d": "Docker, Cloudflare, or a single install command. Your server, your rules.",
  "ft.8.t": "In-app updates",
  "ft.8.d": "New versions arrive from GitHub Releases; one tap to update.",
  "ft.new": "New version",
  "ft.9.t": "Light and dark",
  "ft.9.d": "A soft pink interface that stays easy on the eyes at 2 a.m.",
  "ft.10.t": "Compressed in transit",
  "ft.10.d": "WebSocket compression makes terminal screens and conversations several times smaller on the wire.",
  "ft.11.t": "Know what it costs",
  "ft.11.d": "Xiaoyang breaks spending down by agent, space and computer.",
  "ft.12.t": "All the logs in one place",
  "ft.12.d": "Relay, computer and phone logs all collect on your relay. Query them with <code>herdr-pocket logs</code>, ask Xiaoyang “where did it get stuck?”, or open the simple <code>/admin</code> web dashboard on your relay.",
  "ft.13.k": "Ask before acting",
  "ft.13.t": "Rather confirm first? Fine",
  "ft.13.d": "By default she just acts. Turn on Ask before acting and she checks with you each time. Voice calls never stop to wait.",
  "video.eyebrow": "Intro film",
  "video.title": "Herdr Pocket in 90 seconds",
  "video.q": "Quality",
  "dp.eyebrow": "Get started",
  "dp.title": "Three steps to your own pocket",
  "dp.1.t": "Deploy the relay",
  "dp.1.d": "Pick one and run it on your own server; always use HTTPS in production. On first start the log prints a one-time setup QR code or setup code for your first phone.",
  "dp.1.fine": "Once it's running, open <code>https://{server}/admin</code> for the log dashboard.",
  "dp.tab.script": "Install script",
  "dp.2.t": "Bring each computer online",
  "dp.2.d": "This installs <code>herdr-pocket</code>, registers the computer with your relay and keeps it online. When a QR code appears in the terminal, scan it with your connected phone and tap Allow.",
  "dp.2.scan": "Scan this QR code with your phone",
  "dp.3.t": "Install the app",
  "dp.3.d": "Point the phone's camera at the relay's QR code to open a connect page. Install the app from GitHub Releases, tap the button on that page, and you're connected. Got only a setup code? Enter it in the app together with the server address. Future versions update from inside the app.",
  "dp.3.cta": "Download for Android",
  "dp.2.win": "On Windows, run this in PowerShell:",
  "dp.3.fine": "Requires herdr. On macOS and Linux the installer brings its own Node.js when there's no 22.18 or newer; on Windows it always does, and needs no administrator rights.",
  "faq.eyebrow": "FAQ",
  "faq.title": "Questions you might have",
  "faq.1.q": "Is there an iPhone app?",
  "faq.1.a": "Not yet; the app is Android only. Computers can be macOS, Linux or Windows; anything that runs herdr works.",
  "faq.2.q": "Which agents can I see?",
  "faq.2.a":
    "Anything running in herdr: Claude Code, Codex, Gemini, OpenCode, Kimi, Qwen, Cursor Agent, Droid, CodeBuddy, Qoder, omp, pi and more, plus plain terminal programs. Recognised agents get their own avatar. Xiaoyang can also start any agent CLI installed on a computer for you.",
  "faq.3.q": "Do I have to host a server?",
  "faq.3.a": "Yes. You deploy the relay yourself and your data only passes through your server. Docker Compose, the install script or Cloudflare Tunnel all work.",
  "faq.4.q": "Can the relay see my content?",
  "faq.4.a":
    "Yes. This version has no end-to-end encryption and the relay sees plaintext, so run it on a server you trust and always use HTTPS. Device tokens are stored only as hashes and can be revoked at any time.",
  "faq.5.q": "Does Xiaoyang act directly?",
  "faq.5.a":
    "Yes, when you ask. She sends text, presses keys, creates spaces and starts agents, then tells you the real result, like “Sent, no reply yet” or “It's busy, so it's queued in the input box.” To approve each action first, turn on Ask before acting in settings (off by default); during voice calls she never stops to wait. For a view-only phone, see the next question.",
  "faq.6.q": "Which models power the assistant and voice?",
  "faq.6.a":
    "The text assistant works with Anthropic or any OpenAI-compatible service (DeepSeek, Qwen, Kimi, GLM, OpenRouter, Ollama and others), configured on your server. Voice calls use MOSS-Live by default, with more realtime voice providers being added. Without them you simply have no assistant or voice; everything else works.",
  "faq.7.q": "Do alerts arrive when the app is closed?",
  "faq.7.a":
    "Yes. A persistent service on the phone stays connected to your relay, with no Google push involved. Some Android skins need you to allow background running.",
  "faq.8.q": "Can the phone watch without controlling?",
  "faq.8.a":
    "Yes. Run <code>herdr-pocket run --read-only</code> on a computer to allow viewing only, or <code>--allow</code> to let only chosen devices control it.",
  "faq.9.q": "Where do I look when something breaks?",
  "faq.9.a": "Logs from the relay, the computers and the phones all collect on your relay. Filter them by time, device or level with <code>herdr-pocket logs</code>, ask Xiaoyang “where did it get stuck?”, or open the simple <code>/admin</code> web dashboard on your relay.",
  "faq.10.q": "Can I modify it and use it?",
  "faq.10.a": "Yes, for personal and commercial use alike. Herdr Pocket is open source under AGPL-3.0: if you modify it and offer it as a service, you have to publish your changes.",
  "final.title": "Tonight, let the agents run in peace.",
  "final.lead": "Open source and self-hosted. Up and running in minutes.",
  "final.cta1": "Star on GitHub",
  "final.cta2": "Start deploying",
  "footer.tag": "Every coding agent on every computer, in your pocket.",
  "footer.project": "Project",
  "footer.releases": "Releases",
  "footer.issues": "Issues",
  "footer.learn": "Learn",
  "footer.note": "Herdr Pocket is open source and works together with herdr.",
};

const zh: Record<string, string> = {};
let current: Lang = "zh";
const listeners = new Set<(l: Lang) => void>();

function fill(html: string): string {
  return html.replaceAll("{server}", SITE.server);
}

export function initI18n(): Lang {
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n!;
    if (!(key in zh)) zh[key] = el.innerHTML.trim();
  }
  // Text with a {server} token outside data-i18n nodes.
  for (const el of document.querySelectorAll<HTMLElement>(".relay-label span")) el.textContent = fill(el.textContent ?? "");
  const l = document.documentElement.dataset.lang === "en" ? "en" : "zh";
  setLang(l, false);
  return l;
}

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang, persist = true): void {
  current = l;
  const root = document.documentElement;
  root.dataset.lang = l;
  root.lang = l === "zh" ? "zh-CN" : "en";
  const dict = l === "zh" ? zh : en;
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const v = dict[el.dataset.i18n!] ?? zh[el.dataset.i18n!];
    if (v != null && el.innerHTML !== v) el.innerHTML = fill(v);
  }
  document.title =
    l === "zh" ? "Herdr Pocket · 把所有电脑上的 coding agent 装进口袋" : "Herdr Pocket · Every coding agent, in your pocket";
  if (persist) {
    try {
      localStorage.setItem("hp-lang", l);
    } catch {}
  }
  for (const fn of listeners) fn(l);
}

export function onLang(fn: (l: Lang) => void): void {
  listeners.add(fn);
}

/** Pick a string for the current language. */
export function t(zhText: string, enText: string): string {
  return current === "zh" ? zhText : enText;
}
