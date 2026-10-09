import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(process.versions.node, manifest.engines.node);
const parent = join(root, '.local', 'platform');
await mkdir(parent, { recursive: true });
const artifacts = await mkdtemp(join(parent, 'linux-container-'));
const image = `node:${manifest.engines.node}-bookworm`;
const program = `
import { cp, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const rootFiles = ${JSON.stringify(['.gitignore', '.editorconfig', 'LICENSE', 'cordis.patch.yml', 'tsconfig.client.json', 'tsconfig.json', 'CONTRIBUTING.md', 'AGENTS.md', 'README.md', 'pnpm-lock.yaml', 'package.json', 'mise.toml'])};
for (const path of [...rootFiles, 'src', 'tests', 'scripts', 'docs', 'locale', '.github']) await cp(join('/source', path), join('/work', path), { recursive: true });
const config = await readFile('/work/mise.toml', 'utf8');
const install = /\\[tasks\\.install\\]([\\s\\S]*?)(?=\\n\\[|$)/.exec(config)?.[1];
const command = /^run = \"([^\"]+)\"$/m.exec(install ?? '')?.[1];
if (!command?.startsWith('pnpm ')) throw new Error('The configured install command is unavailable.');
async function run(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn('corepack', args, { cwd: '/work', stdio: 'inherit', env: { ...process.env, CI: 'true' } });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
let code = await run(['enable', 'pnpm']);
if (code === 0) code = await run(['pnpm', ...command.slice(5).split(' ')]);
if (code === 0) code = await run(['pnpm', 'run', 'verify:platform']);
for (const path of ['platform', 'lifecycle']) {
  try { await cp(join('/work/.local', path), join('/artifacts', path), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log(JSON.stringify({ exported: '/artifacts', status: code === 0 ? 'passed' : 'failed' }));
process.exitCode = code;
`;
const code = await new Promise((resolve, reject) => {
  const child = spawn('docker', ['run', '--rm', '--name', `dsh-session-bin-linux-${randomUUID()}`,
    '--mount', `type=bind,source=${root},target=/source,readonly`,
    '--mount', `type=bind,source=${artifacts},target=/artifacts`, '--workdir', '/work', image,
    'node', '--input-type=module', '-e', program], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
console.log(JSON.stringify({ image, artifacts, exitCode: code, limits: 'Linux container on its native container filesystem; not Windows, macOS x64, or a separate Linux desktop GUI.' }, null, 2));
process.exitCode = code;
