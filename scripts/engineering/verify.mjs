import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredNodeVersion } from '../package-manager.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [mode = 'all', input, ...extra] = process.argv.slice(2);
assert((mode === 'all' && extra.length === 0) ||
  (mode === 'tart-native' && input && extra.length === 2) ||
  (['doctor', 'tart-status', 'tart-readiness'].includes(mode) && input === undefined),
'Usage: mise run verify:engineering -- [all [source-ref] | doctor | tart-status | tart-readiness | tart-native run-dir desktop.zip feed-sha512]');
assert.equal(process.versions.node, await configuredNodeVersion(root), 'Use the project Node version from mise.toml.');

const lockPath = join(root, 'dsh-engineering.lock.json');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const lock = json(lockPath);
const https = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/i;
const ssh = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+)$/i;
const repositoryId = match => match?.[1].replace(/\.git$/i, '').toLowerCase();
const repository = repositoryId(https.exec(lock.repository));
assert(lock.schemaVersion === 1 && repository && /^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(lock.tag) &&
  /^[a-f0-9]{40}$/.test(lock.commit), 'Invalid engineering lock.');

const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dsh-plugin-engineering/checkout');
let checkout = process.env.DSH_ENGINEERING_CHECKOUT;
if (checkout === undefined) {
  try { checkout = readFileSync(configPath, 'utf8').replace(/\n$/, ''); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Set DSH_ENGINEERING_CHECKOUT or configure the engineering checkout.', { cause: error });
  }
}
assert(isAbsolute(checkout) && !/[\x00-\x1f\x7f]/.test(checkout),
  'Engineering checkout must be a single absolute path.');
checkout = realpathSync(checkout);
const git = (cwd, args) => execFileSync('git', ['--no-replace-objects', '-C', cwd, ...args], { encoding: 'utf8' }).trim();
assert.equal(git(checkout, ['rev-parse', '--show-toplevel']), checkout, 'Select the engineering checkout root.');
const origin = git(checkout, ['remote', 'get-url', '--all', 'origin']);
assert.equal(repositoryId(https.exec(origin) ?? ssh.exec(origin)), repository, 'Engineering origin differs from lock.');
assert.equal(git(checkout, ['rev-parse', '--verify', `refs/tags/${lock.tag}^{commit}`]), lock.commit,
  'Engineering tag differs from lock.');

function extractCommit(repo, commit, directory, archive) {
  mkdirSync(directory);
  git(repo, ['archive', '--format=tar', `--output=${archive}`, commit]);
  try { execFileSync('tar', ['-xf', archive, '-C', directory], { stdio: 'inherit' }); }
  finally { rmSync(archive, { force: true }); }
}

const scratch = mkdtempSync(join(tmpdir(), 'session-bin-engineering-'));
const base = join(scratch, 'base');
const targets = join(root, 'scripts/engineering/targets.json');
const env = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
  npm_config_cache: join(scratch, 'npm-cache') };
const runner = (script, args, runEnv = env) => execFileSync('bash', [join(base, script), ...args],
  { cwd: root, env: runEnv, stdio: 'inherit' });

function prepareSource(commit) {
  const source = join(scratch, 'source');
  extractCommit(root, commit, source, join(scratch, 'source.tar'));
  const pkg = json(join(source, 'package.json'));
  const pnpm = (args, stdio) => execFileSync('pnpm', args, { cwd: source, env, encoding: 'utf8', stdio });
  assert.equal(pnpm(['--version']).trim(), pkg.packageManager.replace(/^pnpm@/, ''), 'Use the source commit’s pinned pnpm.');
  return { source, pkg, pnpm };
}

function candidateFrom(job) {
  const baseline = json(join(job, 'report.json'));
  assert.equal(baseline.provenance.producer.source, 'git-archive');
  assert.equal(baseline.provenance.producer.commit, lock.commit);
  const { sourceCommit, tarballSha256 } = baseline.provenance.inputs;
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(sourceCommit, baseline.plugin.sourceCommit);
  const packages = readdirSync(job).filter(file => file.endsWith('.tgz'));
  assert.equal(packages.length, 1, 'Expected one candidate in the original run directory.');
  const tarball = join(job, packages[0]);
  assert.equal(sha256(tarball), tarballSha256);
  assert.equal(tarballSha256, baseline.plugin.sha256);
  return { baseline, tarball, commit: sourceCommit };
}

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

function verifyContainer({ tarball, commit, probe, reportFile }) {
  try {
    runner('scripts/run-container.sh', ['all', targets, probe, tarball, commit, reportFile]);
  } finally {
    if (existsSync(reportFile)) {
      const report = json(reportFile);
      const { producer, inputs } = report.provenance;
      assert.equal(producer.source, 'git-archive');
      assert.equal(producer.commit, lock.commit);
      for (const [file, digest] of Object.entries(producer.files)) assert.equal(digest, sha256(join(base, file)), file);
      assert.equal(inputs.sourceCommit, commit);
      assert.equal(inputs.tarballSha256, sha256(tarball));
      assert.equal(inputs.probeSha256, sha256(probe));
      assert.equal(inputs.targetsSha256, sha256(targets));
    }
  }
}

try {
  extractCommit(checkout, lock.commit, base, join(scratch, 'base.tar'));
  assert.equal(readFileSync(join(base, '.engineering-revision'), 'utf8').trim(), lock.commit);
  const files = git(checkout, ['ls-tree', '-r', '--name-only', lock.commit, 'scripts', 'environments']).split('\n');
  for (const file of files) {
    const blob = execFileSync('git', ['--no-replace-objects', '-C', checkout, 'show', `${lock.commit}:${file}`]);
    assert(readFileSync(join(base, file)).equals(blob), `Exported engineering file differs from the locked object: ${file}`);
  }
  if (mode === 'doctor') {
    runner('scripts/lab.sh', ['doctor', '--checkout', checkout, '--lock', lockPath]);
  } else if (mode === 'tart-status') {
    runner('scripts/run-tart.sh', ['status']);
  } else if (mode === 'tart-readiness') {
    runner('scripts/run-tart.sh', ['run', join(base, 'environments/tart-readiness.sh')], { ...env, DSH_TART_INPUTS: '' });
  } else if (mode === 'tart-native') {
    assert.equal(process.platform, 'darwin');
    assert.equal(process.arch, 'arm64');
    const { baseline, tarball, commit } = candidateFrom(resolve(input));
    const [desktopZip, expectedDesktopSha] = extra;
    assert.match(expectedDesktopSha, /^[A-Za-z0-9+/]{86}==$/, 'Provide the official feed SHA-512.');
    const inputs = join(scratch, 'inputs');
    mkdirSync(inputs);
    const zip = join(inputs, 'desktop.zip');
    copyFileSync(resolve(desktopZip), zip);
    assert.equal(await digest(zip, 'sha512', 'base64'), expectedDesktopSha);
    const { source, pnpm } = prepareSource(commit);
    assert.equal(process.versions.node, await configuredNodeVersion(source), 'Source and caller must pin the same Node build version.');
    pnpm(['install', '--frozen-lockfile', '--ignore-scripts'], 'inherit');
    const project = join(inputs, 'project.tar.gz');
    execFileSync('tar', ['-czf', project, '-C', source, '.'], { stdio: 'inherit', env: { ...env, COPYFILE_DISABLE: '1' } });
    copyFileSync(tarball, join(inputs, 'plugin.tgz'));
    const guestProbe = join(root, 'scripts/engineering/desktop-guest.sh');
    console.log(`Source: ${commit}\nEngineering: ${lock.tag} ${lock.commit}\nGuest probe SHA-256: ${sha256(guestProbe)}`);
    runner('scripts/run-tart.sh', ['run', guestProbe,
      sha256(tarball), expectedDesktopSha, await digest(project, 'sha256', 'hex'), baseline.plugin.enginesDsh],
    { ...env, DSH_TART_INPUTS: inputs });
  } else {
    const commit = git(root, ['rev-parse', '--verify', '--end-of-options', `${input ?? 'HEAD'}^{commit}`]);
    const { source, pkg, pnpm } = prepareSource(commit);
    const output = join(root, '.local/engineering');
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const job = mkdtempSync(join(output, 'shared-'));
    console.log(`Source: ${commit}\nEngineering: ${lock.tag} ${lock.commit}\nArtifacts: ${job}`);

    assert.equal(process.versions.node, await configuredNodeVersion(source), 'Source and caller must pin the same Node build version.');
    pnpm(['install', '--frozen-lockfile', '--ignore-scripts'], 'inherit');
    pnpm(['run', 'build'], 'inherit');
    const [pack] = JSON.parse(pnpm(['exec', 'npm', 'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', job]));
    const tarball = join(job, pack.filename);
    assert.equal(pkg.engines.dsh, json(targets).admit.version,
      'The representative package must declare the admitted host.');
    const probe = join(job, 'probe.mjs');
    const { build } = createRequire(join(source, 'package.json'))('esbuild');
    await build({ entryPoints: [join(root, 'scripts/engineering/web-probe.mjs')], outfile: probe,
      bundle: true, platform: 'node', format: 'esm', target: 'node24' });
    const reportFile = join(job, 'report.json');
    console.log(`Candidate: ${tarball}\nSHA-256: ${sha256(tarball)}`);
    verifyContainer({ tarball, commit, probe, reportFile });
  }
} catch (error) {
  if (typeof error.status !== 'number') throw error;
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = error.status || 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
