import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCleanPackInputs, bindE1Manifest, createExclusiveRunDir, exportCleanHead, verifyHostReport } from '../scripts/engineering/pack-host.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const hasMise = spawnSync('mise', ['--version'], { stdio: 'ignore' }).status === 0;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const lockCommit = '5380365eedf23e199ce7e8d0cb96b183b8660a80';

async function createTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pack-host-'));
  await Promise.all([mkdir(join(dir, 'scripts/engineering'), { recursive: true }), mkdir(join(dir, 'src'), { recursive: true })]);
  await Promise.all([
    writeFile(join(dir, '.gitignore'), 'dist/\n'),
    writeFile(join(dir, 'README.md'), '# temp A\n'),
    writeFile(join(dir, 'package.json'), '{"name":"temp","version":"0.0.1"}\n'),
    writeFile(join(dir, 'dsh-engineering.lock.json'), JSON.stringify({ schemaVersion: 1, repository: 'https://github.com/takboo/dsh-plugin-engineering.git', tag: 'v0.2.0-rc.1', commit: lockCommit }) + '\n'),
    writeFile(join(dir, 'scripts/engineering/targets.json'), '{"admit":{"version":"0.2.2-rc.3"}}\n'),
  ]);
  git(dir, ['init']);
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init']);
  return { dir, head: git(dir, ['rev-parse', '--verify', 'HEAD']) };
}

test('assertCleanPackInputs passes on committed HEAD and fails closed when packaged or probe inputs are dirty', async () => {
  const { dir, head } = await createTempRepo();
  try {
    assert.equal(assertCleanPackInputs(dir), head);
    await writeFile(join(dir, 'unrelated.txt'), 'ignored\n');
    assert.equal(assertCleanPackInputs(dir), head);
    await writeFile(join(dir, 'README.md'), '# modified\n');
    assert.throws(() => assertCleanPackInputs(dir), /README\.md/);
    await writeFile(join(dir, 'README.md'), '# temp A\n');
    await writeFile(join(dir, 'src/untracked.ts'), 'export {};\n');
    assert.throws(() => assertCleanPackInputs(dir), /src\/untracked\.ts/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('exportCleanHead pins to captured sourceCommit SHA and excludes stale gitignored dist files', async () => {
  const { dir, head: commitA } = await createTempRepo();
  const cleanSource = join(dir, '.exported-commit-a');
  try {
    await writeFile(join(dir, 'README.md'), '# temp B\n');
    git(dir, ['add', 'README.md']);
    git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'second']);
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'dist/previous-checkout.d.ts'), 'export declare const stale: true;\n');
    await exportCleanHead(dir, cleanSource, commitA);
    assert.equal(await readFile(join(cleanSource, 'README.md'), 'utf8'), '# temp A\n');
    await assert.rejects(() => access(join(cleanSource, 'dist/previous-checkout.d.ts')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('createExclusiveRunDir enforces write-once EEXIST and bindE1Manifest rejects post-E1 swaps', async () => {
  const { dir, head } = await createTempRepo();
  const outDir = join(dir, 'runs', 'run-exclusive');
  try {
    await createExclusiveRunDir(outDir);
    const [candidate, probe, targets, manifestPath] = ['candidate.tgz', 'probe.mjs', 'targets.json', 'e1-manifest.json'].map((f) => join(outDir, f));
    await Promise.all([writeFile(candidate, 'verified-tarball-A'), writeFile(probe, 'export default {};\n'), writeFile(targets, '{"admit":{"version":"0.2.2-rc.3"}}\n')]);
    await assert.rejects(() => createExclusiveRunDir(outDir), /already exists/);
    assert.equal(await readFile(candidate, 'utf8'), 'verified-tarball-A');

    const manifest = await bindE1Manifest({
      candidate, probe, targets, sourceCommit: head,
      verifiedTarballSha256: sha256('verified-tarball-A'), verifiedProbeSha256: sha256('export default {};\n'),
      verifiedTargetsSha256: sha256('{"admit":{"version":"0.2.2-rc.3"}}\n'), manifestPath,
    });
    assert.equal(manifest.tarballSha256, sha256('verified-tarball-A'));
    await writeFile(candidate, 'concurrent-tarball-B');
    await assert.rejects(() => bindE1Manifest({
      candidate, probe, targets, sourceCommit: head,
      verifiedTarballSha256: sha256('verified-tarball-A'), verifiedProbeSha256: sha256('export default {};\n'),
      verifiedTargetsSha256: sha256('{"admit":{"version":"0.2.2-rc.3"}}\n'), manifestPath,
    }), /candidate\.tgz digest changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verifyHostReport is read-only and idempotent under concurrency and rejects tampered artifacts or provenance', async () => {
  const { dir, head } = await createTempRepo();
  const outDir = join(dir, 'run-1');
  try {
    await createExclusiveRunDir(outDir);
    const [tarballBytes, probeBytes, targetsBytes] = ['tarball-payload', 'export default {};\n', '{"admit":{"version":"0.2.2-rc.3"}}\n'];
    await Promise.all([writeFile(join(outDir, 'candidate.tgz'), tarballBytes), writeFile(join(outDir, 'probe.mjs'), probeBytes), writeFile(join(outDir, 'targets.json'), targetsBytes)]);
    const manifest = { sourceCommit: head, tarballSha256: sha256(tarballBytes), probeSha256: sha256(probeBytes), targetsSha256: sha256(targetsBytes) };
    const report = {
      outcome: 'passed',
      plugin: { sourceCommit: head, sha256: manifest.tarballSha256 },
      provenance: { producer: { source: 'git-archive', commit: lockCommit }, inputs: { mode: 'all', ...manifest } },
    };
    await Promise.all([writeFile(join(outDir, 'e1-manifest.json'), JSON.stringify(manifest)), writeFile(join(outDir, 'host-report.json'), JSON.stringify(report))]);

    const [first, second] = await Promise.all([verifyHostReport(dir, outDir), verifyHostReport(dir, outDir)]);
    assert.equal(first.tarballSha256, manifest.tarballSha256);
    assert.equal(second.tarballSha256, manifest.tarballSha256);
    await access(join(outDir, 'host-report.json'));

    for (const tamper of [
      async () => { await writeFile(join(outDir, 'targets.json'), '{"admit":{"version":"0.2.2-rc.9"}}\n'); },
      async () => { const r = structuredClone(report); r.provenance.inputs.tarballSha256 = '0'.repeat(64); await writeFile(join(outDir, 'host-report.json'), JSON.stringify(r)); },
      async () => { const r = structuredClone(report); r.provenance.inputs.sourceCommit = '2'.repeat(40); await writeFile(join(outDir, 'host-report.json'), JSON.stringify(r)); },
      async () => { const r = structuredClone(report); r.provenance.producer.commit = '3'.repeat(40); await writeFile(join(outDir, 'host-report.json'), JSON.stringify(r)); },
    ]) {
      await Promise.all([
        writeFile(join(outDir, 'targets.json'), targetsBytes),
        writeFile(join(outDir, 'e1-manifest.json'), JSON.stringify(manifest)),
        writeFile(join(outDir, 'host-report.json'), JSON.stringify(report)),
      ]);
      await tamper();
      await assert.rejects(() => verifyHostReport(dir, outDir));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mise env inherited DSH_ENGINEERING_ACTIVE_RUN_DIR still allocates fresh per-run directories while honoring explicit DSH_ENGINEERING_RUN_DIR', { skip: !hasMise }, () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.DSH_ENGINEERING_RUN_DIR;
  delete cleanEnv.DSH_ENGINEERING_ACTIVE_RUN_DIR;
  const loaded = JSON.parse(execFileSync('mise', ['env', '--json'], { cwd: repoRoot, env: cleanEnv, encoding: 'utf8' }));
  assert.match(loaded.DSH_ENGINEERING_ACTIVE_RUN_DIR ?? '', /\/\.local\/engineering\/run-\d+-\d+$/);
  assert.equal(loaded.DSH_ENGINEERING_RUN_DIR, undefined);
  const inheritedEnv = { ...cleanEnv, DSH_ENGINEERING_ACTIVE_RUN_DIR: loaded.DSH_ENGINEERING_ACTIVE_RUN_DIR };
  const readActive = (env) => execFileSync('mise', ['exec', '--', 'node', '-p', 'process.env.DSH_ENGINEERING_ACTIVE_RUN_DIR'], { cwd: repoRoot, env, encoding: 'utf8' }).trim();
  const [first, second] = [readActive(inheritedEnv), readActive(inheritedEnv)];
  assert.notEqual(first, loaded.DSH_ENGINEERING_ACTIVE_RUN_DIR);
  assert.notEqual(second, loaded.DSH_ENGINEERING_ACTIVE_RUN_DIR);
  assert.notEqual(first, second);
  assert.equal(readActive({ ...inheritedEnv, DSH_ENGINEERING_RUN_DIR: 'custom-explicit-run-dir' }), 'custom-explicit-run-dir');
});
