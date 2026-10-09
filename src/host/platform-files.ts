import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve, toNamespacedPath } from 'node:path';

export type NativePlatform = 'darwin' | 'linux' | 'win32';
export function nativePlatformCandidate(platform = process.platform, arch = process.arch): boolean {
  return ['darwin', 'linux', 'win32'].includes(platform) && ['arm64', 'x64'].includes(arch);
}
/** Actual erasure evidence is promoted separately from an implemented Adapter. */
export function nativePlatformVerified(platform = process.platform, arch = process.arch, node = process.versions.node, uv = process.versions.uv): boolean {
  return node === '24.18.1' && uv === '1.52.1' && platform === 'darwin' && arch === 'arm64';
}

interface WindowsKernel {
  createSemaphore(name: string): number;
  wait(handle: number): number;
  release(handle: number): number;
  close(handle: number): number;
  moveFile(source: string, destination: string, flags: number): number;
  lastError(): number;
}
let windowsKernel: Promise<WindowsKernel> | undefined;
function kernel(): Promise<WindowsKernel> {
  if (process.platform !== 'win32') throw new Error('Windows kernel operations require a native Windows runtime.');
  return windowsKernel ??= (async () => {
    const library = (await import('koffi')).default.load('kernel32.dll');
    const create = library.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']);
    const wait = library.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']);
    const release = library.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']);
    const close = library.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
    const moveFile = library.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']);
    const lastError = library.func('__stdcall', 'GetLastError', 'uint', []);
    return { createSemaphore: name => create(null, 1, 1, name) as number,
      wait: handle => wait(handle, 0) as number, release: handle => release(handle, 1, null) as number,
      close: handle => close(handle) as number, moveFile: (source, destination, flags) => moveFile(source, destination, flags) as number,
      lastError: () => lastError() as number };
  })();
}
/** Session namespace matches the audited JSONL writer; plugin ownership is independent. */
export function windowsSemaphoreName(path: string, purpose: 'session' | 'plugin'): string {
  const digest = createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
  return `Local\\${purpose === 'session' ? 'dsh-session-lock' : 'dsh-session-bin-lock'}-${digest}`;
}
function windowsError(syscall: string, error: number): NodeJS.ErrnoException {
  return Object.assign(new Error(`${syscall} failed with Windows error ${error}.`),
    { code: [2, 3].includes(error) ? 'ENOENT' : [80, 183].includes(error) ? 'EEXIST' : error === 17 ? 'EXDEV'
      : error === 32 ? 'EBUSY' : error === 5 ? 'EACCES' : 'EIO', syscall, win32Code: error });
}

/** Same-volume rename whose metadata acknowledgement is written through. */
export async function renameWindowsWriteThrough(source: string, destination: string): Promise<void> {
  const api = await kernel();
  // MOVEFILE_WRITE_THROUGH only: replacing a destination or copying across a
  // volume would expand the caller's frozen path/identity scope.
  if (api.moveFile(toNamespacedPath(source), toNamespacedPath(destination), 8) === 0) throw windowsError('MoveFileExW', api.lastError());
}
/** No lock file, expiry, or stale-PID deletion; the last kernel handle owns its lifetime. */
export async function acquireWindowsSemaphore(path: string, purpose: 'session' | 'plugin'): Promise<() => Promise<void>> {
  const api = await kernel();
  const handle = api.createSemaphore(windowsSemaphoreName(path, purpose));
  if (handle === 0) throw windowsError('CreateSemaphoreW', api.lastError());
  const result = api.wait(handle);
  if (result !== 0) {
    const error = result === 258 ? 32 : api.lastError();
    if (api.close(handle) === 0) throw new AggregateError([windowsError('WaitForSingleObject', error), windowsError('CloseHandle', api.lastError())], 'Kernel lease acquisition cleanup failed.');
    throw windowsError('WaitForSingleObject', error);
  }
  let releasing: Promise<void> | undefined;
  return () => releasing ??= (async () => {
    const errors: Error[] = [];
    if (api.release(handle) === 0) errors.push(windowsError('ReleaseSemaphore', api.lastError()));
    if (api.close(handle) === 0) errors.push(windowsError('CloseHandle', api.lastError()));
    if (errors.length) throw new AggregateError(errors, 'Kernel lease release failed.');
  })();
}

/** POSIX namespace durability. Windows callers must use their audited owner protocol. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export class RegularFileRefusal extends Error {
  constructor(readonly code: 'platform/unsafe-file' | 'platform/file-changed' | 'platform/identity-unavailable', message: string) { super(message); }
}

/** Refuse symlinks and compare the opened identity even when O_NOFOLLOW is unavailable. */
export async function openRegularFile(path: string, access: 'read' | 'write'): Promise<FileHandle> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new RegularFileRefusal('platform/unsafe-file', 'An exclusive regular file is required.');
  if (before.ino <= 0n || before.birthtimeNs <= 0n) throw new RegularFileRefusal('platform/identity-unavailable', 'The filesystem cannot certify this file incarnation.');
  const handle = await open(path, (access === 'read' ? constants.O_RDONLY : constants.O_RDWR) | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile() || actual.nlink !== 1n) throw new RegularFileRefusal('platform/unsafe-file', 'The opened file is not exclusive.');
    if (actual.ino <= 0n || actual.birthtimeNs <= 0n) throw new RegularFileRefusal('platform/identity-unavailable', 'The descriptor cannot certify this file incarnation.');
    if (before.dev !== actual.dev || before.ino !== actual.ino || before.birthtimeNs !== actual.birthtimeNs) {
      throw new RegularFileRefusal('platform/file-changed', 'The regular file changed while opening its descriptor.');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
