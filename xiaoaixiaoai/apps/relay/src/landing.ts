/**
 * Landing pages behind the QR codes: `/p/<code>` (an invite) and `/j/<id>` (a join request).
 * A phone camera opens them in the browser; the page hands the same data to the app through
 * an Android intent and shows the code for typing it in. APK downloads stay unavailable
 * until this app has an owned release source.
 *
 * The pages only echo what is already in the URL: they never look the code or request up,
 * so they tell nobody whether a code is valid, who made it, or when it expires.
 */
import { randomBytes } from "node:crypto";
import { APP_DISPLAY_NAME, APP_PACKAGE_ID, APP_SCHEME, RELEASES_PAGE, RELEASE_UPDATES_ENABLED, joinAppLink, pairAppLink, pairLink } from "@xiaoaixiaoai/protocol";
import { LOGO_SVG } from "./logo.ts";

export interface LandingPage {
  html: string;
  headers: Record<string, string>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const bare = (url: string) => url.replace(/^https?:\/\//i, "");

/** Target only our Android package; a download fallback exists only for an owned release source. */
function intentUrl(appLink: string): string {
  const rest = appLink.slice(`${APP_SCHEME}://`.length);
  const fallback = RELEASE_UPDATES_ENABLED && RELEASES_PAGE ? `S.browser_fallback_url=${encodeURIComponent(RELEASES_PAGE)};` : "";
  return `intent://${rest}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE_ID};${fallback}end`;
}

export function pairLanding(server: string, code: string): LandingPage {
  const app = pairAppLink(server, code);
  return page({
    title: `连接 ${APP_DISPLAY_NAME}`,
    lead: `有人邀请这台手机连到 ${APP_DISPLAY_NAME}。装好 App 后点下面的按钮，就能直接连上。`,
    open: intentUrl(app),
    manual: `
      <section class="manual">
        <div class="label">打不开时，在 App 首页手动输入</div>
        <div class="row"><span class="k">配对码</span><code class="code">${esc(code)}</code><button type="button" data-copy="${esc(code)}">复制</button></div>
        <div class="row"><span class="k">服务器</span><code>${esc(bare(server))}</code><button type="button" data-copy="${esc(server)}">复制</button></div>
        <button type="button" class="link" data-copy="${esc(pairLink(server, code))}">复制整条邀请链接（App 里可以直接粘贴）</button>
      </section>`,
    tips: ["邀请码只能用一次，过一会儿就会失效。只在你自己的设备上打开它。"],
  });
}

export function joinLanding(server: string, id: string): LandingPage {
  const app = joinAppLink(server, id);
  return page({
    title: "有设备想加入",
    lead: `一台新设备正在等你放行。用已经连上的手机打开 ${APP_DISPLAY_NAME} 确认，看清是你自己的设备再点允许。`,
    open: intentUrl(app),
    manual: `
      <section class="manual">
        <div class="label">也可以这样</div>
        <p class="plain">在已经连上的手机上打开 ${esc(APP_DISPLAY_NAME)}，点“设备 → 扫一扫”，扫那台设备上显示的二维码。</p>
      </section>`,
    tips: ["这个请求几分钟后就会失效，失效了让对方重新显示二维码。"],
  });
}

export function notFoundLanding(): LandingPage {
  return page({
    title: "这个链接不完整",
    lead: "让对方重新显示一次二维码，或者重新发一次邀请链接。",
    tips: [],
  });
}

function page(o: { title: string; lead: string; open?: string; manual?: string; tips: string[] }): LandingPage {
  const nonce = randomBytes(12).toString("base64");
  const download = RELEASE_UPDATES_ENABLED && RELEASES_PAGE
    ? `<a class="ghost" href="${esc(RELEASES_PAGE)}" rel="noreferrer noopener">还没装？下载安卓 App</a>`
    : `<p class="lead">尚未配置 ${esc(APP_DISPLAY_NAME)} 的发布源，下载已停用。请向此服务的管理者索取安装包。</p>`;
  const actions = o.open
    ? `
      <a class="btn" href="${esc(o.open)}">用 ${esc(APP_DISPLAY_NAME)} 打开</a>
      ${download}`
    : "";
  const tips = [
    ...(o.open ? ["在微信、QQ 里点了没反应？点右上角的“…”，选“在浏览器打开”。"] : []),
    ...o.tips,
  ];
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(o.title)} · ${esc(APP_DISPLAY_NAME)}</title>
<style>
:root{--page:#FBF4FC;--top:#FFF6F9;--bottom:#F7F2FF;--surface:#FFFFFF;--surface2:#FFF9FB;--ink:#4A3B5C;--muted:#6E6280;--faint:#746A83;--divider:#F1E4EC;--primary:#FF8FB3;--onPrimary:#4A3B5C;--accent:#B8336A;--chip:#FFE3EC;--shadow:rgba(229,138,174,.22)}
@media (prefers-color-scheme:dark){:root{--page:#1E1A26;--top:#221D2B;--bottom:#1E1A26;--surface:#27212F;--surface2:#312A3B;--ink:#F3EDF7;--muted:#CFC5DA;--faint:#A79DB5;--divider:#3A3246;--primary:#FF7EA8;--onPrimary:#1E1A26;--accent:#FF9DBD;--chip:#4A2B3A;--shadow:rgba(0,0,0,.3)}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:linear-gradient(180deg,var(--top),var(--bottom));color:var(--ink);font:16px/1.6 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;display:flex;justify-content:center;padding:32px 18px 40px}
main{width:100%;max-width:420px;display:flex;flex-direction:column;gap:16px}
.logo{width:96px;height:96px;margin:4px auto 0;border-radius:28px;overflow:hidden;box-shadow:0 10px 26px var(--shadow)}
.logo svg{width:100%;height:100%;display:block}
h1{margin:6px 0 0;text-align:center;font-size:24px;line-height:1.35;font-weight:700}
.lead{margin:0;text-align:center;color:var(--muted);font-size:15px}
.btn,.ghost{display:block;text-align:center;text-decoration:none;border-radius:999px;font-weight:700}
.btn{background:var(--primary);color:var(--onPrimary);font-size:17px;padding:15px 18px;margin-top:6px;box-shadow:0 8px 20px var(--shadow)}
.ghost{color:var(--accent);font-size:15px;padding:10px}
.manual{background:var(--surface);border-radius:20px;padding:16px 16px 10px;box-shadow:0 6px 18px var(--shadow);display:flex;flex-direction:column;gap:10px}
.label{color:var(--faint);font-size:13px}
.plain{margin:0 0 6px;color:var(--muted);font-size:14.5px}
.row{display:flex;align-items:center;gap:10px;background:var(--surface2);border:1px solid var(--divider);border-radius:14px;padding:8px 8px 8px 12px}
.k{color:var(--faint);font-size:13px;flex:none}
code{flex:1;min-width:0;overflow-wrap:anywhere;font:15px/1.4 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:var(--ink)}
code.code{font-size:22px;letter-spacing:2px;font-weight:700}
button{font:inherit;cursor:pointer}
.row button{flex:none;border:0;background:var(--chip);color:var(--accent);font-size:13.5px;font-weight:700;border-radius:999px;padding:6px 12px}
button.link{border:0;background:none;color:var(--accent);font-size:13.5px;padding:6px 0;text-align:left}
.tips{display:flex;flex-direction:column;gap:6px;margin:4px 2px 0;padding:0;list-style:none}
.tips li{color:var(--faint);font-size:13px;line-height:1.55}
.brand{text-align:center;color:var(--faint);font-size:12.5px;margin-top:6px}
</style>
</head>
<body>
<main>
  <div class="logo" aria-hidden="true">${LOGO_SVG}</div>
  <h1>${esc(o.title)}</h1>
  <p class="lead">${esc(o.lead)}</p>${actions}${o.manual ?? ""}
  ${tips.length ? `<ul class="tips">${tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
  <div class="brand">${esc(APP_DISPLAY_NAME)}</div>
</main>
<script nonce="${nonce}">
document.addEventListener("click",function(e){
  var b=e.target.closest&&e.target.closest("[data-copy]");if(!b)return;
  var text=b.getAttribute("data-copy"),label=b.textContent;
  function done(ok){b.textContent=ok?"已复制":"复制不了，请长按选中";setTimeout(function(){b.textContent=label},1600)}
  function legacy(){var t=document.createElement("textarea");t.value=text;t.setAttribute("readonly","");t.style.position="fixed";t.style.opacity="0";document.body.appendChild(t);t.select();var ok=false;try{ok=document.execCommand("copy")}catch(_){}document.body.removeChild(t);done(ok)}
  if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(text).then(function(){done(true)},legacy);else legacy();
});
</script>
</body>
</html>`;
  return {
    html,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  };
}
