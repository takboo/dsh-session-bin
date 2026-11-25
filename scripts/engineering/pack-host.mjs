import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredNodeVersion, configuredPackageManager } from '../package-manager.mjs';

export const PACK_INPUT_PATHS = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'LICENSE',
  'cordis.patch.yml', 'tsconfig.json', 'tsconfig.client.json', 'src', 'locale',
  'docs/host-lifecycle.md', 'docs/client-interface.md', 'scripts/build.mjs',
  'scripts/engineering/targets.json', 'scripts/engineering/web-probe.mjs',
  'scripts/gui-archive-actions.mjs', 'scripts/gui-fixture.mjs',
];

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = async (file) => sha256Bytes(await readFile(file));
const git = (root, args) => execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { encoding: 'utf8' });
const defaultOutDir = (root) => {
  const dir = process.env.DSH_ENGINEERING_ACTIVE_RUN_DIR?.trim() || process.env.DSH_ENGINEERING_RUN_DIR?.trim();
  assert(dir, 'Set DSH_ENGINEERING_ACTIVE_RUN_DIR (automatically set per mise run) or DSH_ENGINEERING_RUN_DIR.');
  return resolve(root, dir);
};

async function writeAtomic(file, content) {
  const temp = `${file}.tmp-${process.pid}`;
  try { await writeFile(temp, content); await rename(temp, file); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}

export async function createExclusiveRunDir(outDir) {
  await mkdir(dirname(outDir), { recursive: true, mode: 0o700 });
  try {
    await mkdir(outDir, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Run directory ${outDir} already exists; each verify:pack / verify:host run requires a fresh exclusive directory.`, { cause: error });
    }
    throw error;
  }
  return outDir;
}

export function assertCleanPackInputs(root = repoRoot) {
  const sourceCommit = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, 'Cannot resolve HEAD to a 40-hex commit.');
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...PACK_INPUT_PATHS]).replace(/\r?\n$/, '').split(/\r?\n/).filter(Boolean);
  assert.equal(dirty.length, 0, `Refusing verify:pack with uncommitted packaged/probe inputs (commit changes before formal verify:host):\n${dirty.join('\n')}`);
  return sourceCommit;
}

export async function exportCleanHead(root, cleanSource, sourceCommit) {
  assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/, 'exportCleanHead requires a 40-hex sourceCommit.');
  const targetDir = resolve(cleanSource);
  const parentDir = dirname(targetDir);
  const dirName = basename(targetDir);
  const archiveName = `${dirName}.tar`;
  const archive = join(parentDir, archiveName);
  await mkdir(targetDir, { recursive: true });
  execFileSync('git', ['--no-replace-objects', '-c', 'core.autocrlf=false', '-C', root, 'archive', '--format=tar', `--output=${archive}`, sourceCommit]);
  try { execFileSync('tar', ['-xf', archiveName, '-C', dirName], { cwd: parentDir }); }
  finally { await rm(archive, { force: true }); }
}

export async function bindE1Manifest({ candidate, probe, targets, sourceCommit, verifiedTarballSha256, verifiedProbeSha256, verifiedTargetsSha256, manifestPath }) {
  assert.match(verifiedTarballSha256 ?? '', /^[a-f0-9]{64}$/, 'E1 report missing valid 64-hex tarball sha256.');
  assert.equal(await sha256(candidate), verifiedTarballSha256, 'candidate.tgz digest changed after E1 verification.');
  const actualProbeSha256 = await sha256(probe);
  if (verifiedProbeSha256 !== undefined) assert.equal(actualProbeSha256, verifiedProbeSha256, 'probe.mjs digest changed after bundling.');
  assert.equal(await sha256(targets), verifiedTargetsSha256, 'targets.json digest changed after archive export.');
  const manifest = { sourceCommit, tarballSha256: verifiedTarballSha256, probeSha256: actualProbeSha256, targetsSha256: verifiedTargetsSha256 };
  await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function verifyHostReport(root = repoRoot, outDir = defaultOutDir(root)) {
  const [lock, manifest, report] = await Promise.all([
    readJson(join(root, 'dsh-engineering.lock.json')),
    readJson(join(outDir, 'e1-manifest.json')),
    readJson(join(outDir, 'host-report.json')),
  ]);
  const sourceCommit = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  const committedTargetsSha256 = sha256Bytes(execFileSync('git', ['--no-replace-objects', '-C', root, 'show', `${sourceCommit}:scripts/engineering/targets.json`]));
  const current = {
    sourceCommit,
    tarballSha256: await sha256(join(outDir, 'candidate.tgz')),
    probeSha256: await sha256(join(outDir, 'probe.mjs')),
    targetsSha256: await sha256(join(outDir, 'targets.json')),
  };
  assert.equal(current.targetsSha256, committedTargetsSha256, 'outDir targets.json differs from committed HEAD targets.json');
  assert.equal(report.outcome, 'passed', `Expected host-report outcome=passed, found ${report.outcome}`);
  assert.equal(report.provenance?.producer?.source, 'git-archive', 'host-report producer.source must be git-archive');
  assert.equal(report.provenance?.producer?.commit, lock.commit, 'host-report producer.commit differs from dsh-engineering.lock.json');
  assert.equal(report.provenance?.inputs?.mode, 'all', 'host-report inputs.mode must be all');
  assert.equal(report.plugin?.sourceCommit, current.sourceCommit, 'host-report plugin.sourceCommit differs from HEAD');
  assert.equal(report.plugin?.sha256, current.tarballSha256, 'host-report plugin.sha256 differs from candidate.tgz');
  for (const key of ['sourceCommit', 'tarballSha256', 'probeSha256', 'targetsSha256']) {
    assert.equal(manifest[key], current[key], `e1-manifest ${key} differs from current on-disk state`);
    assert.equal(report.provenance?.inputs?.[key], current[key], `host-report provenance.inputs.${key} differs from current on-disk state`);
  }
  return { outcome: report.outcome, producerCommit: lock.commit, ...current };
}

export async function packHostCandidate(root = repoRoot, outDir = defaultOutDir(root)) {
  assert.equal(process.versions.node, await configuredNodeVersion(root), 'Use the project Node version from mise.toml.');
  const sourceCommit = assertCleanPackInputs(root);
  await createExclusiveRunDir(outDir);
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-pack-host-'));
  try {
    const cleanSource = join(scratch, 'source');
    await exportCleanHead(root, cleanSource, sourceCommit);
    const [pkg, targetsBytes] = await Promise.all([readJson(join(cleanSource, 'package.json')), readFile(join(cleanSource, 'scripts/engineering/targets.json'))]);
    const targets = JSON.parse(targetsBytes.toString('utf8'));
    assert.equal(pkg.engines?.dsh, targets.admit?.version, 'package.json engines.dsh must match targets.admit.version.');
    const verifiedTargetsSha256 = sha256Bytes(targetsBytes);

    const [candidate, probe, outTargets, manifestPath] = ['candidate.tgz', 'probe.mjs', 'targets.json', 'e1-manifest.json'].map((f) => join(outDir, f));
    await writeAtomic(outTargets, targetsBytes);

    for (const args of [['install', '--frozen-lockfile', '--ignore-scripts', '--offline'], ['run', 'build']]) {
      const cmd = await configuredPackageManager(args);
      execFileSync(cmd.file, cmd.args, { cwd: cleanSource, env: process.env, stdio: 'inherit' });
    }
    const e1ReportPath = join(scratch, 'e1-report.json');
    execFileSync(process.execPath, [join(cleanSource, 'scripts/verify-package.mjs'), '--save-tarball', candidate, '--save-report', e1ReportPath], { cwd: cleanSource, env: process.env, stdio: 'inherit' });
    const e1Report = await readJson(e1ReportPath);
    assert.equal(e1Report.status, 'passed', 'E1 package verification did not report status=passed.');

    const { build } = createRequire(join(cleanSource, 'package.json'))('esbuild');
    const tempProbe = `${probe}.tmp-${process.pid}.mjs`;
    let verifiedProbeSha256;
    try {
      await build({ entryPoints: [join(cleanSource, 'scripts/engineering/web-probe.mjs')], outfile: tempProbe, bundle: true, platform: 'node', format: 'esm', target: 'node24' });
      verifiedProbeSha256 = await sha256(tempProbe);
      await rename(tempProbe, probe);
    } catch (error) { await rm(tempProbe, { force: true }); throw error; }

    const manifest = await bindE1Manifest({ candidate, probe, targets: outTargets, sourceCommit, verifiedTarballSha256: e1Report.sha256, verifiedProbeSha256, verifiedTargetsSha256, manifestPath });
    console.log(`RunDir: ${outDir}\nCandidate: ${candidate}\nCandidate SHA-256: ${manifest.tarballSha256}\nProbe: ${probe}\nProbe SHA-256: ${manifest.probeSha256}\nManifest: ${manifestPath}`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) await packHostCandidate();
  else if (argv.length === 1 && argv[0] === '--verify-report') console.log(JSON.stringify(await verifyHostReport(), null, 2));
  else throw new Error(`Unknown arguments: ${argv.join(' ')}`);
}
