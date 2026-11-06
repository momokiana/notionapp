import { action, event, id, integer, object, same, text, type Action, type Event } from './contracts.ts';
import type { Connection } from './api.ts';
export interface Draft {
  id: string; revision: number; namespace: string; root: string; deployment: string; fingerprint: string;
  event: Event; action: Action; text: string; saved_at: string;
}
export interface Template { id: string; revision: number; title: string; text: string; saved_at: string }
export interface DraftReview { draft: Draft; current: Event }
const keys = (o: Record<string, unknown>, expected: string[]) => Object.keys(o).length === expected.length && expected.every(k => Object.hasOwn(o,k));
function digest(v: unknown) { const s=text(v,64);if(!/^[a-f0-9]{64}$/.test(s))throw new Error('STORAGE_CORRUPT');return s; }
function time(v: unknown) { const s=text(v,40);if(!Number.isFinite(Date.parse(s)))throw new Error('STORAGE_CORRUPT');return s; }
export function draft(v: unknown): Draft {
  const o=object(v);
  if(!keys(o,['id','revision','namespace','root','deployment','fingerprint','event','action','text','saved_at']))throw new Error('STORAGE_CORRUPT');
  const e=event(o.event),a=action(o.action),body=text(o.text,4000);
  if(!e.interaction?.actions.some(x=>same(x,a))||(a.type==='button'&&body!==''))throw new Error('STORAGE_CORRUPT');
  return {id:id(o.id),revision:integer(o.revision,1),namespace:digest(o.namespace),root:text(o.root,2048),deployment:text(o.deployment,2048),fingerprint:digest(o.fingerprint),event:e,action:a,text:body,saved_at:time(o.saved_at)};
}
export function template(v: unknown): Template {
  const o=object(v);
  if(!keys(o,['id','revision','title','text','saved_at']))throw new Error('STORAGE_CORRUPT');
  const title=text(o.title,40),body=text(o.text,1000);
  if(!title.trim()||!body.trim())throw new Error('模板标题和正文不能为空');
  return {id:id(o.id),revision:integer(o.revision,1),title,text:body,saved_at:time(o.saved_at)};
}
export function draftConnection(d: Draft,c: Connection): boolean {return d.namespace===c.namespace&&d.root===c.root&&d.deployment===c.deployment&&d.fingerprint===c.fingerprint;}
export function sameDraftTarget(d: Draft,e: Event): boolean {
  const old=d.event;
  return e.id===old.id&&e.owner_id===old.owner_id&&e.source_id===old.source_id&&e.source_epoch===old.source_epoch&&e.session_ref===old.session_ref&&e.target_revision===old.target_revision&&e.expires_at===old.expires_at&&e.event_version>=old.event_version&&e.interaction?.id===old.interaction?.id&&e.interaction_version===old.interaction_version&&!!e.interaction?.actions.some(a=>same(a,d.action));
}
