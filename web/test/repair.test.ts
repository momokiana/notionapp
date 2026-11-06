import test from 'node:test';
import assert from 'node:assert/strict';
import {Api,connection,MAX_RESPONSE_BYTES,HttpError} from '../src/api.ts';
import {Client} from '../src/client.ts';
import {event,page,type Event} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {root as parseRoot,type Root,type Store,type Lock} from '../src/storage.ts';
const sample=():Event=>event({id:'repair_event',owner_id:'owner',source_id:'source',source_epoch:'epoch',title:'repair control',body:'synthetic',session_ref:'session',target_revision:'revision',expires_at:'2099-01-01T00:00:00Z',event_version:1,interaction_version:1,interaction:{id:'question',version:1,actions:[{id:'yes',label:'yes',type:'button'}]},reserved_response_id:null,disposition:'open',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',read_state:{version:0,unread:true},can_respond:true,source_delivery:null,notification_delivery:null,previous_notification_delivery:null,delivery_state:'not_observed',verification:'not_verified'});
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
const lock:Lock=async fn=>fn();
function memory(){let state:Root={schema:1,store_id:'repair_store',pending:null,outcome:null};const store:Store={status:async()=>'ready',initialize:async()=>{},read:async()=>structuredClone(state),change:async fn=>{state=parseRoot(fn(structuredClone(state)));}};return {store,get state(){return state;}};}
for(const malformed of [
  {error:{code:'EVENT_VERSION_CONFLICT'}}, {error:{code:'EVENT_VERSION_CONFLICT',message:7}},
  {error:{code:'EVENT_VERSION_CONFLICT',message:'x',extra:true}}, {error:{code:'EVENT_VERSION_CONFLICT',message:'x'},extra:true},
  {error:['EVENT_VERSION_CONFLICT','x']}, {error:{code:'event_version_conflict',message:'x'}},
])test('F1 malformed error remains unknown: '+JSON.stringify(malformed),async()=>{
  const m=memory(),e=sample(),c=await connection('http://127.0.0.1','repair','a'.repeat(64));let writes=0;
  const api=new Api(c,()=>{},(async(_u,o)=>{if(o?.method==='POST'){writes++;return json(malformed,409);}return json(e);})as typeof fetch);
  await assert.rejects(()=>new Ledger(m.store,lock).submit(api,e,'response',e.interaction!.actions[0]));assert.equal(writes,1);assert.equal(m.state.pending?.stage,'unknown');assert.equal(m.state.outcome,null);
});
test('F1 exact baseline error envelope still yields typed known rejection',async()=>{
  const c=await connection('http://127.0.0.1','repair','a'.repeat(64)),api=new Api(c,()=>{},(async()=>json({error:{code:'EVENT_VERSION_CONFLICT',message:'Refresh the current version'}},409))as typeof fetch);
  await assert.rejects(()=>api.request('/v1/events'),e=>e instanceof HttpError&&e.status===409&&e.code==='EVENT_VERSION_CONFLICT');
});
test('F2 legal 50-event emoji and JSON-escaped pages fit the bounded response budget',async()=>{
  const c=await connection('http://127.0.0.1','repair','a'.repeat(64));
  for(const body of ['🙂'.repeat(16000),'\u0000'.repeat(16000)]){
    const value={items:Array.from({length:50},(_,i)=>({...sample(),id:'event_'+i,body})),next_after:null};const bytes=new TextEncoder().encode(JSON.stringify(value)).length;
    assert.ok(bytes>2*1024*1024&&bytes<MAX_RESPONSE_BYTES);
    const got=page(await new Api(c,()=>{},(async()=>json(value))as typeof fetch).request('/v1/events?after=0&limit=50'),event);assert.equal(got.items.length,50);assert.equal(got.items[49].body,body);
  }
});
test('F2 responses beyond the fixed budget are rejected without unbounded decoding',async()=>{
  const c=await connection('http://127.0.0.1','repair','a'.repeat(64));
  const api=new Api(c,()=>{},(async()=>new Response('x'.repeat(MAX_RESPONSE_BYTES+1),{headers:{'Content-Type':'application/json'}}))as typeof fetch);
  await assert.rejects(()=>api.request('/v1/events'),/SERVER_DATA_TOO_LARGE/);
});
for(const malformed of ['extra','timestamp'])test('strict success ACK '+malformed+' keeps unknown',async()=>{
  const m=memory(),e=sample(),c=await connection('http://127.0.0.1','repair','a'.repeat(64));
  const api=new Api(c,()=>{},(async(_u,o)=>o?.method==='POST'?json({event_id:e.id,response_id:JSON.parse(String(o.body)).response_id,saved_at:malformed==='timestamp'?'not-a-time':'2026-01-01T00:00:00Z',...(malformed==='extra'?{unexpected:true}:{})}):json(e))as typeof fetch);
  await assert.rejects(()=>new Ledger(m.store,lock).submit(api,e,'response',e.interaction!.actions[0]));assert.ok(m.state.pending);assert.equal(m.state.outcome,null);
});
async function authScenario(kind:'submit'|'recover',failStatus:0|401|403|503,malformed=false){
  const e=sample(),m=memory();let saved=false,receipt:any;
  const fetcher=(async(url:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(url);
    if(init?.method==='POST'){
      const b=JSON.parse(String(init.body));saved=true;receipt={id:b.response_id,event_id:e.id,actor_id:'repair_device',created_at:'2026-01-01T00:00:00Z',event_version_seen:1,interaction_id:'question',interaction_version:1,action:e.interaction!.actions[0],text:'',expires_at:e.expires_at,target:{source_id:e.source_id,source_epoch:e.source_epoch,session_ref:e.session_ref,state_revision:e.target_revision},eligibility_state:'waiting_source',eligibility_reason:'NOT_DELIVERED',routing_state:'waiting_source',reason_code:'NOT_DELIVERED',source_delivery:null,execution_state:'not_observed',verification:'not_verified',execution_authorized:false};
      if(kind==='recover')throw new TypeError('synthetic ACK loss');return json({event_id:e.id,response_id:b.response_id,saved_at:'2026-01-01T00:00:00Z'});
    }
    if(path.includes('/events?'))return json({items:[e],next_after:null});
    if(path.endsWith('/device/self')||path.includes('/source-runtime/'))return json({error:{code:'NOT_FOUND',message:'not configured'}},404);
    if(path.includes('/responses/'))return json(receipt);
    if(path.includes('/history?'))return json({items:[],next_after:null});
    // F3 specifically fails every current GET after ACK loss, including before any local finish.
    if(saved&&failStatus&&(kind==='submit'||failStatus===503||m.state.pending===null))return json({error:{code:failStatus===401?'UNAUTHENTICATED':failStatus===403?'FORBIDDEN':'STORAGE_FAILURE',...(malformed?{}:{message:'synthetic refresh failure'})}},failStatus);
    return json(saved?{...e,event_version:2,reserved_response_id:receipt.id,can_respond:false}:e);
  })as typeof fetch;
  const c=new Client('http://127.0.0.1','repair',m.store,lock,fetcher);await c.connect('a'.repeat(64));await c.select(e.id);await c.submit('response',c.snapshot().detail!.interaction!.actions[0]);if(kind==='recover'){assert.ok(m.state.pending);await c.recover();}return {c,m};
}
for(const kind of ['submit','recover']as const){
  test(`F4 control ${kind} successful refresh keeps saved evidence and authentication`,async()=>{const {c,m}=await authScenario(kind,0);assert.equal(m.state.outcome?.state,'saved');assert.equal(m.state.pending,null);assert.equal(c.snapshot().authenticated,true);assert.equal(c.snapshot().fresh,true);});
  for(const status of [401,403]as const)test(`F4 ${kind} refresh${status} loses write qualification without losing save`,async()=>{const {c,m}=await authScenario(kind,status);assert.equal(m.state.outcome?.state,'saved');assert.equal(m.state.pending,null);assert.equal(c.snapshot().authenticated,false);assert.equal(c.snapshot().fresh,false);});
}
for(const kind of ['submit','recover']as const)for(const status of [401,403]as const)test(`F4 ${kind} malformed refresh${status} is unverified but still revokes qualification`,async()=>{const {c,m}=await authScenario(kind,status,true);assert.equal(m.state.outcome?.state,'saved');assert.equal(m.state.pending,null);assert.equal(c.snapshot().authenticated,false);assert.equal(c.snapshot().fresh,false);});
test('F3 original response GET is saved evidence even if current view GET is unavailable',async()=>{const {c,m}=await authScenario('recover',503);assert.equal(m.state.pending,null);assert.equal(m.state.outcome?.state,'saved');assert.equal(c.snapshot().fresh,false);assert.match(c.snapshot().message,/确认服务保存.*当前结果刷新失败/);});
