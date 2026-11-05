import { canonical, fail, object, MAX_BODY } from './validation.mjs';
import { ARCHIVE_DDL, DEFAULT_POLICY, ROW_FIELDS, formatVersion, readPolicy, storagePolicy } from './spool-format.mjs';
import { accounting, registerMeasure } from './spool-capacity.mjs';
import { LARGE_FILE_BYTES, writeStorage } from './spool-storage.mjs';

export function archiveOptions(v) {
  object(v,['max_rows','include_blocked']);
  if(!Number.isSafeInteger(v.max_rows)||v.max_rows<1||v.max_rows>100||typeof v.include_blocked!=='boolean')fail('INVALID_INPUT');
  return {...v};
}
export function rowBytes(row) {
  return ROW_FIELDS.reduce((n,key)=>n+Buffer.byteLength(row[key]===null?'':String(row[key]),'utf8'),512);
}
/** Conservative dirty-page/WAL allowance, not a filesystem space reservation. */
export function batchReserve(db, rows, bound) {
  const page=db.prepare('PRAGMA page_size').get().page_size;
  const depth=Math.ceil(Math.log(Math.max(2,bound/page))/Math.log(Math.max(3,Math.floor((page-100)/160))))+2;
  return page*(64+rows.length*(24*depth+8))+rows.reduce((n,r)=>n+rowBytes(r)*8,0);
}
function selectedRows(db,options,bound) {
  const ids=db.prepare(`SELECT seq FROM queue WHERE state='saved' ${options.include_blocked?"OR state='blocked'":''} ORDER BY seq LIMIT ?`).all(options.max_rows);
  const rows=[];
  for(const {seq} of ids){
    const fields={payload:MAX_BODY*2,wire:MAX_BODY*2,ack:8192,id:160,fingerprint:128,kind:64,event_id:160,mapping:2400,state:32,error:2048};
    const size=db.prepare(`SELECT ${Object.keys(fields).map(k=>`length(CAST(${k} AS BLOB)) AS ${k}`).join(',')} FROM queue WHERE seq=?`).get(seq);
    if(Object.entries(fields).some(([k,max])=>size[k]>max))fail('UNKNOWN_SPOOL');
    const row=db.prepare('SELECT * FROM queue WHERE seq=?').get(seq);
    if(batchReserve(db,[...rows,row],bound)>bound/2)break;
    rows.push(row);
  }
  if(ids.length&&!rows.length)fail('SPOOL_FULL');
  return rows;
}
export function planArchive(db,c,bound,input,{ready=true}={}) {
  const options=archiveOptions(input);
  if(formatVersion(db)!==2||!ready)return {archive_plan:{upgrade_required:true,selected:0,can_apply:false,reason:'UPGRADE_REQUIRED'}};
  const used=accounting(db,c),rows=selectedRows(db,options,bound.file_bytes),cost=rows.reduce((n,row)=>n+rowBytes(row),0);
  const work=rows.reduce((n,r)=>n+Buffer.byteLength(r.payload)+Math.max(Buffer.byteLength(r.wire??''),Buffer.byteLength(r.payload)+256)+Math.max(Buffer.byteLength(r.ack??''),1024)+Buffer.byteLength(r.mapping??'')+1024,0);
  const fits=used.archive_operations+rows.length<=bound.archive_operations&&used.archive_bytes+cost<=bound.archive_bytes;
  return {archive_plan:{upgrade_required:false,selected:rows.length,eligible:db.prepare(`SELECT count(*) AS n FROM queue WHERE state='saved' ${options.include_blocked?"OR state='blocked'":''}`).get().n,
    archive_bytes_required:cost,work_reserved_bytes_released:work,physical_transaction_allowance:batchReserve(db,rows,bound.file_bytes),can_apply:fits,
    reason:fits?null:'ARCHIVE_FULL',selected_blocked:rows.filter(r=>r.state==='blocked').length,blocked_still_blocks:true,disk_shrink_promised:false}};
}
export function checkpoint(spool) {
  spool.assertFiles();let result;
  try{result=spool.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();}
  catch(e){if([5,6].includes(e.errcode&255))fail('MAINTENANCE_BUSY');throw e;}
  if(result.busy!==0||result.log!==0||result.checkpointed!==0)fail('MAINTENANCE_BUSY');
  spool.assertFiles();spool.syncDirectory(spool.path);spool.maintenanceHook?.('checkpoint_complete');
}
export function upgrade(spool) {
  checkpoint(spool);spool.refreshStorage(); // COMMIT may have succeeded before a prior local acknowledgement failed
  if(!spool.storage)writeStorage(spool,'upgrading');
  if(spool.storage.value.state==='ready')return {state:'storage_ready',format_version:2,changed:false};
  spool.db.exec(`PRAGMA max_page_count=${Math.floor(LARGE_FILE_BYTES/spool.db.prepare('PRAGMA page_size').get().page_size)}`);
  if(spool.version===1){
    spool.tx(()=>{
      spool.db.exec(ARCHIVE_DDL);
      spool.db.prepare('INSERT INTO meta VALUES (?,?)').run('storage_policy',canonical(DEFAULT_POLICY));
      spool.db.exec('PRAGMA user_version=2');spool.maintenanceHook?.('schema_before_commit');
    });
    spool.maintenanceHook?.('schema_committed');
  }else spool.tx(()=>readPolicy(spool.db)); // new durable barrier; never reset a committed policy
  spool.refreshStorage();writeStorage(spool,'ready');spool.refreshStorage();
  return {state:'storage_ready',format_version:2,changed:true};
}
export function resize(spool,input) {
  if(spool.version!==2||spool.storage?.value.state!=='ready')fail('UPGRADE_REQUIRED');const next=storagePolicy(input),prior=readPolicy(spool.db);
  for(const key of Object.keys(prior))if(next[key]<prior[key])fail('INVALID_STORAGE_POLICY');
  checkpoint(spool);
  spool.tx(()=>{
    const current=readPolicy(spool.db);for(const key of Object.keys(current))if(next[key]<current[key])fail('INVALID_STORAGE_POLICY');
    spool.db.prepare("UPDATE meta SET value=? WHERE key='storage_policy'").run(canonical(next));spool.maintenanceHook?.('resize_before_commit');
  });
  spool.refreshStorage();return {state:'storage_resized',policy:next,changed:canonical(next)!==canonical(prior)};
}
export function archive(spool,input) {
  if(spool.version!==2||spool.storage?.value.state!=='ready')fail('UPGRADE_REQUIRED');const options=archiveOptions(input);checkpoint(spool);
  const result=spool.tx(()=>{
    const bound=spool.currentLimits(),{archive_plan:plan}=planArchive(spool.db,spool.c,bound,options);
    if(!plan.can_apply)fail('ARCHIVE_FULL');
    const rows=selectedRows(spool.db,options,bound.file_bytes);
    const insert=spool.db.prepare(`INSERT INTO archive(seq,bytes,${ROW_FIELDS.slice(1).join(',')}) VALUES (${Array(12).fill('?').join(',')})`);
    for(const row of rows)insert.run(row.seq,rowBytes(row),...ROW_FIELDS.slice(1).map(key=>row[key]));
    for(const row of rows){
      const copied=spool.db.prepare(`SELECT ${ROW_FIELDS.join(',')} FROM archive WHERE seq=?`).get(row.seq);
      if(canonical(copied)!==canonical(row))fail('ARCHIVE_MISMATCH');
    }
    spool.maintenanceHook?.('archive_copied');
    for(const row of rows)if(spool.db.prepare('DELETE FROM queue WHERE seq=? AND id=? AND fingerprint=? AND state=?').run(row.seq,row.id,row.fingerprint,row.state).changes!==1)fail('ARCHIVE_MISMATCH');
    spool.maintenanceHook?.('archive_before_commit');
    return {state:'transport_archived',moved:rows.length,blocked_moved:plan.selected_blocked,work_reserved_bytes_released:plan.work_reserved_bytes_released,archive_bytes_added:plan.archive_bytes_required,blocked_still_blocks:true,disk_shrink_promised:false};
  });
  spool.maintenanceHook?.('archive_committed');return result;
}
