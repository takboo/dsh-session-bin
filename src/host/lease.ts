import { constants } from 'node:fs';
import { mkdir, open, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';

import { acquireWindowsSemaphore, nativePlatformCandidate } from './platform-files.js';

export class BinLeaseError extends Error {
  readonly code = 'bin/lease-unavailable';
}

// Own only this plugin's lock. Never unlink it: flock coordinates an inode.
// The directory must be shared by every composition using the same Bin domain.
// Windows uses a kernel semaphore; the persistent marker is never the arbiter.
export async function acquireBinLease(directory: string): Promise<() => Promise<void>> {
  if (!nativePlatformCandidate()) throw new BinLeaseError('This Host platform has no implemented kernel lease.');
  if (!isAbsolute(directory)) throw new BinLeaseError('Coordination directory must be absolute.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const rootIdentity = await lstat(root, { bigint: true });
  const filename = join(root, 'writer.lock');
  try {
    const previous = await lstat(filename, { bigint: true });
    if (!previous.isFile() || previous.nlink !== 1n || previous.size !== 0n) throw new BinLeaseError('The existing coordination marker is not an empty exclusive regular file.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const handle = await open(filename, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
  let unlock: (() => Promise<void>) | undefined;
  try {
    if (process.platform === 'win32') unlock = await acquireWindowsSemaphore(filename, 'plugin');
    else await tryLockExclusive(handle.fd);
    const held = await handle.stat({ bigint: true });
    const current = await lstat(filename, { bigint: true });
    const currentRoot = await lstat(root, { bigint: true });
    if (!held.isFile() || !current.isFile() || held.nlink !== 1n || current.nlink !== 1n || held.size !== 0n || current.size !== 0n
      || held.ino !== current.ino || held.dev !== current.dev || held.birthtimeNs !== current.birthtimeNs
      || !currentRoot.isDirectory() || currentRoot.ino !== rootIdentity.ino || currentRoot.dev !== rootIdentity.dev
      || currentRoot.birthtimeNs !== rootIdentity.birthtimeNs || await realpath(directory) !== root) {
      throw new BinLeaseError('The coordination lock identity changed.');
    }
  } catch (cause) {
    const errors = [cause];
    try { await unlock?.(); } catch (error) { errors.push(error); }
    try { await handle.close(); } catch (error) { errors.push(error); }
    throw new BinLeaseError('Cannot acquire exclusive Bin ownership.', { cause: errors.length === 1 ? cause : new AggregateError(errors) });
  }
  let release: Promise<void> | undefined;
  return () => release ??= (async () => {
    const errors: unknown[] = [];
    try { await unlock?.(); } catch (error) { errors.push(error); }
    try { await handle.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Bin kernel lease release failed.');
  })();
}
