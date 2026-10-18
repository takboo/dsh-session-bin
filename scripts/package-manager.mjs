import { access, readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build tools stay fixed by mise even when package engines accept more carriers. */
export async function configuredNodeVersion(root = fileURLToPath(new URL('../', import.meta.url))) {
  const config = await readFile(join(root, 'mise.toml'), 'utf8');
  const tools = /\[tools\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(config)?.[1];
  const version = /^node\s*=\s*"(\d+\.\d+\.\d+)"$/m.exec(tools ?? '')?.[1];
  if (!version) throw new Error('mise must declare an exact Node build version.');
  return version;
}

/** Match the official Desktop Host's Electron Node invocation. */
export function nodeRuntimeArgs() {
  return process.versions.electron ? ['--expose-internals'] : [];
}

/** mise supplies a standalone executable; Corepack supplies a JavaScript CLI.
 * Execute both directly without assuming npm_execpath is a Node script or
 * interpolating arguments through a Windows command shell. */
export async function configuredPackageManager(args) {
  const entry = process.env.npm_execpath;
  if (entry && isAbsolute(entry) && /\.(?:cjs|mjs|js)$/i.test(entry)) {
    await access(entry);
    return { file: process.execPath, args: [...nodeRuntimeArgs(), entry, ...args] };
  }
  if (entry && isAbsolute(entry) && !/\.(?:cmd|bat)$/i.test(entry)) {
    await access(entry);
    return { file: entry, args };
  }
  if (process.platform === 'win32') {
    for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
      const executable = join(directory, 'pnpm.exe');
      try { await access(executable); return { file: executable, args }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    throw new Error('Use the configured mise pnpm executable or a Corepack JavaScript CLI for Windows verification.');
  }
  return { file: 'pnpm', args };
}
