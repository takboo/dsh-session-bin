import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

/** Locked public npm implementation files actually inspected and tested. */
export const nativeRetirementSdkSources = {
  cordis: { version: '4.0.4', files: { 'lib/index.js': '6a9394c0877ff45218818c6e815edd038f8057e1a1deb390a8d43ec81c57691e' } },
  'dsh-session': { version: '0.2.0-rc.2', files: { 'lib/index.js': '87ea85e2fb5318bf1f826db9a1c88c1b26d3ea328027a7f32b211880c4d62b9d', 'lib/types/index.js': '71b3a3578b85704f026b590462e7d5e8bceb6dededd4e8782a83696138ec7da7' } },
  'dsh-session-persistence': { version: '0.2.0-rc.2', files: { 'lib/index.js': 'cc0b6d3a224133af611b428d5a49020e300f86c3b4ba28037aeb219029bde3eb' } },
  'dsh-session-persistence-jsonl': { version: '0.2.0-rc.2', files: { 'lib/index.js': '0845707017acc2b4a8a75eab2244fa3fd88587b8094ab32014321dce7ca1e31b' } },
  'dsh-session-format-catalog': { version: '0.2.0-rc.2', files: { 'lib/index.js': '836bbb772ab505c299f1a4a246164c50c7c08b67ab0d17f1251d7ea2cd8c1818', 'lib/types/index.js': 'c7d797760bf2b9bc654751f2f8cb0b8a6b98998c8d9c1e41323c71a4d5f316f2' } },
  'dsh-storage-domain': { version: '0.2.0-rc.2', files: { 'lib/index.js': 'e536ba09b7ccc0f10bb54818dfe44454374e5cbf7aeba140b216ba1ca2e87517' } },
  'dsh-storage-json': { version: '0.2.0-rc.2', files: { 'lib/index.js': '0a6b75d5569db3379edd93e863570170e1f4121b6c9fabd856f5b476cffe8df4' } },
  'dsh-workspace': { version: '0.2.0-rc.2', files: { 'lib/index.js': 'a33af459cfc7af29dd17412443a63655fd5037dd348b0dec20a413ce60c6c8bc', 'lib/types/index.js': 'dbc8cc80e2b33c6bce07c73bd4e43be08af02051077ea9e032c2db2b9a154104' } },
  'dsh-session-query': { version: '0.2.0-rc.2', files: { 'lib/index.js': 'dd8056fad008063c7e85169d4306720abe8efa6b32eac98f1b3053c6f89894aa' } },
  'dsh-session-query-sqlite': { version: '0.2.0-rc.2', files: { 'lib/index.js': 'dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0' } },
  'dsh-session-projection-cache': { version: '0.2.0-rc.2', files: { 'lib/index.js': '797282e86a23ece3a6a6246765277ec00360813bc0bac0450caff8c56278db0b' } },
  'dsh-api-session-controller': { version: '0.2.0-rc.2', files: { 'lib/index.js': 'fb0f7b96130f595db20809eeb77a195b05f4a039f931d1e67692f1f74a4dd269', 'lib/types/index.js': '764de9dca8a029a3c874f8fe15b864de59b222666853319f0e5f16fe29909e9f' } },
} as const;

export async function nativeRetirementSdkFingerprint(): Promise<string | null> {
  const root = createRequire(import.meta.url);
  const base = createRequire(root.resolve('@deepseek-ai/dsh/package.json'));
  for (const [name, expected] of Object.entries(nativeRetirementSdkSources)) {
    let path: string;
    try { path = root.resolve(`@deepseek-ai/${name}/package.json`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
      try { path = base.resolve(`@deepseek-ai/${name}/package.json`); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return null; throw cause; }
    }
    const meta = JSON.parse(await readFile(path, 'utf8')) as { version?: string };
    if (meta.version !== expected.version) return null;
    for (const [file, digest] of Object.entries(expected.files)) {
      if (createHash('sha256').update(await readFile(join(dirname(path), file))).digest('hex') !== digest) return null;
    }
  }
  return createHash('sha256').update(JSON.stringify(nativeRetirementSdkSources)).digest('hex');
}
