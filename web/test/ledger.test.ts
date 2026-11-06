import test from 'node:test';
import assert from 'node:assert/strict';
import { Api, connection, apiRoot, HttpError, Stale } from '../src/api.ts';
import { event, type Event } from '../src/contracts.ts';
import { Ledger, knownRejection } from '../src/ledger.ts';
import { root, type Root, type Store, type Lock } from '../src/storage.ts';
import { Client } from '../src/client.ts';
const token = 'a'.repeat(64);
const sample = (): Event => event({ id:'event_1', owner_id:'owner', source_id:'source', source_epoch:'epoch', title:'测试', body:'正文', session_ref:'session', target_revision:'rev', expires_at:'2099-01-01T00:00:00Z', event_version:1, interaction_version:1, interaction:{id:'question',version:1,actions:[{id:'yes',label:'继续',type:'button'},{id:'text',label:'补充',type:'text'}]}, reserved_response_id:null, disposition:'open', created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z', read_state:{version:0,unread:true},can_respond:true,source_delivery:null,notification_delivery:null,previous_notification_delivery:null,delivery_state:'not_observed',verification:'not_verified' });
class Memory implements Store {
  r: Root = {schema:1,store_id:'store',pending:null,outcome:null}; failAt=0; changes=0;
  async status(): Promise<'ready'> { return 'ready'; }
  async initialize() {}
  async read() { return structuredClone(this.r); }
  async change(fn: (r: Root)=>Root) { if (++this.changes === this.failAt) throw new Error('STORAGE_TRANSACTION_FAILED'); this.r=root(fn(structuredClone(this.r))); }
}
function serial(): Lock { let tail=Promise.resolve(); return async fn => { const old=tail; let release!:()=>void; tail=new Promise(r=>{release=r;}); await old; try{return await fn();} finally{release();} }; }
// Baseline error envelopes include message. Malformed-envelope probes use raw Response.
const json=(value:unknown,status=200)=>{
  const o=value as {error?:Record<string,unknown>};
  if(o?.error && typeof o.error.code==='string' && !Object.hasOwn(o.error,'message'))value={...o,error:{...o.error,message:'Synthetic baseline error'}};
  return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
};
function fixture(mode='ok', memory=new Memory()) {
  const e=sample(), writes:{path:string;body:any}[]=[]; let receipt:any;
  const f=async (input: RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input); if(init?.method==='POST'||init?.method==='PUT') {
      const body=JSON.parse(String(init.body)); writes.push({path,body});
      receipt={id:body.response_id,event_id:e.id,actor_id:'device',created_at:'2026-01-01T00:00:00Z',event_version_seen:1,interaction_id:'question',interaction_version:1,action:e.interaction!.actions.find(a=>a.id===body.action_id),text:body.text,expires_at:e.expires_at,target:{source_id:'source',source_epoch:'epoch',session_ref:'session',state_revision:'rev'},eligibility_state:'waiting_source',eligibility_reason:'NOT_DELIVERED',routing_state:'waiting_source',reason_code:'NOT_DELIVERED',source_delivery:null,execution_state:'not_observed',verification:'not_verified',execution_authorized:false};
      if(mode==='drop') throw new TypeError('fetch failed');
      if(mode==='json') return new Response('{',{headers:{'Content-Type':'application/json'}});
      if(mode==='reject') return json({error:{code:'EVENT_VERSION_CONFLICT'}},409);
      if(mode==='503') return json({error:{code:'STORAGE_FAILURE'}},503);
      if(mode==='401') return json({error:{code:'UNAUTHENTICATED'}},401);
      return json(path.endsWith('read-state')?{event_id:e.id,read_version:1}:path.endsWith('disposition')?{event_id:e.id,event_version:2,saved_at:'2026-01-01T00:00:00Z'}:{event_id:e.id,response_id:body.response_id,saved_at:'2026-01-01T00:00:00Z'});
    }
    if(path.includes('/responses/')) return json(receipt);
    return json(e);
  };
  return { e,writes,store:memory,ledger:new Ledger(memory,serial()),f:f as typeof fetch, get receipt(){return receipt;} };
}
test('canonical fixed API root and namespace isolates credential/deployment/origin',async()=>{
  assert.equal(apiRoot('https://app.example'),'https://app.example/api');
  for(const url of ['http://example.com','https://user:pass@example.com','https://app.example/path','https://app.example?x=1']) assert.throws(()=>apiRoot(url));
  const a=await connection('http://127.0.0.1:9000','one',token);
  for(const c of [await connection('http://127.0.0.1:9000','two',token),await connection('http://127.0.0.1:9001','one',token),await connection('http://127.0.0.1:9000','one','b'.repeat(64))]) assert.notEqual(a.namespace,c.namespace);
  await assert.rejects(()=>connection('http://127.0.0.1:9000','one',token.toUpperCase()));
});
test('transport uses frozen auth, no cache/cookie/redirect and rejects bad routes',async()=>{
  const c=await connection('http://127.0.0.1:9000','one',token); let opts:RequestInit|undefined;
  const api=new Api(c,()=>{},(async(_u,o)=>{opts=o;return json({});}) as typeof fetch);
  await api.request('/v1/events'); assert.equal(opts?.redirect,'error');assert.equal(opts?.cache,'no-store');assert.equal(opts?.credentials,'omit');
  await assert.rejects(()=>api.request('//example.com/')); await assert.rejects(()=>api.request('/v1/events#x'));
});
for(const stage of [1,2]) test(`durable transaction ${stage} failure causes zero POST`,async()=>{
  const s=new Memory();s.failAt=stage;const x=fixture('ok',s),c=await connection('http://127.0.0.1','one',token);
  await assert.rejects(()=>x.ledger.submit(new Api(c,()=>{},x.f),x.e,'response',x.e.interaction!.actions[0]));assert.equal(x.writes.length,0);
  assert.equal(s.r.pending?.stage,stage===1?undefined:'prepared');
});
test('button ACK clears only original intent and retains saved observation',async()=>{
  const x=fixture(),c=await connection('http://127.0.0.1','one',token),api=new Api(c,()=>{},x.f);
  const id=await x.ledger.submit(api,x.e,'response',x.e.interaction!.actions[0],'ignored');assert.equal(x.writes[0].body.text,'');assert.equal(x.store.r.pending,null);assert.equal(x.store.r.outcome?.id,id);
});
test('unicode code points and original whitespace are preserved',async()=>{
  const x=fixture(),c=await connection('http://127.0.0.1','one',token),api=new Api(c,()=>{},x.f),text='  '+ '🙂'.repeat(3996)+'\n ';
  await x.ledger.submit(api,x.e,'response',x.e.interaction!.actions[1],text);assert.equal(x.writes[0].body.text,text);
  const y=fixture();await assert.rejects(()=>y.ledger.submit(new Api(c,()=>{},y.f),y.e,'response',y.e.interaction!.actions[1],'🙂'.repeat(4001)));assert.equal(y.writes.length,0);
});
for(const mode of ['drop','json','503','401']) test(`${mode} keeps original unknown, new ledger instance recovers with GET only`,async()=>{
  const x=fixture(mode),c=await connection('http://127.0.0.1','one',token),api=new Api(c,()=>{},x.f);
  await assert.rejects(()=>x.ledger.submit(api,x.e,'response',x.e.interaction!.actions[1],'  原文🙂  '));const p=structuredClone(x.store.r.pending);assert.equal(p?.stage,'unknown');
  const newLedger=new Ledger(x.store,serial());const result=await newLedger.recover(api);assert.equal(result.saved,true);assert.equal(x.writes.length,1);assert.equal(x.store.r.outcome?.id,p?.id);
});
test('first exact known rejection releases slot, other status/code pairs do not',async()=>{
  const x=fixture('reject'),c=await connection('http://127.0.0.1','one',token);await assert.rejects(()=>x.ledger.submit(new Api(c,()=>{},x.f),x.e,'response',x.e.interaction!.actions[0]));assert.equal(x.store.r.pending,null);assert.equal(x.store.r.outcome?.state,'rejected');
  for(const [s,code] of [[413,'INPUT_TOO_LARGE'],[404,'NOT_FOUND'],[401,'UNAUTHENTICATED'],[409,'IDEMPOTENCY_CONFLICT'],[503,'EVENT_VERSION_CONFLICT'],[422,'INPUT_TOO_LARGE']] as const)assert.equal(knownRejection(new HttpError(s,code)),false);
});
for(const status of [401,404,409,503]) test(`unknown recovery HTTP${status} preserves exact bytes and ID`,async()=>{
  const x=fixture('drop'),c=await connection('http://127.0.0.1','one',token);await assert.rejects(()=>x.ledger.submit(new Api(c,()=>{},x.f),x.e,'response',x.e.interaction!.actions[0]));const before=JSON.stringify(x.store.r.pending);
  await assert.rejects(()=>x.ledger.recover(new Api(c,()=>{},(async()=>json({error:{code:status===409?'EVENT_VERSION_CONFLICT':'NOT_FOUND'}},status)) as typeof fetch)));assert.equal(JSON.stringify(x.store.r.pending),before);assert.equal(x.writes.length,1);
});
for(const field of ['text','action','target','event_version_seen','actor_id']) test(`response recovery mismatch ${field} never clears`,async()=>{
  const x=fixture('drop'),c=await connection('http://127.0.0.1','one',token);await assert.rejects(()=>x.ledger.submit(new Api(c,()=>{},x.f),x.e,'response',x.e.interaction!.actions[0],'','device'));
  const bad={...x.receipt,[field]:field==='text'?'different':field==='event_version_seen'?2:field==='actor_id'?'another':{}};
  await assert.rejects(()=>x.ledger.recover(new Api(c,()=>{},(async()=>json(bad)) as typeof fetch)));assert.ok(x.store.r.pending);
});
for(const kind of ['read','disposition'] as const)test(`${kind} ACK loss observed equal state is not original request success`,async()=>{
  const x=fixture('drop'),c=await connection('http://127.0.0.1','one',token),api=new Api(c,()=>{},x.f);await assert.rejects(()=>x.ledger.submit(api,x.e,kind,'paused'));const before=JSON.stringify(x.store.r.pending);
  x.e.read_state={version:9,unread:false};x.e.disposition='paused';const r=await x.ledger.recover(api);assert.equal(r.saved,false);assert.equal(JSON.stringify(x.store.r.pending),before);assert.equal(x.writes.length,1);
});
test('connection mismatch cannot query or resend original pending',async()=>{
  const x=fixture('drop'),a=await connection('http://127.0.0.1','one',token),b=await connection('http://127.0.0.1','one','b'.repeat(64));await assert.rejects(()=>x.ledger.submit(new Api(a,()=>{},x.f),x.e,'response',x.e.interaction!.actions[0]));let count=0;
  await assert.rejects(()=>x.ledger.recover(new Api(b,()=>{},(async()=>{count++;return json({});}) as typeof fetch)));assert.equal(count,0);
});
test('version change and lost foreground before write both cause zero POST',async()=>{
  const x=fixture(),c=await connection('http://127.0.0.1','one',token),old=sample();x.e.event_version=2;
  await assert.rejects(()=>x.ledger.submit(new Api(c,()=>{},x.f),old,'response',old.interaction!.actions[0]));assert.equal(x.writes.length,0);
  await assert.rejects(()=>x.ledger.submit(new Api(c,()=>{throw new Stale();},x.f),x.e,'read'));assert.equal(x.writes.length,0);
});
test('shared write lock serializes two ledgers: first unknown blocks second namespace',async()=>{
  const s=new Memory(),lock=serial(),x=fixture('drop',s),a=await connection('http://127.0.0.1','one',token),b=await connection('http://127.0.0.1','one','b'.repeat(64));
  const results=await Promise.allSettled([new Ledger(s,lock).submit(new Api(a,()=>{},x.f),x.e,'response',x.e.interaction!.actions[0]),new Ledger(s,lock).submit(new Api(b,()=>{},x.f),x.e,'response',x.e.interaction!.actions[0])]);assert.equal(results.every(r=>r.status==='rejected'),true);assert.equal(x.writes.length,1);
});
test('lifecycle changes after durable unknown and before fetch leave original slot, zero writes',async()=>{
  const x=fixture(),c=await connection('http://127.0.0.1','one',token);let active=true;const original=x.store.change.bind(x.store);
  x.store.change=async fn=>{await original(fn);if(x.store.changes===2)active=false;};
  await assert.rejects(()=>x.ledger.submit(new Api(c,()=>{if(!active)throw new Stale();},x.f),x.e,'response',x.e.interaction!.actions[0]));assert.equal(x.writes.length,0);assert.equal(x.store.r.pending?.stage,'unknown');
});
test('root rejects corrupted/oversized pending and schema, without repairing bytes',()=>{
  for(const value of [{schema:2},{schema:1,store_id:'store',pending:{},outcome:null},{schema:1,store_id:'store',pending:null,outcome:null,extra:true},{schema:1,store_id:'store',pending:null,outcome:{text:'x'.repeat(140000)}}])assert.throws(()=>root(value));
});
test('A to B to A: delayed old page cannot land in new same-credential generation',async()=>{
  const s=new Memory();let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});let delay=true;
  const f=(async(u:RequestInfo|URL)=>{if(String(u).endsWith('/device/self'))return json({error:{code:'NOT_FOUND'}},404);if(delay){delay=false;await barrier;return json({items:[sample()],next_after:null});}return json({items:[],next_after:null});})as typeof fetch;
  const c=new Client('http://127.0.0.1','one',s,serial(),f);const first=c.connect(token);await new Promise(r=>setTimeout(r,10));await c.connect('b'.repeat(64));await c.connect(token);release();await first;assert.equal(c.snapshot().events.length,0);assert.equal(c.snapshot().connection?.token,token);
});
test('paginated A to B to A: delayed continuation cannot append into the new first window',async()=>{
  const s=new Memory();let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});let entered!:()=>void;const enteredPromise=new Promise<void>(r=>{entered=r;});
  const items=Array.from({length:50},(_,i)=>({...sample(),id:'event_'+i}));
  const f=(async(u:RequestInfo|URL)=>{const path=String(u);if(path.endsWith('/device/self'))return json({error:{code:'NOT_FOUND'}},404);if(path.includes('after=50&')){entered();await barrier;return json({items:[{...sample(),id:'foreign_late'}],next_after:null});}return json({items,next_after:'50'});})as typeof fetch;
  const c=new Client('http://127.0.0.1','one',s,serial(),f);await c.connect(token);const continuation=c.nextEvents();await enteredPromise;await c.connect('b'.repeat(64));await c.connect(token);release();await continuation;assert.equal(c.snapshot().events.length,50);assert.equal(c.snapshot().events.some(e=>e.id==='foreign_late'),false);
});
test('managed self 401 is not silently downgraded to verified static identity',async()=>{
  const f=(async(u:RequestInfo|URL)=>String(u).endsWith('/device/self')?json({error:{code:'UNAUTHENTICATED'}},401):json({items:[sample()],next_after:null}))as typeof fetch;
  const c=new Client('http://127.0.0.1','one',new Memory(),serial(),f);await c.connect(token);assert.equal(c.snapshot().authenticated,false);assert.equal(c.snapshot().device,null);assert.match(c.snapshot().error,/认证已失效/);
});
