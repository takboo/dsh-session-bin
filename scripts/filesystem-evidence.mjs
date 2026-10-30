import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { statfs } from 'node:fs/promises';

async function captureCommand(file, args, env = process.env) {
  let stdout = ''; let stderr = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, `${file} failed while identifying the verification filesystem: ${stderr.trim()}`);
  assert(stdout.trim(), `${file} returned no filesystem identity.`);
  return stdout.trim();
}

async function darwinFilesystemName(path, capture) {
  const rows = (await capture('/bin/df', ['-P', path])).trim().split(/\r?\n/).slice(1);
  assert.equal(rows.length, 1, 'Expected one filesystem for the evidence path.');
  const device = /^(\S+)\s/.exec(rows[0])?.[1];
  assert(device, 'df did not identify the evidence device.');
  const mounts = (await capture('/sbin/mount', [])).split(/\r?\n/).filter(line => line.startsWith(`${device} on `));
  assert(mounts.length > 0, 'The evidence device has no mounted filesystem identity.');
  const names = new Set(mounts.map(line => {
    const name = / \(([A-Za-z0-9_-]+)(?:,|\))/.exec(line)?.[1];
    assert(name, 'The mounted filesystem name is unavailable.');
    return name;
  }));
  assert.equal(names.size, 1, 'The evidence device has inconsistent filesystem names.');
  return [...names][0];
}

export async function filesystemEvidence(path, { platform = process.platform, readStatfs = statfs, capture = captureCommand } = {}) {
  const stats = await readStatfs(path, { bigint: true });
  const type = `0x${stats.type.toString(16)}`;
  const name = platform === 'win32'
    ? await capture('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($env:DSH_SESSION_BIN_EVIDENCE_PATH)).DriveFormat'],
    { ...process.env, DSH_SESSION_BIN_EVIDENCE_PATH: path })
    : platform === 'darwin'
      ? await darwinFilesystemName(path, capture)
      : stats.type === 0xef53n ? 'ext2/ext3/ext4' : await capture('stat', ['-f', '-c', '%T', path]);
  return { name, type, blockSize: stats.bsize.toString() };
}

