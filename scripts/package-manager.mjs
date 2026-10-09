import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

/** mise supplies a standalone executable; Corepack supplies a JavaScript CLI.
 * Execute both directly without assuming npm_execpath is a Node script or
 * interpolating arguments through a Windows command shell. */
export async function configuredPackageManager(args) {
  const entry = process.env.npm_execpath;
  if (entry && isAbsolute(entry) && /\.(?:cjs|mjs|js)$/i.test(entry)) {
    await access(entry);
    return { file: process.execPath, args: [entry, ...args] };
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
