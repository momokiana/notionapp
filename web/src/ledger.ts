import { Api, HttpError, exactKeys, type Connection } from './api.ts';
import { confirmation, event, integer, object, response, same, type Event, type Action, type Disposition } from './contracts.ts';
import { pending, workspace, type Store, type Lock, type Pending, type Kind } from './storage.ts';
import { draftConnection, sameDraftTarget, type Draft, type DraftReview } from './draft-data.ts';
import { requireDraft } from './drafts.ts';

export const knownRejection = (e: unknown): e is HttpError => e instanceof HttpError && (
  (e.status === 409 && ['EVENT_VERSION_CONFLICT','INTERACTION_VERSION_CONFLICT','ACTION_ALREADY_RESERVED','SOURCE_READ_ONLY','EVENT_CLOSED'].includes(e.code)) ||
  (e.status === 410 && e.code === 'ACTION_EXPIRED') || (e.status === 422 && e.code === 'INVALID_INPUT')
);
export function matchResponse(p: Pending, raw: unknown) {
  const r = response(raw), e = p.event, a = e.interaction?.actions.find(a => a.id === p.body.action_id);
  if (p.kind !== 'response' || r.id !== p.id || r.event_id !== e.id || r.event_version_seen !== e.event_version || r.interaction_id !== e.interaction?.id || r.interaction_version !== e.interaction_version || !same(r.action, a) || r.text !== p.body.text || r.expires_at !== e.expires_at || !same(r.target, { source_id: e.source_id, source_epoch: e.source_epoch, session_ref: e.session_ref, state_revision: e.target_revision }) || (p.actor && r.actor_id !== p.actor)) throw new Error('原回应与本机意图不匹配，保留未决记录');
  return r;
}
export class Ledger {
  constructor(readonly store: Store, readonly lock: Lock) {}
  private async finish(p: Pending, state: 'saved' | 'rejected', code = '') {
    await this.store.change(r => {
      if (!r.pending || !same(r.pending, p)) throw new Error('STORAGE_PENDING_CHANGED');
      const base=state==='rejected'&&p.draft_restore?workspace(r):r;
      if(state==='rejected'&&p.draft_restore){
        const w=workspace(base);
        if(w.drafts.length>=8||w.drafts.some(d=>d.id===p.draft_restore!.id))throw new Error('STORAGE_DRAFT_RESTORE_CONFLICT');
        return {...w,drafts:[...w.drafts,p.draft_restore],pending:null,outcome:{id:p.id,event_id:p.event.id,kind:p.kind,state,at:new Date().toISOString(),code}};
      }
      return { ...base, pending: null, outcome: { id: p.id, event_id: p.event.id, kind: p.kind, state, at: new Date().toISOString(), code } };
    });
  }
  async submit(api: Api, viewed: Event, kind: Kind, selection?: Action | Disposition, value = '', actor: string | null = null): Promise<string> {
    return this.lock(()=>this.submitLocked(api,viewed,kind,selection,value,actor));
  }
  async submitDraft(api:Api,review:DraftReview,actor:string|null=null):Promise<string>{
    return this.lock(async()=>{
      api.assertCurrent();
      if(!draftConnection(review.draft,api.c)||!sameDraftTarget(review.draft,review.current)||!review.current.can_respond)throw new Error('草稿核对已失效，请重新核对');
      return this.submitLocked(api,review.current,'response',review.draft.action,review.draft.text,actor,review.draft);
    });
  }
  // Caller already owns the one Web Lock. Draft submission never nests public submit().
  private async submitLocked(api:Api,viewed:Event,kind:Kind,selection?:Action|Disposition,value='',actor:string|null=null,originDraft?:Draft):Promise<string>{
      api.assertCurrent();
      const before=await this.store.read();
      if (before.pending) throw new Error('已有未决提交，先查原请求，不生成新ID');
      if(originDraft)requireDraft(workspace(before),originDraft);
      const current = event(await api.request('/v1/events/' + viewed.id));
      if (!same(confirmation(current), confirmation(viewed))) throw new Error('事件或问题已变化，请刷新详情并重新确认');
      const request_id = crypto.randomUUID(); let body: Record<string, unknown>;
      if (kind === 'response') {
        const a = typeof selection === 'object' && current.interaction?.actions.find(a => same(a, selection));
        if (!a || !current.can_respond) throw new Error('当前问题不可回应，请刷新');
        if ([...value].length > 4000 || (a.type === 'text' && !value.trim())) throw new Error('请输入1到4000个字符，空白不能单独提交');
        body = { response_id: request_id, event_version: current.event_version, interaction_id: current.interaction!.id, interaction_version: current.interaction!.version, action_id: a.id, text: a.type === 'button' ? '' : value };
      } else if (kind === 'read') body = { event_version: current.event_version };
      else body = { request_id, expected_event_version: current.event_version, disposition: selection };
      let p = pending({ id: request_id, kind, namespace: api.c.namespace, root: api.c.root, deployment: api.c.deployment, fingerprint: api.c.fingerprint, event: current, actor, body,
        path: '/v1/events/' + current.id + (kind === 'response' ? '/responses' : kind === 'read' ? '/read-state' : '/disposition'), method: kind === 'read' ? 'PUT' : 'POST', stage: 'prepared', created_at: new Date().toISOString(),...(originDraft?{draft_restore:originDraft}:{}) });
      api.assertCurrent();
      await this.store.change(r => {
        if (r.pending) throw new Error('STORAGE_PENDING_CHANGED');
        if(originDraft){const w=workspace(r);requireDraft(w,originDraft);return {...w,drafts:w.drafts.filter(d=>d.id!==originDraft.id),pending:p};}
        return { ...r, pending: p };
      });
      api.assertCurrent();
      const prepared = p; p = { ...p, stage: 'unknown' };
      await this.store.change(r => { if (!same(r.pending, prepared)) throw new Error('STORAGE_PENDING_CHANGED'); return { ...r, pending: p }; });
      // A lifecycle change here leaves the durable original intent intact, never a new ID.
      api.assertCurrent();
      let ack: unknown;
      try { ack = await api.request(p.path, p.method, p.body); }
      catch (e) {
        if (knownRejection(e)) await this.finish(p, 'rejected', e.code);
        throw e;
      }
      const o = object(ack);
      if (o.event_id !== p.event.id) throw new Error('INVALID_SERVER_DATA');
      const timestamp = () => typeof o.saved_at === 'string' && o.saved_at.length <= 40 && Number.isFinite(Date.parse(o.saved_at));
      if (kind === 'response') { if (!exactKeys(o, ['event_id', 'response_id', 'saved_at']) || o.response_id !== p.id || !timestamp()) throw new Error('INVALID_SERVER_DATA'); }
      else if (kind === 'read') { if (!exactKeys(o, ['event_id', 'read_version']) || integer(o.read_version, 1) < p.event.event_version) throw new Error('INVALID_SERVER_DATA'); }
      else if (!exactKeys(o, ['event_id', 'event_version', 'saved_at']) || integer(o.event_version, 1) !== p.event.event_version + 1 || !timestamp()) throw new Error('INVALID_SERVER_DATA');
      api.assertCurrent();
      await this.finish(p, 'saved');
      return request_id;
  }
  async recover(api: Api): Promise<{ saved: boolean; message: string; eventId: string }> {
    return this.lock(async () => {
      api.assertCurrent();
      const p = (await this.store.read()).pending;
      if (!p) throw new Error('没有未决请求');
      if (!matchesConnection(p, api.c)) throw new Error('未决属于另一连接/凭据，请重新输入准确原凭据，不迁移身份');
      if (p.kind === 'response') {
        matchResponse(p, await api.request('/v1/responses/' + p.id));
        // The authenticated original response and its complete immutable binding are
        // the saved fact. Current-view availability must not erase that fact.
        api.assertCurrent(); await this.finish(p, 'saved');
        return { saved: true, message: '已按原回应ID核到服务保存事实，没有重新发送', eventId: p.event.id };
      }
      const e = event(await api.request('/v1/events/' + p.event.id));
      return { saved: false, eventId: p.event.id, message: p.kind === 'read' ? `已观察阅读进度 v${e.read_state.version}，原PUT结果仍未知，未清槽` : '已读取当前事项；服务不提供原request_id查询，不能凭相同决定认定原请求成功，未清槽' };
    });
  }
}
export function matchesConnection(p: Pending, c: Connection): boolean { return p.namespace === c.namespace && p.root === c.root && p.deployment === c.deployment && p.fingerprint === c.fingerprint; }
