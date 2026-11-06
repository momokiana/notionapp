import { fixture } from './fixture.mjs';
import { preview } from 'vite';
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
// Default local production build: explicitly matches its embedded fixed upstream.
const f=await fixture(4318), server=await preview({preview:{port:0,strictPort:false}});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE??'/home/gamedev/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',env:{...process.env,LD_LIBRARY_PATH:process.env.CHROMIUM_LIBS??'/home/gamedev/.cache/notionapp-t006/host-libs/usr/lib/x86_64-linux-gnu'},args:['--no-sandbox']});
try {
  const created=await f.create('生产构建的真实回应闭环'),page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));const origin='http://127.0.0.1:'+server.httpServer.address().port;
  await page.goto(origin);await page.getByLabel('我已确认此浏览器没有需要恢复的未决提交').check();await page.getByRole('button',{name:'建立本机提交账本',exact:true}).click();await page.getByText('提交账本可用，原意图先持久化再发送').waitFor();
  await page.getByLabel('用户设备凭据',{exact:true}).fill(f.userToken);await page.getByRole('button',{name:'连接事件服务',exact:true}).click();await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();await page.getByRole('button').filter({has:page.getByText('生产构建的真实回应闭环',{exact:true})}).click();
  await page.getByLabel('继续处理',{exact:true}).check();await page.screenshot({path:resolve('../docs/evidence/web-001-production-question.png'),fullPage:true});await page.getByRole('button',{name:'提交回应',exact:true}).click();await page.getByText(/服务已保存，当前结果已刷新/).waitFor();
  await f.update(created.event_id,'生产静态构建已通过真实API保存，隔离来源追加结果；没有原生输入或模型。');await page.getByRole('button',{name:'刷新当前事件',exact:true}).click();await page.locator('.event-body').filter({hasText:'生产静态构建已通过真实API保存'}).waitFor();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM responses').get().n,1);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve('../docs/evidence/web-001-production-mobile.png'),fullPage:true});
  const contrast=await page.evaluate(()=>{
    const style=getComputedStyle(document.documentElement),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
    const lum=token=>{ctx.fillStyle=style.getPropertyValue(token);ctx.fillRect(0,0,1,1);const rgb=[...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;});return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;};
    const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
    return {body:ratio('--ink','--bg'),secondary:ratio('--muted','--surface'),primaryButton:ratio('--primary','--bg'),error:ratio('--error','--error-bg'),warning:ratio('--warning','--warning-bg')};
  });for(const ratio of Object.values(contrast))assert.ok(ratio>=4.5);
  const result={browser:await browser.version(),viewport:{width:390,height:844},staticBuild:true,fixtureRoot:f.root,eventId:created.event_id,response:f.db.prepare('SELECT id,event_id FROM responses').get(),history:f.db.prepare('SELECT kind FROM history ORDER BY seq').all(),pageErrors:errors,textContrastRatios:contrast};
  writeFileSync('../docs/evidence/web-001-production.json',JSON.stringify(result,null,2));console.log('Production static build + real Fastify/disk SQLite button/save/source-result refresh PASS. No native/model/push.');
} finally {await browser.close();await new Promise(r=>server.httpServer.close(r));await f.close();}
