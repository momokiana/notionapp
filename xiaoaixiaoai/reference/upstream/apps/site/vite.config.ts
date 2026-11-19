import { defineConfig, type Plugin } from "vite";
import { SITE } from "./src/config";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Bake links, commands and the example server from src/config.ts into the HTML,
// so they are right without JavaScript and for crawlers. main.ts fills the same
// values at runtime, so config.ts stays the only place to edit.
const inlineConfig = (): Plugin => ({
  name: "inline-config",
  transformIndexHtml(html) {
    return html
      .replace(/href="#" data-href="(\w+)"/g, (m, key: keyof typeof SITE) =>
        typeof SITE[key] === "string" ? `href="${esc(SITE[key] as string)}" data-href="${key}"` : m,
      )
      .replace(/data-cmd="(\w+)"([\s\S]*?)<code class="cmd-text"><\/code>/g, (m, key: keyof typeof SITE.commands, mid: string) =>
        key in SITE.commands ? `data-cmd="${key}"${mid}<code class="cmd-text">${esc(SITE.commands[key])}</code>` : m,
      )
      .replaceAll("{server}", SITE.server);
  },
});

// Social cards need absolute URLs. Set SITE_URL=https://your.domain/path/ at
// build time to rewrite og:image and add a canonical link; without it the
// relative path is kept.
const absoluteOg = (): Plugin => ({
  name: "absolute-og",
  transformIndexHtml(html) {
    const url = process.env.SITE_URL;
    if (!url) return html;
    const base = url.endsWith("/") ? url : `${url}/`;
    return html
      .replace('content="og.jpg"', `content="${base}og.jpg"`)
      .replace("<head>", `<head>\n    <link rel="canonical" href="${base}" />`);
  },
});

// SITE_BASE controls the public path. The default "./" makes every URL relative,
// so the same build works on Cloudflare Pages (served at "/") and on GitHub
// Pages project sites (served at "/<repo>/"). Set SITE_BASE=/sub/path/ to pin it.
export default defineConfig({
  base: process.env.SITE_BASE ?? "./",
  plugins: [inlineConfig(), absoluteOg()],
  build: {
    target: "es2022",
    assetsInlineLimit: 2048,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: { three: ["three"], gsap: ["gsap", "lenis"] },
      },
    },
  },
  server: { host: "127.0.0.1", port: 5180 },
  preview: { host: "127.0.0.1", port: 5181 },
});
