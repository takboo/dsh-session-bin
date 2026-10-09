import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as product from '../../dist/index.js';

const exactNode = '24.18.1';
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureParent = join(workspaceRoot, '.local', 'lifecycle');

export const platformVerification = process.env.DSH_SESSION_BIN_PLATFORM_VERIFY === '1';

const crashProofName = 'crash-checkpoint.json';
const crashFailureName = 'crash-not-forced.json';
const crashFailureMessage = 'DSH_TEST_CRASH_NOT_FORCED';

function assertIsolatedRoot(root) {
  const canonical = resolve(root);
  const rel = relative(fixtureParent, canonical);
  assert(isAbsolute(canonical));
  assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    'candidate platform verification requires an isolated workspace fixture root');
  assert.equal(resolve(process.env.DSH_HOME ?? ''), join(canonical, 'dsh-home'),
    'candidate platform verification requires DSH_HOME to be the current fixture root');
  return canonical;
}

export function candidatePlatformQualification(root) {
  return runtime => {
    assertIsolatedRoot(root);
    return platformVerification && runtime.node === exactNode
      && runtime.node === process.versions.node
      && product.nativePlatformCandidate(runtime.platform, runtime.arch);
  };
}

export function nativeOwnerOptions(root, options = {}) {
  if (!platformVerification) return options;
  assert.equal(process.versions.node, exactNode, 'candidate platform verification is pinned to the audited Node runtime');
  assert(product.nativePlatformCandidate(), 'candidate platform verification requires an implemented OS/architecture pair');
  assertIsolatedRoot(root);
  return { ...options, platformQualification: candidatePlatformQualification(root) };
}

export function sessionBinPlugin(root) {
  if (!platformVerification) return product;
  const ownerOptions = nativeOwnerOptions(root);
  class CandidateSessionBin extends product.SessionBin {
    constructor(ctx, config) {
      super(ctx, config, ownerCtx => product.NativeRetirementOwner.open(ownerCtx, ownerOptions));
    }
  }
  return {
    name: 'session-bin-platform-verification',
    inject: product.inject,
    async apply(ctx, config) {
      await ctx.plugin(CandidateSessionBin, config);
      await product.installSessionBinRemote(ctx);
    },
  };
}

export function crashAt(root, boundary) {
  assert.equal(typeof boundary, 'string');
  assert(boundary.length > 0);
  const canonical = assertIsolatedRoot(root);
  let failed = false;
  const markFailure = () => {
    if (failed) return;
    failed = true;
    process.stderr.write(`${crashFailureMessage}\n`);
    writeFileSync(join(canonical, crashFailureName), JSON.stringify({ root: canonical, boundary }),
      { flag: 'wx', flush: true, mode: 0o600 });
  };
  process.once('exit', markFailure);
  try {
    writeFileSync(join(canonical, crashProofName), JSON.stringify({ root: canonical, boundary }),
      { flag: 'wx', flush: true, mode: 0o600 });
    process.kill(process.pid, 'SIGKILL');
  } catch (cause) {
    try { markFailure(); } finally { process.off('exit', markFailure); }
    throw new Error('The crash request failed instead of forcibly terminating the worker.', { cause });
  }
  try { markFailure(); } finally { process.off('exit', markFailure); }
  throw new Error('The crash request returned instead of forcibly terminating the worker.');
}

export function assertCrashExit(root, boundary, code, signal, message) {
  const canonical = assertIsolatedRoot(root);
  let proof;
  try { proof = JSON.parse(readFileSync(join(canonical, crashProofName), 'utf8')); }
  catch (error) { assert.fail(`Crash checkpoint proof is missing or invalid: ${error}`); }
  assert.deepEqual(proof, { root: canonical, boundary }, message);
  assert(!String(message ?? '').includes(crashFailureMessage), 'The worker executed the non-forced-exit sentinel.');
  try {
    readFileSync(join(canonical, crashFailureName));
    assert.fail('The worker wrote post-kill or normal-exit failure evidence.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (process.platform === 'win32') {
    assert.equal(code, 1, message);
    assert.equal(signal, null, message);
  } else {
    assert.equal(code, null, message);
    assert.equal(signal, 'SIGKILL', message);
  }
}

export async function assertStableSessionLock(directory, before) {
  const lockPath = join(directory, 'session.lock');
  if (process.platform === 'win32') {
    await assert.rejects(lstat(lockPath), error => error.code === 'ENOENT');
    return;
  }
  const current = await lstat(lockPath, { bigint: true });
  assert(current.isFile());
  if (before) {
    assert.equal(current.dev, before.dev);
    assert.equal(current.ino, before.ino);
  }
  return current;
}

export const retainedLockEntries = () => process.platform === 'win32' ? [] : ['session.lock'];
