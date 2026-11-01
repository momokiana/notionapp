import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { parseRegistry, validId } from 'notification-server/auth';
import { pushConfig } from 'notification-server/notifications';
import { assertLedgerBackupDatabase, withReadOnlyBackupImage } from 'notification-server/backup-validation';
import { assertDeviceBackupDatabase } from 'notification-server/device-store';
import { parseExpiry } from 'notification-server/core';
import type { Command, NativeReceipt } from 'notification-server/delivery';
import type { EventData, ResponseData } from 'notification-server/contracts';
import { backupHash, openBackupArchive, type BackupMaterial, type BackupRecordName } from './backup-format.js';
import { writeBackupFileExclusive } from './backup-files.js';
import { canonical, digest, HostError, noSymlinks, record, requireHost, stableId } from './private-files.js';
import { modelBudget } from './model-budget.js';
import { defaultPrompt } from './config.js';
import { responseType, validateNativeBackupBytes } from './native.js';
import { validateRuntimeBackupJournal } from './runtime.js';

function valid(condition: unknown): asserts condition { requireHost(condition, 'BACKUP_MATERIAL_INVALID'); }
const json = (bytes: Buffer): Record<string, unknown> => {
  try { const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); valid(record(v)); return v as Record<string, unknown>; }
  catch { throw new HostError('BACKUP_MATERIAL_INVALID'); }
};
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const absolute = (v: unknown): v is string => typeof v === 'string' && isAbsolute(v) && resolve(v) === v;
const pair = (owner: string, id: string) => JSON.stringify([owner, id]);
const inside = (path: string, directory: string) => path === directory || path.startsWith(directory.endsWith('/') ? directory : directory + '/');

/** Archived paths never authorize IO; they also cannot be selected as output locations that would damage original roles. */
export function assertBackupOutputSeparation(material: BackupMaterial, output: string): void {
  valid(absolute(output)); const config = material.records.find(r => r.name === 'config'); valid(config);
  const cfg = json(config.bytes); valid(absolute(cfg.data_dir));
  requireHost(!inside(output, cfg.data_dir), 'BACKUP_OUTPUT_OVERLAP');
  const identity = record(cfg.identity_reference) ? cfg.identity_reference : undefined;
  const push = record(cfg.push) ? cfg.push : undefined; const device = record(cfg.device_auth) ? cfg.device_auth : undefined;
  const files = [material.metadata.origin_config_file, cfg.auth_file, cfg.initial_prompt_file, cfg.system_prompt_file, identity?.persona_file, identity?.settings_file, identity?.credentials_file, push?.token_file, device?.path];
  for (const file of files) if (typeof file === 'string') requireHost(output !== file && !output.startsWith(file + '.') && !output.startsWith(file + '-'), 'BACKUP_OUTPUT_OVERLAP');
}
interface EventRow { id: string; owner: string; source: string; epoch: string; data: string }
interface ResponseRow extends EventRow { event_id: string; interaction_id: string; interaction_version: number }
interface CommandRow extends EventRow { response_id: string; event_id: string; attempted: number; receipt: string | null }
interface StoredCommand { row: CommandRow; command: Command; receipt: NativeReceipt | null }

export interface BackupInspection {
  format: 1; snapshot_id: string; captured_at: string; records: number; native_entries: number; native_inputs: number; native_inputs_without_public_receipt: number;
  events: number; responses: number; commands: number; history: number; historical_receipts: number;
  model_request_intents: number; model_http_attempts: number; report_intents: number;
  authority_present: boolean; external_references_checked: false; current_permissions_verified: false;
  active_restore_supported: false; original_durability_ack_reconstructed: false; private_derived_verification_files_retained: true;
}

/** Envelope authentication precedes all parsing/scratch. Original paths are evidence only, never IO targets here. */
export function inspectBackupArchive(archive: Buffer, key: Buffer): { material: BackupMaterial; inspection: BackupInspection } {
  const material = openBackupArchive(archive, key); const m = material.metadata; const b = m.selection.source;
  const records = new Map(material.records.map(r => [r.name, r.bytes]));
  const bytes = (name: BackupRecordName) => { const value = records.get(name); valid(value); return value!; };
  const cfg = json(bytes('config'));
  valid(Object.keys(cfg).every(k => ['data_dir','auth_file','initial_prompt_file','system_prompt_file','identity_reference','source','model','model_budget','allow_model_calls','listen','push','device_auth'].includes(k)));
  valid(absolute(cfg.data_dir) && absolute(cfg.auth_file) && absolute(cfg.initial_prompt_file));
  valid(canonical(cfg.source) === canonical(b) && record(cfg.model)
    && canonical({ ...cfg.model, thinking: cfg.model.thinking ?? 'off' }) === canonical(m.selection.model)
    && canonical(modelBudget(cfg.model_budget)) === canonical(m.selection.model_budget));
  valid(cfg.allow_model_calls === undefined || typeof cfg.allow_model_calls === 'boolean');
  valid((cfg.identity_reference !== undefined) === (m.selection.identity_fingerprint !== null));
  if (cfg.identity_reference !== undefined) {
    const ref=cfg.identity_reference;
    valid(record(ref)&&keys(ref,['name','persona_file','persona_sha256','settings_file','credentials_file'])&&typeof ref.name==='string'&&ref.name.trim()&&[...ref.name].length<=200&&!/[\u0000-\u001f\u007f]/u.test(ref.name)
      &&absolute(ref.persona_file)&&absolute(ref.settings_file)&&absolute(ref.credentials_file)&&typeof ref.persona_sha256==='string'&&/^[a-f0-9]{64}$/.test(ref.persona_sha256)
      &&digest({reference:ref,model:m.selection.model})===m.selection.identity_fingerprint);
  }
  if(cfg.listen!==undefined)valid(record(cfg.listen)&&keys(cfg.listen,['host','port'])&&typeof cfg.listen.host==='string'&&isIP(cfg.listen.host)!==0&&typeof cfg.listen.port==='number'&&Number.isInteger(cfg.listen.port)&&cfg.listen.port>=1&&cfg.listen.port<=65535);
  if(cfg.push!==undefined){valid(record(cfg.push)&&Object.keys(cfg.push).every(k=>['origin','token_file','allow_local_http'].includes(k))&&typeof cfg.push.origin==='string'&&(cfg.push.token_file===undefined||absolute(cfg.push.token_file))&&(cfg.push.allow_local_http===undefined||typeof cfg.push.allow_local_http==='boolean'));pushConfig(cfg.push.origin,undefined,cfg.push.allow_local_http===true);}
  valid((cfg.system_prompt_file !== undefined) === records.has('system-prompt'));
  if (cfg.system_prompt_file !== undefined) valid(absolute(cfg.system_prompt_file) && cfg.identity_reference === undefined && backupHash(bytes('system-prompt')) === m.selection.system_prompt_sha256);
  if (cfg.device_auth !== undefined) valid(record(cfg.device_auth) && keys(cfg.device_auth,['path','store_id']) && absolute(cfg.device_auth.path) && typeof cfg.device_auth.store_id === 'string');
  valid((cfg.device_auth !== undefined) === records.has('device-authority'));
  const registry = parseRegistry(json(bytes('registry'))); const source = registry.source(b.owner_id,b.source_id,b.source_epoch);
  valid(source?.id === b.principal_id && ['publish','reply','deliver','read_responses'].every(c => source.capabilities.includes(c)));
  const initial = new TextDecoder('utf-8',{fatal:true}).decode(bytes('initial-prompt'));
  valid(initial.trim() && [...initial].length <= 16000);
  if(cfg.identity_reference===undefined){
    const system=records.has('system-prompt')?new TextDecoder('utf-8',{fatal:true}).decode(bytes('system-prompt')):defaultPrompt;
    valid(system.trim()&&[...system].length<=16000&&backupHash(Buffer.from(system))===m.selection.system_prompt_sha256
      &&digest({source:b,model:m.selection.model,model_budget:m.selection.model_budget,identity:undefined,initial_prompt:initial,system_prompt:system})===m.binding_hash);
  }
  const manifest = json(bytes('manifest'));
  valid(keys(manifest,['version','sdk','binding_hash','native_id','session_file','cwd','prefix_hash']) && manifest.version === 1 && manifest.sdk === '1.4.0'
    && manifest.binding_hash === m.binding_hash && manifest.native_id === m.native_id && typeof manifest.session_file === 'string'
    && absolute(manifest.session_file) && dirname(manifest.session_file) === join(cfg.data_dir as string,'native') && basename(manifest.session_file).endsWith(`_${m.native_id}.jsonl`)
    && manifest.cwd === join(cfg.data_dir as string,'work'));
  const pending = {version:1,sdk:'1.4.0',binding_hash:m.binding_hash,native_id:m.native_id,session_file:manifest.session_file,cwd:manifest.cwd};
  if (records.has('initializing')) valid(canonical(json(bytes('initializing'))) === canonical(pending));
  const native = validateNativeBackupBytes({bindingHash:m.binding_hash,model:m.selection.model,initialPrompt:initial},{native_id:m.native_id,cwd:manifest.cwd as string},bytes('native'));
  valid(digest(native.entries.slice(0,4)) === manifest.prefix_hash);
  const journal = validateRuntimeBackupJournal(native.entries,m.binding_hash,m.native_id,m.selection.model_budget.request_limit);
  // Scratch is private and derived. Never use config.data_dir, manifest.session_file or any other archived path for IO.
  const scratchParent = resolve(tmpdir()); assertBackupOutputSeparation(material, scratchParent); noSymlinks(scratchParent);
  const scratch = mkdtempSync(join(scratchParent,'notifier-backup-verify-')); chmodSync(scratch,0o700);
  if (records.has('device-authority')) {
    const path=join(scratch,'authority-image.sqlite');writeBackupFileExclusive(path,bytes('device-authority'));
    withReadOnlyBackupImage(path,db=>assertDeviceBackupDatabase(db,(cfg.device_auth as {store_id:string}).store_id));
  }
  const ledgerPath=join(scratch,'ledger-image.sqlite');writeBackupFileExclusive(ledgerPath,bytes('ledger'));
  const inspection = withReadOnlyBackupImage(ledgerPath,db=>{
    assertLedgerBackupDatabase(db);
    const binding = db.prepare('SELECT digest,result FROM operations WHERE scope=? AND id=?').get(canonical(['pi_host_binding',m.binding_hash]),m.native_id) as {digest:string;result:string}|undefined;
    valid(binding?.digest === digest(pending) && binding.result === canonical(pending));
    const events = new Map<string,{row:EventRow;data:EventData}>();
    for (const row of db.prepare('SELECT id,owner,source,epoch,data FROM events').all() as EventRow[]) {
      const e=json(Buffer.from(row.data)) as unknown as EventData;
      valid(validId(row.id) && e.id===row.id && e.owner_id===row.owner && e.source_id===row.source && e.source_epoch===row.epoch
        && Number.isSafeInteger(e.event_version) && e.event_version>=1 && Number.isSafeInteger(e.interaction_version) && e.interaction_version>=0);
      parseExpiry(e.expires_at);events.set(row.id,{row,data:e});
    }
    const responses = new Map<string,{row:ResponseRow;data:ResponseData}>();
    for (const row of db.prepare('SELECT id,owner,source,epoch,event_id,interaction_id,interaction_version,data FROM responses').all() as ResponseRow[]) {
      const r=json(Buffer.from(row.data)) as unknown as ResponseData;const event=events.get(row.event_id);
      valid(event && validId(row.id) && r.id===row.id && r.event_id===row.event_id && event.row.owner===row.owner && event.row.source===row.source && event.row.epoch===row.epoch
        && r.interaction_id===row.interaction_id && r.interaction_version===row.interaction_version && record(r.target) && r.target.source_id===row.source && r.target.source_epoch===row.epoch
        && r.target.session_ref===event.data.session_ref && Number.isSafeInteger(r.event_version_seen) && r.event_version_seen>=1 && r.event_version_seen<event.data.event_version);
      parseExpiry(r.expires_at);responses.set(pair(row.owner,row.id),{row,data:r});
    }
    for (const {row,data} of events.values()) if(data.reserved_response_id!==null) {
      const r=responses.get(pair(row.owner,data.reserved_response_id));valid(r && r.row.event_id===row.id && r.data.interaction_version===data.interaction_version);
    }
    const commands = new Map<string,StoredCommand>(); let receipts=0;
    for (const row of db.prepare('SELECT id,owner,source,epoch,response_id,event_id,attempted,receipt,data FROM commands').all() as CommandRow[]) {
      const c=json(Buffer.from(row.data)) as unknown as Command;const r=responses.get(pair(row.owner,row.response_id));
      valid(validId(row.id) && r && c.id===row.id && c.response_id===row.response_id && c.event_id===row.event_id && r.row.event_id===row.event_id
        && r.row.source===row.source && r.row.epoch===row.epoch && canonical(c.response)===canonical(r.data) && c.state==='effect_unknown' && c.receipt===null);
      const receipt=row.receipt===null?null:json(Buffer.from(row.receipt)) as unknown as NativeReceipt;
      if(receipt){valid(keys(receipt as unknown as Record<string,unknown>,['command_id','session_ref','state_revision','message_id']) && receipt.command_id===row.id && receipt.session_ref===r.data.target.session_ref && receipt.state_revision===r.data.target.state_revision && typeof receipt.message_id==='string' && receipt.message_id.trim());receipts++;}
      commands.set(row.id,{row,command:c,receipt});
    }
    const inputs=new Map<string,string>();let missingReceipt=0;
    for(const e of native.entries) if(e.type==='custom_message'&&e.customType===responseType){
      valid(typeof e.content==='string'&&record(e.details));const d=e.details as Record<string,unknown>;const input=json(Buffer.from(e.content as string));const c=commands.get(String(d.command_id));
      valid(d.version===1&&d.scope===m.binding_hash&&c&&input.protocol==='notifier_response_v1'&&input.command_id===c.row.id&&input.event_id===c.row.event_id&&input.response_id===c.row.response_id
        &&canonical(input.response)===canonical(c.command.response)&&digest(c.command.response)===d.response_hash&&c.row.owner===b.owner_id&&c.row.source===b.source_id&&c.row.epoch===b.source_epoch
        &&c.command.response.target.session_ref===m.native_id&&!inputs.has(c.row.id));
      if(c.receipt)valid(c.receipt.message_id===e.id);else missingReceipt++;
      inputs.set(c.row.id,e.id);
    }
    // A known receipt for this exact pinned session must resolve in BOTH directions.
    // Missing input is inconsistent material, not authority to drop the receipt or recreate an effect.
    for(const c of commands.values()) if(c.receipt&&c.row.owner===b.owner_id&&c.row.source===b.source_id&&c.row.epoch===b.source_epoch&&c.command.response.target.session_ref===m.native_id){
      valid(inputs.get(c.row.id)===c.receipt.message_id);
    }
    for(const j of journal) if(j.kind==='run_started'){
      valid(j.run_id===stableId('run',m.native_id,j.command_id??'bootstrap'));
      if(j.command_id===null)valid(j.input_entry_id===native.entries[3]!.id);
      else {const c=commands.get(j.command_id);valid(c&&inputs.get(j.command_id)===j.input_entry_id&&c.receipt?.message_id===j.input_entry_id);}
    }
    for(const report of journal) if(report.kind==='report_intent'){
      const id=report.method==='create'?('request_id' in report.input?report.input.request_id:''):('update_id' in report.input?report.input.update_id:'');
      const scope=report.method==='create'?[b.owner_id,'source',b.source_id,b.source_epoch,'create','']:['delivery',b.owner_id,b.source_id,b.source_epoch,'associated_update',report.event_id];
      if(report.command_id!==null){const c=commands.get(report.command_id);valid(c&&c.row.owner===b.owner_id&&c.row.source===b.source_id&&c.row.epoch===b.source_epoch&&c.row.event_id===report.event_id);}
      const operation=db.prepare('SELECT digest,result FROM operations WHERE scope=? AND id=?').get(JSON.stringify(scope),id) as {digest:string;result:string}|undefined;
      let saved:Record<string,unknown>|undefined;
      if(operation){
        valid(operation.digest===digest(report.method==='create'?report.input:{command_id:report.command_id,...report.input}));saved=json(Buffer.from(operation.result));
        const event=typeof saved.event_id==='string'?events.get(saved.event_id):undefined;
        valid(keys(saved,['event_id','event_version','saved_at'])&&event&&event.row.owner===b.owner_id&&event.row.source===b.source_id&&event.row.epoch===b.source_epoch
          &&typeof saved.event_version==='number'&&Number.isSafeInteger(saved.event_version)&&saved.event_version>=1&&saved.event_version<=event.data.event_version);
        if(report.method==='update'){
          valid(saved.event_id===report.event_id);
          const inner=db.prepare('SELECT digest,result FROM operations WHERE scope=? AND id=?').get(JSON.stringify([b.owner_id,'source',b.source_id,b.source_epoch,'update',report.event_id]),id) as {digest:string;result:string}|undefined;
          valid(inner&&inner.digest===digest(report.input)&&canonical(json(Buffer.from(inner.result)))===canonical(saved));
        }
      }
      for(const acknowledgement of journal)if(acknowledgement.kind==='report_saved'&&acknowledgement.op_id===id)valid(saved&&acknowledgement.event_id===saved.event_id&&acknowledgement.event_version===saved.event_version);
      for(const rejected of journal)if(rejected.kind==='report_rejected'&&rejected.op_id===id)valid(!operation);
      // No operation and an intent without ACK is a legal pre-DB unknown; an operation without ACK is a legal lost-ACK unknown.
    }
    for(const row of db.prepare('SELECT event_id,kind,data FROM history').all() as {event_id:string;kind:string;data:string}[]){
      const data=json(Buffer.from(row.data));valid(events.has(row.event_id));
      const event=events.get(row.event_id)!;
      if(['event_created','progress','source_result_reported'].includes(row.kind))valid(data.id===row.event_id&&data.owner_id===event.row.owner&&data.source_id===event.row.source&&data.source_epoch===event.row.epoch);
      if(row.kind==='response_saved'){
        valid(data.event_id===row.event_id&&typeof data.id==='string');const saved=responses.get(pair(event.row.owner,data.id));valid(saved&&saved.row.event_id===row.event_id&&canonical(saved.data)===canonical(data));
      }
      if(['command_claimed','source_received','command_update_link'].includes(row.kind)){
        valid(typeof data.command_id==='string');const command=commands.get(data.command_id);valid(command&&command.row.event_id===row.event_id&&command.row.response_id===data.response_id);
        if(row.kind==='source_received')valid(command.receipt&&canonical(command.receipt)===canonical(data.receipt));
      }
      if(data.event_id!==undefined)valid(data.event_id===row.event_id);
    }
    if(records.has('source-pump')){
      const p=json(bytes('source-pump'));valid(keys(p,['binding','claim_id','command_id','phase'])&&p.binding===JSON.stringify([b.owner_id,b.principal_id,b.source_id,b.source_epoch])&&validId(p.claim_id)
        &&['claiming','submitting','settled'].includes(String(p.phase))&&(p.command_id===null||validId(p.command_id)));
      if(typeof p.command_id==='string'){const c=commands.get(p.command_id);valid(c&&c.row.owner===b.owner_id&&c.row.source===b.source_id&&c.row.epoch===b.source_epoch);}
    }
    return {format:1 as const,snapshot_id:m.snapshot_id,captured_at:m.captured_at,records:material.records.length,native_entries:native.entries.length,native_inputs:inputs.size,native_inputs_without_public_receipt:missingReceipt,
      events:events.size,responses:responses.size,commands:commands.size,history:(db.prepare('SELECT count(*) n FROM history').get() as {n:number}).n,historical_receipts:receipts,
      model_request_intents:journal.filter(v=>v.kind==='model_request_intent').length,model_http_attempts:journal.filter(v=>v.kind==='model_http_attempt').length,report_intents:journal.filter(v=>v.kind==='report_intent').length,
      authority_present:records.has('device-authority'),external_references_checked:false as const,current_permissions_verified:false as const,active_restore_supported:false as const,
      original_durability_ack_reconstructed:false as const,private_derived_verification_files_retained:true as const};
  });
  return {material,inspection};
}
