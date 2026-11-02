// Temporary diagnostic branch only. Every attempt uses a fresh isolated fixture.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const results=[];
for (let attempt=1; attempt<=12; attempt++) {
  const r=spawnSync(process.execPath,['scripts/verify-gui.mjs'],{env:{...process.env,DSH_DIAG_STARTUP_ONLY:'true'},encoding:'utf8',maxBuffer:8*1024*1024});
  mkdirSync('.local/startup-diagnosis',{recursive:true});
  writeFileSync(`.local/startup-diagnosis/attempt-${attempt}.log`,r.stdout+'\n'+r.stderr);
  results.push({attempt,status:r.status,signal:r.signal,error:r.error?.message});
  console.log(JSON.stringify(results.at(-1)));
}
writeFileSync('.local/startup-diagnosis/results.json',JSON.stringify(results,null,2)+'\n');
if(results.some(r=>r.status!==0))process.exitCode=1;
