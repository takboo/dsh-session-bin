import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { acquireBinLease, nativePlatformCandidate, nativePlatformVerified, openRegularFile, RegularFileRefusal, windowsSemaphoreName } from '../dist/index.js';
import { createScratch } from './helpers/fixture.mjs';

test('implemented OS candidates remain independent from production platform qualification', () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const arch of ['arm64', 'x64']) assert(nativePlatformCandidate(platform, arch));
  assert.equal(nativePlatformCandidate('freebsd', 'x64'), false);
  assert.equal(nativePlatformCandidate('win32', 'ia32'), false);
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64'], ['win32', 'x64']]) {
    assert.equal(nativePlatformVerified(platform, arch, '24.18.1'), true, 'Every promoted combination has independent erasure evidence.');
  }
  assert.equal(nativePlatformVerified('win32', 'arm64', '24.18.1'), false, 'An implemented candidate without a matching runner remains unverified.');
  assert.equal(nativePlatformVerified('darwin', 'arm64', '26.0.0'), false);
  assert.equal(nativePlatformVerified('darwin', 'arm64', '24.18.1', '1.49.0'), false);
});

test('Windows session kernel naming exactly matches the audited writer and plugin ownership is independent', () => {
  const path = join(resolve('.local'), 'Session', 'session.lock');
  const digest = createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
  assert.equal(windowsSemaphoreName(path, 'session'), `Local\\dsh-session-lock-${digest}`);
  assert.equal(windowsSemaphoreName(path, 'plugin'), `Local\\dsh-session-bin-lock-${digest}`);
  assert.equal(windowsSemaphoreName(path.toUpperCase(), 'session'), windowsSemaphoreName(path.toLowerCase(), 'session'));
});

test('opened regular-file identity rejects extra hard links through the real descriptor before returning it', async () => {
  const root = await createScratch('platform-file-hardlink-');
  const path = join(root, 'target'); const alias = join(root, 'alias');
  await writeFile(path, 'selected transcript bytes');
  await link(path, alias);
  await assert.rejects(openRegularFile(path, 'write'), error => error instanceof RegularFileRefusal && error.code === 'platform/unsafe-file');
  assert.equal(await readFile(path, 'utf8'), 'selected transcript bytes');
  assert.equal(await readFile(alias, 'utf8'), 'selected transcript bytes');
});

test('opened regular-file helper refuses directories and leaves a normal opened payload unchanged', async () => {
  const root = await createScratch('platform-file-identity-');
  await assert.rejects(openRegularFile(root, 'read'), error => error instanceof RegularFileRefusal);
  const path = join(root, 'target'); await writeFile(path, 'verified payload');
  const handle = await openRegularFile(path, 'read');
  try { assert.equal(await handle.readFile('utf8'), 'verified payload'); }
  finally { await handle.close(); }
  assert.equal(await readFile(path, 'utf8'), 'verified payload');
});

test('plugin ownership refuses a nonempty existing marker without changing its bytes', async () => {
  const root = await createScratch('platform-kernel-unowned-');
  const directory = join(root, 'coordination'); await mkdir(directory);
  const marker = join(directory, 'writer.lock'); await writeFile(marker, 'unowned marker payload');
  await assert.rejects(acquireBinLease(directory), error => error.code === 'bin/lease-unavailable');
  assert.equal(await readFile(marker, 'utf8'), 'unowned marker payload');
});

test('actual platform plugin kernel lease excludes a second owner and retains its coordination identity after release', async () => {
  const root = await createScratch('platform-kernel-lease-');
  const directory = join(root, 'coordination'); await mkdir(directory);
  const first = await acquireBinLease(directory);
  const before = await lstat(join(directory, 'writer.lock'), { bigint: true });
  try { await assert.rejects(acquireBinLease(directory), error => error.code === 'bin/lease-unavailable'); }
  finally { await first(); await first(); }
  const second = await acquireBinLease(directory);
  try {
    const after = await lstat(join(directory, 'writer.lock'), { bigint: true });
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.birthtimeNs, before.birthtimeNs);
  } finally { await second(); }
});
