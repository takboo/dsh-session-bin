// Temporary diagnostic branch only. Every attempt uses a fresh isolated fixture.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const results=[];
const attempts=Number(process.env.DSH_DIAG_ATTEMPTS ?? 12);
if(!Number.isInteger(attempts)||attempts<1||attempts>12)throw Error('Invalid attempts');
for (let attempt=1; attempt<=attempts; attempt++) {
  const r=spawnSync(process.execPath,['scripts/verify-gui.mjs'],{env:{...process.env,DSH_DIAG_STARTUP_ONLY:process.env.DSH_DIAG_FULL_GUI==='true'?'false':'true'},encoding:'utf8',maxBuffer:8*1024*1024});
  mkdirSync('.local/startup-diagnosis',{recursive:true});
  writeFileSync(`.local/startup-diagnosis/attempt-${attempt}.log`,r.stdout+'\n'+r.stderr);
  results.push({attempt,status:r.status,signal:r.signal,error:r.error?.message});
  console.log(JSON.stringify(results.at(-1)));
}
writeFileSync('.local/startup-diagnosis/results.json',JSON.stringify(results,null,2)+'\n');
if(results.some(r=>r.status!==0))process.exitCode=1;
