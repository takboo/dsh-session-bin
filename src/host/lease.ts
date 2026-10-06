import { constants } from 'node:fs';
import { mkdir, open, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';

export class BinLeaseError extends Error {
  readonly code = 'bin/lease-unavailable';
}

// Own only this plugin's lock. Never unlink it: flock coordinates an inode.
// The directory must be shared by every composition using the same Bin domain.
export async function acquireBinLease(directory: string): Promise<() => Promise<void>> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new BinLeaseError('This Host slice requires POSIX flock.');
  }
  if (!isAbsolute(directory)) throw new BinLeaseError('Coordination directory must be absolute.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const filename = join(root, 'writer.lock');
  const handle = await open(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await tryLockExclusive(handle.fd);
    const held = await handle.stat({ bigint: true });
    const current = await lstat(filename, { bigint: true });
    if (!held.isFile() || !current.isFile() || held.ino !== current.ino || held.dev !== current.dev
      || await realpath(directory) !== root) {
      throw new BinLeaseError('The coordination lock identity changed.');
    }
  } catch (cause) {
    await handle.close();
    throw new BinLeaseError('Cannot acquire exclusive Bin ownership.', { cause });
  }
  let release: Promise<void> | undefined;
  return () => release ??= handle.close();
}
