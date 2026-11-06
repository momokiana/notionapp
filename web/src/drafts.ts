import { event, same, type Event, type Action } from './contracts.ts';
import type { Api, Connection } from './api.ts';
import { draft, template, draftConnection, sameDraftTarget, type Draft, type Template, type DraftReview } from './draft-data.ts';
import { workspace, type Store, type Lock, type WorkspaceRoot } from './storage.ts';
export function requireDraft(r: WorkspaceRoot,d: Draft): Draft {
  const current=r.drafts.find(x=>x.id===d.id);
  if(!current||!same(current,d))throw new Error('草稿已改变或已进入提交槽，请重新读取');
  return current;
}
export class DraftBook {
  constructor(readonly store:Store,readonly lock:Lock){}
  private async write(check:()=>void,change:(r:WorkspaceRoot)=>WorkspaceRoot){
    return this.lock(async()=>{
      check();await this.store.change(r=>{check();const next=change(workspace(r));
        if(!same(r.pending,next.pending)||!same(r.outcome,next.outcome))throw new Error('STORAGE_PENDING_CHANGED');
        return next;
      });check();
    });
  }
  async save(c:Connection,e:Event,a:Action,value:string,check:()=>void,previous?:Draft):Promise<Draft>{
    if([...value].length>4000)throw new Error('草稿文字最多4000个字符，不会截断');
    if(previous&&!draftConnection(previous,c))throw new Error('草稿属于另一连接，请使用原凭据');
    const base=previous?.event??e,chosen=previous?.action??a;
    const d=draft({id:previous?.id??crypto.randomUUID(),revision:(previous?.revision??0)+1,namespace:c.namespace,root:c.root,deployment:c.deployment,fingerprint:c.fingerprint,event:base,action:chosen,text:chosen.type==='button'?'':value,saved_at:new Date().toISOString()});
    await this.write(check,r=>{
      if(previous)requireDraft(r,previous);
      else if(r.drafts.length>=8)throw new Error('草稿已达8份上限，请明确删除不再需要的未提交草稿');
      return {...r,drafts:previous?r.drafts.map(x=>x.id===d.id?d:x):[...r.drafts,d]};
    });return d;
  }
  async remove(c:Connection,d:Draft,check:()=>void){
    if(!draftConnection(d,c))throw new Error('草稿属于另一连接，不能在当前namespace删除');
    await this.write(check,r=>{requireDraft(r,d);return {...r,drafts:r.drafts.filter(x=>x.id!==d.id)};});
  }
  async saveTemplate(title:string,body:string,check:()=>void,previous?:Template):Promise<Template>{
    if(!title.trim()||[...title].length>40||!body.trim()||[...body].length>1000)throw new Error('模板标题需1至40字符，正文需1至1000字符，空白不能单独保存');
    const t=template({id:previous?.id??crypto.randomUUID(),revision:(previous?.revision??0)+1,title,text:body,saved_at:new Date().toISOString()});
    await this.write(check,r=>{
      if(previous){if(!r.templates.some(x=>same(x,previous)))throw new Error('模板已改变，请重新读取');}
      else if(r.templates.length>=12)throw new Error('模板已达12份上限，请先明确删除不用的模板');
      return {...r,templates:previous?r.templates.map(x=>x.id===t.id?t:x):[...r.templates,t]};
    });return t;
  }
  async removeTemplate(t:Template,check:()=>void){
    await this.write(check,r=>{if(!r.templates.some(x=>same(x,t)))throw new Error('模板已改变，请重新读取');return {...r,templates:r.templates.filter(x=>x.id!==t.id)};});
  }
  async review(api:Api,d:Draft):Promise<DraftReview>{
    return this.lock(async()=>{
      api.assertCurrent();if(!draftConnection(d,api.c))throw new Error('草稿属于另一连接，请使用原凭据');
      const r=workspace(await this.store.read());requireDraft(r,d);
      if(r.pending)throw new Error('原请求待核实，先查询原请求，不核对第二份发送');
      const current=event(await api.request('/v1/events/'+d.event.id));api.assertCurrent();
      if(!sameDraftTarget(d,current)||!current.can_respond)throw new Error('原问题、目标、期限或资格已改变，保留原草稿，不自动重绑');
      if(d.action.type==='text'&&!d.text.trim())throw new Error('草稿正文仍为空白，请先编辑并明确保存');
      return {draft:structuredClone(d),current};
    });
  }
}
