import{writeSync}from'node:fs';
import{loadConfig}from'../../src/config.js';
import{AppRuntime}from'../../src/runtime.js';
import{pausedPhysicalModel}from'./source-paused-model.js';
if(process.argv.length!==3)throw new Error('Explicit isolated config required');
process.umask(0o077);const config=loadConfig(process.argv[2]!);globalThis.fetch=async()=>{throw new Error('No model request is allowed in this Native receipt fault fixture');};
const models=await pausedPhysicalModel(config.data_dir);const runtime=await AppRuntime.open(config,{modelRuntime:models,wrapHost:host=>({synchronousDurableGate:true as const,getReceipt:id=>host.getReceipt(id),compareAndEnqueue:(command,now)=>{host.compareAndEnqueue(command,now);writeSync(1,'fault:restore-native-before-public\n');process.kill(process.pid,'SIGKILL');throw new Error('Expected owned SIGKILL not delivered');}})});
try{await runtime.runOnce();}finally{await runtime.close();}
