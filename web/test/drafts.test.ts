import test from 'node:test';
import assert from 'node:assert/strict';
import {Api,connection,Stale} from '../src/api.ts';
import {event,type Event} from '../src/contracts.ts';
import {DraftBook} from '../src/drafts.ts';
import {Ledger} from '../src/ledger.ts';
import {root,workspace,MAX_STATE_BYTES,type Root,type Store,type Lock} from '../src/storage.ts';
import {draft} from '../src/draft-data.ts';
import {Client} from '../src/client.ts';
const sample=():Event=>event({id:'draft_event',owner_id:'owner',source_id:'source',source_epoch:'epoch',title:'原问题',body:'原正文',session_ref:'session',target_revision:'revision',expires_at:'2099-01-01T00:00:00Z',event_version:1,interaction_version:1,interaction:{id:'question',version:1,actions:[{id:'yes',label:'继续',type:'button'},{id:'text',label:'补充',type:'text'}]},reserved_response_id:null,disposition:'open',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',read_state:{version:0,unread:true},can_respond:true,source_delivery:null,notification_delivery:null,previous_notification_delivery:null,delivery_state:'not_observed',verification:'not_verified'});
class Memory implements Store{
  r:Root={schema:1,store_id:'original_store',pending:null,outcome:null};changes=0;failAt=0;
  async status():Promise<'ready'>{return 'ready';}async initialize(){}
  async read(){return structuredClone(this.r);}
  async change(fn:(r:Root)=>Root){if(++this.changes===this.failAt)throw new Error('STORAGE_TRANSACTION_FAILED');this.r=root(fn(structuredClone(this.r)));}
}
function nonReentrant():Lock{let held=false;return async fn=>{if(held)throw new Error('LOCK_REENTRANT');held=true;try{return await fn();}finally{held=false;}};}
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
async function fixture(mode='ok'){
  const c=await connection('http://127.0.0.1','draft-test','a'.repeat(64)),e=sample(),store=new Memory(),lock=nonReentrant(),book=new DraftBook(store,lock),ledger=new Ledger(store,lock);
  const requests:{path:string;method:string;body:any}[]=[];let receipt:any;
  const fetcher=(async(u:RequestInfo|URL,o?:RequestInit)=>{
    const path=String(u),method=o?.method??'GET';requests.push({path,method,body:o?.body?JSON.parse(String(o.body)):null});
    if(method==='POST'){
      const b=JSON.parse(String(o!.body));receipt={id:b.response_id,event_id:e.id,actor_id:'device',created_at:'2026-01-01T00:00:00Z',event_version_seen:b.event_version,interaction_id:b.interaction_id,interaction_version:b.interaction_version,action:e.interaction!.actions.find(a=>a.id===b.action_id),text:b.text,expires_at:e.expires_at,target:{source_id:e.source_id,source_epoch:e.source_epoch,session_ref:e.session_ref,state_revision:e.target_revision},eligibility_state:'waiting_source',eligibility_reason:'NOT_DELIVERED',routing_state:'waiting_source',reason_code:'NOT_DELIVERED',source_delivery:null,execution_state:'not_observed',verification:'not_verified',execution_authorized:false};
      if(mode==='drop')throw new TypeError('synthetic ACK loss');if(mode==='reject')return json({error:{code:'EVENT_VERSION_CONFLICT',message:'strict rejection'}},409);
      if(mode==='bad-rejection')return json({error:{code:'EVENT_VERSION_CONFLICT'}},409);
      return json({event_id:e.id,response_id:b.response_id,saved_at:'2026-01-01T00:00:00Z'});
    }
    if(path.includes('/responses/'))return json(receipt);
    if(path.includes('/events?'))return json({items:[e],next_after:null});
    if(path.endsWith('/device/self')||path.includes('/source-runtime/'))return json({error:{code:'NOT_FOUND',message:'not configured'}},404);
    if(path.includes('/history?'))return json({items:[],next_after:null});
    return json(e);
  })as typeof fetch;
  const api=new Api(c,()=>{},fetcher);
  return {c,e,store,lock,book,ledger,api,fetcher,requests,writes:()=>requests.filter(r=>r.method!=='GET'),save:()=>book.save(c,e,e.interaction!.actions[1],'  草稿🙂\n原文  ',()=>{})};
}
test('schema1 read is not a persisted migration; first explicit save migrates exactly and sends zero HTTP',async()=>{
  const x=await fixture();assert.equal(workspace(await x.store.read()).schema,2);assert.equal(Number(x.store.r.schema),1);
  x.store.r.outcome={id:'old_id',event_id:'old_event',kind:'read',state:'saved',at:'2026-01-01T00:00:00Z',code:''};const before=structuredClone(x.store.r.outcome);
  const d=await x.save();assert.equal(x.store.r.schema,2);assert.equal(x.store.r.store_id,'original_store');assert.deepEqual(x.store.r.outcome,before);assert.equal(workspace(x.store.r).drafts[0].text,d.text);assert.equal(x.requests.length,0);
  const reopened=root(JSON.parse(JSON.stringify(x.store.r)));assert.deepEqual(workspace(reopened).drafts,[d]);
});
for(const stage of ['prepared','unknown']as const)test(`migration preserves exact old ${stage} pending and outcome`,async()=>{
  const x=await fixture('drop');await assert.rejects(()=>x.ledger.submit(x.api,x.e,'response',x.e.interaction!.actions[0]));x.store.r.pending!.stage=stage;
  x.store.r.outcome={id:'earlier',event_id:'old_event',kind:'read',state:'saved',at:'2026-01-01T00:00:00Z',code:''};const pending=structuredClone(x.store.r.pending),outcome=structuredClone(x.store.r.outcome),writes=x.writes().length;
  await x.book.saveTemplate('确认','  模板🙂  ',()=>{});assert.equal(x.store.r.schema,2);assert.deepEqual(x.store.r.pending,pending);assert.deepEqual(x.store.r.outcome,outcome);assert.equal(x.writes().length,writes);
});
test('migration transaction failure leaves exact original legacy state',async()=>{const x=await fixture(),old=JSON.stringify(x.store.r);x.store.failAt=1;await assert.rejects(()=>x.save());assert.equal(JSON.stringify(x.store.r),old);assert.equal(x.requests.length,0);});
test('Unicode draft edits are full-CAS, namespace isolated, and never HTTP',async()=>{
  const x=await fixture(),d=await x.save(),b=await connection('http://127.0.0.1','draft-test','b'.repeat(64));
  await assert.rejects(()=>x.book.remove(b,d,()=>{}));await assert.rejects(()=>x.book.save(b,d.event,d.action,'wrong',()=>{},d));
  const next=await x.book.save(x.c,d.event,d.action,'🙂'.repeat(4000),()=>{},d);assert.equal(next.revision,2);assert.equal([...next.text].length,4000);
  await assert.rejects(()=>x.book.save(x.c,d.event,d.action,'late',()=>{},d));await assert.rejects(()=>x.book.remove(x.c,d,()=>{}));assert.deepEqual(workspace(x.store.r).drafts,[next]);assert.equal(x.requests.length,0);
});
test('draft/template quantities, fields and total bytes reject without changing prior root',async()=>{
  const x=await fixture();for(let i=0;i<8;i++)await x.book.save(x.c,x.e,x.e.interaction!.actions[0],'',()=>{});let old=JSON.stringify(x.store.r);await assert.rejects(()=>x.save());assert.equal(JSON.stringify(x.store.r),old);
  for(let i=0;i<12;i++)await x.book.saveTemplate('模板'+i,'完整原文',()=>{});old=JSON.stringify(x.store.r);await assert.rejects(()=>x.book.saveTemplate('第13条','x',()=>{}));assert.equal(JSON.stringify(x.store.r),old);
  await assert.rejects(()=>x.book.saveTemplate('x'.repeat(41),'x',()=>{}));await assert.rejects(()=>x.book.saveTemplate('x','🙂'.repeat(1001),()=>{}));assert.equal(JSON.stringify(x.store.r),old);
  const y=await fixture();y.e.body='🙂'.repeat(16000);await y.save();assert.ok(new TextEncoder().encode(JSON.stringify(y.store.r)).length<MAX_STATE_BYTES);let rejected=false;for(let i=1;i<8;i++){const before=JSON.stringify(y.store.r);try{await y.save();}catch(error){assert.match(String(error),/STORAGE_CAPACITY_EXCEEDED/);assert.equal(JSON.stringify(y.store.r),before);rejected=true;break;}}assert.equal(rejected,true);
});
test('templates edit/delete preserve exact pending, stale revision refuses and insertion needs no transport',async()=>{
  const x=await fixture('drop');await assert.rejects(()=>x.ledger.submit(x.api,x.e,'response',x.e.interaction!.actions[0]));const p=structuredClone(x.store.r.pending),writes=x.writes().length;
  const t=await x.book.saveTemplate('回应','  先检查🙂\n再处理  ',()=>{});const next=await x.book.saveTemplate('回应2',t.text,()=>{},t);await assert.rejects(()=>x.book.removeTemplate(t,()=>{}));await x.book.removeTemplate(next,()=>{});assert.deepEqual(x.store.r.pending,p);assert.equal(x.writes().length,writes);
});
for(const change of ['owner_id','source_id','source_epoch','session_ref','target_revision','expires_at','interaction','action','eligibility']as const)test(`review refuses changed ${change}, retains draft and makes no POST`,async()=>{
  const x=await fixture(),d=await x.save();
  if(change==='interaction')x.e.interaction={...x.e.interaction!,id:'new_question'};
  else if(change==='action')x.e.interaction!.actions[1]={...x.e.interaction!.actions[1],label:'Changed'};
  else if(change==='eligibility')x.e.can_respond=false;
  else x.e[change]=change==='expires_at'?'2098-01-01T00:00:00Z':'different';
  await assert.rejects(()=>x.book.review(x.api,d));assert.deepEqual(workspace(x.store.r).drafts,[d]);assert.equal(x.writes().length,0);
});
test('progress v1 to v2 requires a new confirmation, same lock submits once and removes only original draft',async()=>{
  const x=await fixture(),d=await x.save();x.e.event_version=2;x.e.body='当前进展后的正文';const reviewed=await x.book.review(x.api,d);assert.equal(reviewed.current.event_version,2);assert.equal(reviewed.draft.event.event_version,1);assert.equal(x.writes().length,0);
  const id=await x.ledger.submitDraft(x.api,reviewed);assert.equal(x.writes().length,1);assert.equal(x.writes()[0].body.response_id,id);assert.equal(x.writes()[0].body.text,d.text);assert.equal(x.store.r.pending,null);assert.equal(workspace(x.store.r).drafts.length,0);assert.equal(x.store.r.outcome?.state,'saved');
});
for(const phase of [1,2])test(`draft transfer failure phase${phase}: zero POST, correct one durable material location`,async()=>{
  const x=await fixture(),d=await x.save(),reviewed=await x.book.review(x.api,d);x.store.failAt=x.store.changes+phase;
  await assert.rejects(()=>x.ledger.submitDraft(x.api,reviewed));assert.equal(x.writes().length,0);
  if(phase===1){assert.equal(x.store.r.pending,null);assert.deepEqual(workspace(x.store.r).drafts,[d]);}
  else{assert.equal(workspace(x.store.r).drafts.length,0);assert.equal(x.store.r.pending?.stage,'prepared');assert.deepEqual(x.store.r.pending?.draft_restore,d);}
});
test('strict current first refusal atomically restores original draft; later rejection after unknown never does',async()=>{
  const x=await fixture('reject'),d=await x.save(),reviewed=await x.book.review(x.api,d);await assert.rejects(()=>x.ledger.submitDraft(x.api,reviewed));assert.equal(x.store.r.pending,null);assert.deepEqual(workspace(x.store.r).drafts,[d]);assert.equal(x.store.r.outcome?.state,'rejected');
  const y=await fixture('drop'),dy=await y.save(),ry=await y.book.review(y.api,dy);await assert.rejects(()=>y.ledger.submitDraft(y.api,ry));const before=JSON.stringify(y.store.r);
  const bad=new Api(y.c,()=>{},(async()=>json({error:{code:'EVENT_VERSION_CONFLICT',message:'later rejection'}},409))as typeof fetch);await assert.rejects(()=>y.ledger.recover(bad));assert.equal(JSON.stringify(y.store.r),before);assert.equal(workspace(y.store.r).drafts.length,0);
});
test('malformed first rejection keeps unknown and exact restore material, no second draft',async()=>{const x=await fixture('bad-rejection'),d=await x.save(),r=await x.book.review(x.api,d);await assert.rejects(()=>x.ledger.submitDraft(x.api,r));assert.equal(x.store.r.pending?.stage,'unknown');assert.deepEqual(x.store.r.pending?.draft_restore,d);assert.equal(workspace(x.store.r).drafts.length,0);});
test('ACK loss and new Ledger preserve unique original response ID and never restore a duplicate draft',async()=>{
  const x=await fixture('drop'),d=await x.save(),r=await x.book.review(x.api,d);await assert.rejects(()=>x.ledger.submitDraft(x.api,r));const p=structuredClone(x.store.r.pending);assert.equal(workspace(x.store.r).drafts.length,0);
  const recovered=await new Ledger(x.store,x.lock).recover(x.api);assert.equal(recovered.saved,true);assert.equal(x.writes().length,1);assert.equal(x.store.r.pending,null);assert.equal(x.store.r.outcome?.id,p?.id);assert.equal(workspace(x.store.r).drafts.length,0);
});
test('draft changed in another tab after review cannot enter Pending or fetch a new intent',async()=>{
  const x=await fixture(),d=await x.save(),r=await x.book.review(x.api,d);await x.book.save(x.c,d.event,d.action,'new version',()=>{},d);const requests=x.requests.length;await assert.rejects(()=>x.ledger.submitDraft(x.api,r));assert.equal(x.requests.length,requests);assert.equal(x.store.r.pending,null);
});
test('event changes after review and lifecycle invalidation before transfer both refuse without POST',async()=>{
  const x=await fixture(),d=await x.save(),r=await x.book.review(x.api,d);x.e.event_version++;await assert.rejects(()=>x.ledger.submitDraft(x.api,r));assert.deepEqual(workspace(x.store.r).drafts,[d]);assert.equal(x.writes().length,0);
  await assert.rejects(()=>x.ledger.submitDraft(new Api(x.c,()=>{throw new Stale();},x.fetcher),r));assert.equal(x.writes().length,0);
});
test('root schema2 rejects duplicate draft/pending material and malformed layout, legacy root never carries restore data',async()=>{
  const x=await fixture('drop'),d=await x.save(),r=await x.book.review(x.api,d);await assert.rejects(()=>x.ledger.submitDraft(x.api,r));const w=workspace(x.store.r);
  assert.throws(()=>root({...w,drafts:[d]}));assert.throws(()=>root({...w,schema:3}));assert.throws(()=>root({...w,schema:1}));assert.throws(()=>draft({...d,revision:0}));
});
test('API-down reload builds local namespace and lists stored drafts before any successful server/self read',async()=>{
  const x=await fixture(),d=await x.save();let writes=0;
  const offline=(async(_u:RequestInfo|URL,o?:RequestInit)=>{if(o?.method!=='GET')writes++;throw new TypeError('API offline');})as typeof fetch;
  const client=new Client('http://127.0.0.1','draft-test',x.store,x.lock,offline);await client.start();await client.connect('a'.repeat(64));assert.equal(client.snapshot().authenticated,false);assert.deepEqual(client.snapshot().drafts,[d]);assert.equal(writes,0);
  await client.connect('b'.repeat(64));assert.equal(client.snapshot().drafts.length,0);assert.equal(client.snapshot().isolatedDrafts,1);assert.equal(writes,0);
});
test('unsaved edits/template insertion, page lifecycle and reconnect ABA invalidate Client review',async()=>{
  const x=await fixture(),d=await x.save(),c=new Client('http://127.0.0.1','draft-test',x.store,x.lock,x.fetcher);await c.connect('a'.repeat(64));await c.reviewDraft(d);assert.ok(c.snapshot().review);c.invalidateReview();assert.equal(c.snapshot().review,null);await c.submitReviewedDraft();assert.equal(x.writes().length,0);
  await c.reviewDraft(d);c.lifecycle(false);c.lifecycle(true);assert.equal(c.snapshot().review,null);await c.submitReviewedDraft();assert.equal(x.writes().length,0);
  await c.reviewDraft(d);await c.connect('b'.repeat(64));await c.connect('a'.repeat(64));assert.equal(c.snapshot().review,null);assert.equal(x.writes().length,0);
});
test('editor invalidation after final GET but before fetch keeps one original material and zero POST',async()=>{
  const x=await fixture(),d=await x.save(),r=await x.book.review(x.api,d);let checks=0,active=true;const api=new Api(x.c,()=>{checks++;if(!active)throw new Stale();},x.fetcher);
  const change=x.store.change.bind(x.store);x.store.change=async fn=>{await change(fn);if(x.store.r.pending)active=false;};
  await assert.rejects(()=>x.ledger.submitDraft(api,r));assert.ok(checks>0);assert.equal(x.writes().length,0);assert.equal(workspace(x.store.r).drafts.length,0);assert.deepEqual(x.store.r.pending?.draft_restore,d);
});
