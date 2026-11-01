import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,chmodSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {NotificationStore,pushConfig} from 'notification-server/notifications';
import {withReadOnlyBackupImage} from 'notification-server/backup-validation';
import {AppRuntime} from '../src/runtime.js';
import {captureBackupMaterial} from '../src/backup-capture.js';
import {sealBackupArchive} from '../src/backup-format.js';
import {inspectBackupArchive} from '../src/backup-validate.js';
import {fixture,fakeModels,manualEvent} from './helpers.js';

test('snapshot retains frozen push generation/nonce and original publish unknown after endpoint rotation, without publication or receipt promotion',async()=>{
  const f=fixture(false);f.init();const models=await fakeModels(f.root);const r=await AppRuntime.open(f.config,{modelRuntime:models.runtime});let original:unknown;let delivery='';
  try{
    const n=new NotificationStore(r.native.database,r.registry,pushConfig('http://127.0.0.1:18475',undefined,true));
    n.register(f.user(),{registration_id:randomUUID(),expected_generation:0,endpoint:'http://127.0.0.1:18475/private_original_topic'});manualEvent(r);
    const unknown=n.claim();assert.ok(unknown);delivery=unknown.id;assert.equal(unknown.platform_state,'effect_unknown');
    n.register(f.user(),{registration_id:randomUUID(),expected_generation:1,endpoint:'http://127.0.0.1:18475/private_new_topic'});
    original=r.native.database.prepare('SELECT * FROM notifications WHERE id=?').get(delivery);assert.equal((original as{generation:number}).generation,1);
  }finally{await r.close();}
  const fetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Backup cannot publish or probe a channel');};
  try{
    const material=await captureBackupMaterial(f.configFile,true);const key=randomBytes(32);const archive=sealBackupArchive(material.metadata,material.records,key);inspectBackupArchive(archive,key);assert.equal(archive.includes(Buffer.from('private_original_topic')),false);
    const dir=mkdtempSync(join(tmpdir(),'notifier-backup-notice-image-'));chmodSync(dir,0o700);const path=join(dir,'derived.sqlite');writeFileSync(path,material.records.find(r=>r.name==='ledger')!.bytes,{mode:0o600});
    withReadOnlyBackupImage(path,db=>{assert.deepEqual(db.prepare('SELECT * FROM notifications WHERE id=?').get(delivery),original);assert.equal((db.prepare('SELECT generation FROM push_devices').get()as{generation:number}).generation,2);});
    const current=await AppRuntime.open(f.config,{sourcePaused:true});try{assert.deepEqual(current.native.database.prepare('SELECT * FROM notifications WHERE id=?').get(delivery),original);assert.equal(current.native.metadata().length,0);}finally{await current.close();}
  }finally{globalThis.fetch=fetch;}
  assert.equal(models.calls.length,0);
});
