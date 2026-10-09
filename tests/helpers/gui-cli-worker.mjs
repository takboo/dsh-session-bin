import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 256 * 1024;

function redact(value) {
  return String(value)
    .replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]')
    .replace(/((?:authorization|cookie|secret|(?:api|auth|access)[_-]?token|(?:api|secret)[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}

function terminate(child, signal) {
  if (!Number.isInteger(child.pid)) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export async function runObservedCli(command, args, options = {}) {
  const timeout = options.timeout ?? 8000;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exit = null;
  let close = null;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-OUTPUT_LIMIT); });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-OUTPUT_LIMIT); });
  child.once('exit', (code, signal) => { exit = { code, signal, at: Date.now() }; });
  child.once('close', (code, signal) => { close = { code, signal, at: Date.now() }; });

  const started = Date.now();
  let timer;
  const outcome = await Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve('closed'));
    }),
    new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeout); }),
  ]);
  clearTimeout(timer);
  const naturalClose = outcome === 'closed';
  if (!naturalClose) {
    terminate(child, 'SIGTERM');
    let graceTimer;
    const grace = await Promise.race([
      new Promise(resolve => child.once('close', () => resolve(true))),
      new Promise(resolve => { graceTimer = setTimeout(() => resolve(false), 1000); }),
    ]);
    clearTimeout(graceTimer);
    if (!grace) {
      terminate(child, 'SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      if (close === null) await new Promise(resolve => child.once('close', resolve));
    }
  }
  return {
    naturalClose,
    elapsedMs: Date.now() - started,
    exit,
    close,
    stdout: redact(stdout),
    stderr: redact(stderr),
  };
}

if (import.meta.main && process.argv[2] === 'hold-inherited-stdio') {
  const holdMs = Number(process.argv[3] ?? 4000);
  spawn(process.execPath, ['-e', `
    process.stdout.on('error', () => process.exit(0));
    const writer = setInterval(() => process.stdout.write('.'), 50);
    setTimeout(() => { clearInterval(writer); process.exit(0); }, ${holdMs});
  `], {
    stdio: ['ignore', 'inherit', 'inherit'],
  }).unref();
  process.stdout.write('cli-finished\n', () => process.exit(0));
}

if (import.meta.main && process.argv[2] === 'print-done-then-stall') {
  process.stdout.write('Done in 179ms using pnpm v11.7.0\n');
  setInterval(() => {}, 1000);
}
