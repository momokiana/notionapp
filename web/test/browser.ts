// Real Chromium + real Fastify + disk SQLite. No mocks replace the product API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fixture, gateway } from './fixture.mjs';
const evidence = resolve(process.env.WEB_EVIDENCE ?? '../docs/evidence');
mkdirSync(evidence, { recursive: true });
const chromiumPath = process.env.CHROMIUM_EXECUTABLE ?? '/home/gamedev/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const libs = process.env.CHROMIUM_LIBS ?? '/home/gamedev/.cache/notionapp-t006/host-libs/usr/lib/x86_64-linux-gnu';

test('real Web event client acceptance', { timeout: 180000 }, async t => {
  const f = await fixture(), g = await gateway(f.origin);
  process.env.WEB_BACKEND = g.origin; process.env.WEB_INSTANCE = 'isolated-web-001';
  const vite = await createServer({ configFile: resolve('vite.config.ts'), server: { port: 0, strictPort: false } });
  await vite.listen();
  const origin = 'http://127.0.0.1:' + vite.httpServer!.address()!.port;
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath, env: { ...process.env, LD_LIBRARY_PATH: libs }, args: ['--no-sandbox'] });
  const errors: string[] = [], measurements: Record<string, unknown> = { browser: await browser.version(), node: process.version, platform: 'WSL2 desktop headless Chromium, not Android/WebView', fixtureRoot: f.root };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const p = await context.newPage(); p.setDefaultTimeout(12000); p.on('pageerror', error => errors.push(error.message));
  async function login(page = p, token = f.userToken, initialize = false) {
    await page.goto(origin);
    if (initialize) { await page.getByLabel('我已确认此浏览器没有需要恢复的未决提交').check(); await page.getByRole('button', {name:'建立本机提交账本',exact:true}).click(); await page.getByText('提交账本可用，原意图先持久化再发送').waitFor(); }
    await page.getByLabel('用户设备凭据',{exact:true}).fill(token); await page.getByRole('button',{name:'连接事件服务',exact:true}).click();
    await page.getByRole('heading',{name:'收件箱',exact:true}).waitFor();
  }
  async function open(title: string, page = p) { await page.getByRole('button').filter({has:page.getByText(title,{exact:true})}).click(); await page.getByRole('heading',{name:title,exact:true}).waitFor(); }
  async function saved(page = p) { await page.getByText(/服务已保存，当前结果已刷新/).waitFor(); }
  async function submitButton(page = p) { await page.getByLabel('继续处理',{exact:true}).check(); await page.getByRole('button',{name:'提交回应',exact:true}).click(); }
  try {
    const button = await f.create('发布前需要确认'), text = await f.create('补充本轮验收要求');
    await t.test('browser view → button → durable save → source result → current refresh', async () => {
      const start = performance.now(); await login(p,f.userToken,true); measurements.firstInboxMs=performance.now()-start;
      await open('发布前需要确认'); assert.equal(f.db.prepare('SELECT count(*) AS n FROM read_states').get().n,0);
      const begin=performance.now(); await submitButton(); await saved(); measurements.buttonRoundtripMs=performance.now()-begin;
      const rows=f.db.prepare('SELECT id,event_id,data FROM responses').all(); assert.equal(rows.length,1); assert.equal(rows[0].event_id,button.event_id); assert.equal(JSON.parse(rows[0].data).text,'');
      await p.screenshot({path:resolve(evidence,'web-001-desktop-saved.png'),fullPage:true});
      await f.update(button.event_id,'隔离来源自报：按钮回应已经读入测试流程，本轮结果已追加到原事件。未运行AI或原生动作。');
      await p.getByRole('button',{name:'刷新当前事件',exact:true}).click(); await p.locator('.event-body').filter({hasText:'本轮结果已追加到原事件'}).waitFor();
      await p.screenshot({path:resolve(evidence,'web-001-desktop-result.png'),fullPage:true});
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM commands').get().n,0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM read_states').get().n,0);
      await p.getByRole('button',{name:'明确标记此版已读',exact:true}).click(); await saved(); assert.equal(f.db.prepare('SELECT version FROM read_states WHERE event_id=?').get(button.event_id).version,3);
      await p.getByLabel('改为',{exact:true}).selectOption('completed'); await p.getByRole('button',{name:'核对此项决定',exact:true}).click(); await p.getByRole('button',{name:'确认保存事项决定',exact:true}).click(); await saved();
      await f.update(button.event_id,'迟到的来源进展不应重开用户已完成的事项。',{kind:'progress'});
      await p.getByRole('button',{name:'刷新当前事件',exact:true}).click(); await p.locator('.event-body').filter({hasText:'迟到的来源进展'}).waitFor();
      const e=await f.req('GET','/v1/events/'+button.event_id,undefined,f.userToken);assert.equal(e.disposition,'completed');
    });
    await t.test('text preserves Unicode/whitespace; real mobile viewport and keyboard', async () => {
      await p.getByRole('button',{name:'刷新事件',exact:true}).click(); await p.getByRole('button',{name:'提交回应',exact:true}).count();
      await open('补充本轮验收要求'); await p.getByRole('radio',{name:/补充要求/}).check();
      const original='  请保留原请求ID🙂\n先核验回执，再判断是否完成。  ';
      await p.getByLabel('回应原文',{exact:true}).fill(original); await p.getByRole('button',{name:'提交回应',exact:true}).click(); await saved();
      const row=f.db.prepare('SELECT data FROM responses WHERE event_id=?').get(text.event_id); assert.equal(JSON.parse(row.data).text,original);
      await p.setViewportSize({width:390,height:844}); await p.screenshot({path:resolve(evidence,'web-001-mobile-saved.png'),fullPage:true});
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await p.getByRole('button',{name:'← 返回收件箱',exact:true}).click(); await p.getByLabel('搜索当前窗口',{exact:true}).fill('补充本轮');
      assert.equal(await p.locator('.event-row').count(),1);await p.screenshot({path:resolve(evidence,'web-001-mobile-filter.png'),fullPage:true});
      await p.getByLabel('搜索当前窗口',{exact:true}).fill('');await p.keyboard.press('Tab');assert.ok(await p.evaluate(()=>document.activeElement?.tagName!=='BODY'));
      await p.setViewportSize({width:1440,height:900}); await p.evaluate(()=>document.documentElement.style.zoom='2');
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await p.screenshot({path:resolve(evidence,'web-001-zoom-200.png'),fullPage:true});
      await p.evaluate(()=>document.documentElement.style.zoom='1');
    });
    await t.test('lost response ACK → reload → exact credential → GET original only', async () => {
      const e=await f.create('回执丢失恢复演练');await p.getByRole('button',{name:'刷新事件',exact:true}).click();await open('回执丢失恢复演练');
      g.control.fault='drop';await submitButton();await p.getByText('原提交结果待核实，所有新写入已暂停',{exact:true}).waitFor();
      const row=f.db.prepare('SELECT id FROM responses WHERE event_id=?').get(e.event_id);assert.ok(row);
      await p.screenshot({path:resolve(evidence,'web-001-unknown.png'),fullPage:true});
      const before=g.control.requests.filter(x=>x.method!=='GET').length;
      await login();await p.getByRole('button',{name:'查询原请求',exact:true}).click();await p.getByText('已按原回应ID核到服务保存事实，没有重新发送',{exact:true}).waitFor();
      assert.equal(g.control.requests.filter(x=>x.method!=='GET').length,before);assert.equal(f.db.prepare('SELECT count(*) AS n FROM responses WHERE event_id=?').get(e.event_id).n,1);
      const durable=await p.evaluate(async()=>{const {BrowserStore}=await import('/src/storage.ts');return (await new BrowserStore().read());});assert.equal(durable.pending,null);assert.equal(durable.outcome.id,row.id);
      measurements.recoveryOriginalResponseId=row.id;
    });
    await t.test('native Web Locks + IDB: two tabs, different namespace, first unknown prevents second POST', async () => {
      const e=await f.create('双页互斥验证');await p.getByRole('button',{name:'刷新事件',exact:true}).click();await open('双页互斥验证');
      const second=await context.newPage();await login(second);
      // Use real product modules in the second tab, but a different frozen credential namespace.
      let release!:()=>void, started!:()=>void;
      const barrier=new Promise<void>(r=>{release=r;}), entered=new Promise<void>(r=>{started=r;});
      await p.route('**/api/v1/events/*/responses',async route=>{started();await barrier;await route.continue();});
      g.control.fault='drop';await submitButton();await entered;
      const pendingPromise=second.evaluate(async ({origin,token,eventId})=>{
        const {BrowserStore,browserLock}=await import('/src/storage.ts');const {Ledger}=await import('/src/ledger.ts');const {Api,connection}=await import('/src/api.ts');const {event}=await import('/src/contracts.ts');
        const c=await connection(origin,'deliberately-different-namespace',token);let requests=0;
        try{await new Ledger(new BrowserStore(),browserLock).submit(new Api(c,()=>{},async()=>{requests++;throw new Error('must not fetch');}),event(eventId),'read');return {requests,error:''};}catch(e){return {requests,error:String(e)};}
      },{origin,token:f.otherToken,eventId:await f.req('GET','/v1/events/'+e.event_id,undefined,f.userToken)});
      await second.waitForFunction(async()=>{const q=await navigator.locks.query();return q.held?.length===1&&q.pending?.length===1;});
      release();await p.getByText('原提交结果待核实，所有新写入已暂停',{exact:true}).waitFor();await p.unrouteAll();
      const result=await pendingPromise;assert.equal(result.requests,0);assert.match(result.error,/未决提交/);
      await second.close();await p.getByRole('button',{name:'查询原请求',exact:true}).click();await p.getByText('已按原回应ID核到服务保存事实，没有重新发送',{exact:true}).waitFor();
    });
    await t.test('101 events and 201 history: bounded windows, following window, failure preserves old page', async () => {
      for(let n=0;n<101;n++)await f.create('分页事件 '+String(n).padStart(3,'0'),{body:n===100?'很长的字串'.repeat(2000):'分页合成正文'});
      await p.getByRole('button',{name:'刷新事件',exact:true}).click();await p.getByText('当前窗口 50 条 · 创建顺序',{exact:true}).waitFor();
      await p.getByRole('button',{name:'加载后续事件',exact:true}).click();await p.getByText('当前窗口 100 条 · 创建顺序',{exact:true}).waitFor();
      await p.getByRole('button',{name:'查看后续窗口',exact:true}).click();await p.getByText('当前窗口 5 条 · 创建顺序',{exact:true}).waitFor();
      assert.equal(await p.locator('.event-row').count(),5);await open('分页事件 100');
      const id=(await f.req('GET','/v1/events?after=0&limit=100',undefined,f.userToken)).next_after;
      assert.ok(id);
      const all=f.db.prepare('SELECT id,data FROM events').all();const target=all.find(x=>JSON.parse(x.data).title==='分页事件 100').id;
      for(let n=0;n<200;n++)await f.update(target,'历史进展 '+n,{kind:'progress'});
      await p.getByRole('button',{name:'刷新当前事件',exact:true}).click();await p.getByText('当前窗口 50 条',{exact:true}).waitFor();
      for(let n=0;n<3;n++)await p.getByRole('button',{name:'加载后续历史',exact:true}).click();await p.getByText('当前窗口 200 条',{exact:true}).waitFor();
      await p.getByRole('button',{name:'查看后续历史窗口',exact:true}).click();await p.getByText('当前窗口 1 条',{exact:true}).waitFor();assert.equal(await p.locator('.timeline > li').count(),1);
      await p.getByRole('button',{name:'返回历史首段',exact:true}).click();await p.getByText('当前窗口 50 条',{exact:true}).waitFor();
      const before=await p.locator('.timeline').textContent();await p.route('**/api/v1/events/*/history?after=*&limit=50',route=>route.abort());
      await p.getByRole('button',{name:'加载后续历史',exact:true}).click();await p.getByRole('alert').waitFor();assert.equal(await p.locator('.timeline').textContent(),before);await p.unrouteAll();
      measurements.maxEventRows=100;measurements.maxHistoryRows=200;measurements.domNodes=await p.locator('*').count();
      await p.screenshot({path:resolve(evidence,'web-001-window-history.png'),fullPage:true});
    });
    await t.test('real version race rejects once; malformed ACK/503/redirect preserve original pending', async () => {
      async function newest(title: string) {await p.getByRole('button',{name:'刷新事件',exact:true}).click();await p.getByRole('button',{name:'加载后续事件',exact:true}).click();await p.getByRole('button',{name:'查看后续窗口',exact:true}).click();await open(title);}
      const e=await f.create('写入门版本竞争');await newest('写入门版本竞争');
      await p.route('**/api/v1/events/*/responses',async route=>{await f.update(e.event_id,'来源在实际POST之前推进了版本',{kind:'progress'});await route.continue();});
      await submitButton();await p.getByRole('alert').filter({hasText:'EVENT_VERSION_CONFLICT'}).waitFor();await p.unrouteAll();
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM responses WHERE event_id=?').get(e.event_id).n,0);
      const rejected=await p.evaluate(async()=>{const {BrowserStore}=await import('/src/storage.ts');return new BrowserStore().read();});assert.equal(rejected.pending,null);assert.equal(rejected.outcome.state,'rejected');
      for(const fault of ['json','503','redirect']) {
        const title='异常回执 '+fault,created=await f.create(title);await newest(title);g.control.fault=fault;await submitButton();await p.getByText('原提交结果待核实，所有新写入已暂停',{exact:true}).waitFor();
        const before=g.control.requests.length;await p.getByRole('button',{name:'查询原请求',exact:true}).click();await p.getByText('已按原回应ID核到服务保存事实，没有重新发送',{exact:true}).waitFor();
        assert.equal(g.control.requests.slice(before).some(x=>x.method!=='GET'),false);assert.equal(f.db.prepare('SELECT count(*) AS n FROM responses WHERE event_id=?').get(created.event_id).n,1);
        if(fault==='redirect')assert.equal(f.requests.filter(x=>x.path==='/v1/events'&&x.method==='GET').length,0);
      }
    });
    await t.test('actual IDB aborted transactions: no POST; interrupted initialization stays blocked', async () => {
      const created=await f.create('IDB故障隔离事件');
      for(const failAt of [1,2]) {
        const c=await browser.newContext(),page=await c.newPage();await page.goto(origin);
        // tsx keepNames helper belongs to this serialized test closure, not the app.
        await page.evaluate('globalThis.__name = value => value');
        const result=await page.evaluate(async({origin,token,eventId,failAt})=>{
          const {BrowserStore,browserLock}=await import('/src/storage.ts');const {Ledger}=await import('/src/ledger.ts');const {Api,connection}=await import('/src/api.ts');const {event}=await import('/src/contracts.ts');
          const base=new BrowserStore();await browserLock(()=>base.initialize());let writes=0,changes=0;
          const wrapped={status:()=>base.status(),initialize:()=>base.initialize(),read:()=>base.read(),change:fn=>base.change(r=>{const next=fn(r);if(++changes===failAt)throw new Error('STORAGE_INJECTED_TRANSACTION_ABORT');return next;})};
          const api=new Api(await connection(origin,'idb-native-abort',token),()=>{},(u,o)=>{if(o.method!=='GET')writes++;return fetch(u,o);});
          let error='';try{await new Ledger(wrapped,browserLock).submit(api,event(eventId),'response',eventId.interaction.actions[0]);}catch(e){error=String(e);}return {writes,error,pending:(await base.read()).pending};
        },{origin,token:f.userToken,eventId:await f.req('GET','/v1/events/'+created.event_id,undefined,f.userToken),failAt});
        assert.equal(result.writes,0);assert.match(result.error,/STORAGE_INJECTED/);assert.equal(result.pending?.stage,failAt===1?undefined:'prepared');await c.close();
      }
      const c=await browser.newContext(),page=await c.newPage();await page.goto(origin);
      await page.evaluate('globalThis.__name = value => value');
      const partial=await page.evaluate(async()=>{const {BrowserStore,browserLock}=await import('/src/storage.ts');const saved=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('quota simulation');};let initialization='';try{await browserLock(()=>new BrowserStore().initialize());}catch(e){initialization=String(e);}finally{Storage.prototype.setItem=saved;}let status='';try{await new BrowserStore().status();}catch(e){status=String(e);}return {initialization,status};});
      assert.match(partial.initialization,/quota simulation/);assert.match(partial.status,/PAIR_MISSING/);await c.close();
    });
    await t.test('read and disposition lost ACK remain unknown even when goal state matches', async () => {
      for(const kind of ['read','disposition']) {
        const c=await browser.newContext(),page=await c.newPage();await login(page,f.userToken,true);
        const title='未知'+kind,ack=await f.create(title);await page.getByRole('button',{name:'刷新事件',exact:true}).click();
        // Last window contains newest event; explicitly navigate to it.
        await page.getByRole('button',{name:'加载后续事件',exact:true}).click();await page.getByRole('button',{name:'查看后续窗口',exact:true}).click();await open(title,page);
        g.control.fault='drop';
        if(kind==='read')await page.getByRole('button',{name:'明确标记此版已读',exact:true}).click();
        else{await page.getByRole('button',{name:'核对此项决定',exact:true}).click();await page.getByRole('button',{name:'确认保存事项决定',exact:true}).click();}
        await page.getByText('原提交结果待核实，所有新写入已暂停',{exact:true}).waitFor();const before=g.control.requests.filter(x=>x.method!=='GET').length;
        await page.getByRole('button',{name:'查询原请求',exact:true}).click();await page.getByText(kind==='read'?/原PUT结果仍未知/:/不能凭相同决定认定原请求成功/).waitFor();
        assert.equal(g.control.requests.filter(x=>x.method!=='GET').length,before);assert.ok(await page.evaluate(async()=>{const {BrowserStore}=await import('/src/storage.ts');return (await new BrowserStore().read()).pending;}));
        assert.ok(await f.req('GET','/v1/events/'+ack.event_id,undefined,f.userToken));await c.close();
      }
    });
    await t.test('native IDB pairing marker loss refuses reconstruction; credentials absent in storage', async () => {
      const values=await p.evaluate(async()=>{
        const {BrowserStore}=await import('/src/storage.ts');const root=await new BrowserStore().read();const local=JSON.stringify({...localStorage});localStorage.removeItem('notifier-web-store-v1');let error='';try{await new BrowserStore().status();}catch(e){error=String(e);}return {root,local,error};
      });assert.match(values.error,/PAIR_MISSING/);assert.equal(JSON.stringify(values).includes(f.userToken),false);assert.equal(JSON.stringify(values).includes(f.sourceToken),false);
      await p.reload();await p.getByText('账本缺失、不一致或不可访问，保持只读，未自动重建',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'建立本机提交账本',exact:true}).count(),0);
    });
    assert.deepEqual(errors,[]);
    measurements.pageErrors=errors;measurements.requestMethods=g.control.requests.reduce((a,x)=>(a[x.method]=(a[x.method]??0)+1,a),{});measurements.finalLedger={events:f.db.prepare('SELECT count(*) AS n FROM events').get().n,responses:f.db.prepare('SELECT count(*) AS n FROM responses').get().n,commands:f.db.prepare('SELECT count(*) AS n FROM commands').get().n,readStates:f.db.prepare('SELECT count(*) AS n FROM read_states').get().n};
    writeFileSync(resolve(evidence,'web-001-browser-measurements.json'),JSON.stringify(measurements,null,2));
  } finally { await browser.close();await vite.close();await g.close();await f.close(); }
});
