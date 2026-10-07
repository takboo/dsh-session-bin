import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./verify-gui.mjs', import.meta.url));
let active;
let stopped = false;
function stop(signal) {
  stopped = true;
  active?.kill(signal);
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
for (const locale of ['zh-CN', 'en-US']) {
  if (stopped) break;
  console.log(`Verify real Session Bin UI: ${locale}`);
  active = spawn(process.execPath, [script], {
    cwd: process.cwd(), env: { ...process.env, DSH_GUI_LOCALE: locale }, stdio: 'inherit',
  });
  const status = await new Promise((resolve, reject) => {
    active.once('error', reject);
    active.once('close', (code, signal) => resolve({ code, signal }));
  });
  active = undefined;
  if (status.code !== 0) {
    process.exitCode = status.code ?? 1;
    break;
  }
}
if (stopped) process.exitCode = 1;
