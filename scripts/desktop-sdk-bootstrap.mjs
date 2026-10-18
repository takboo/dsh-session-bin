import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.DSH_SESSION_BIN_DESKTOP_SDK;
assert(root && isAbsolute(root), 'Desktop qualification requires the explicit installed ASAR SDK root.');
const anchor = pathToFileURL(join(root, 'package.json')).href;
// The Desktop Host tree excludes these standalone browser packages. Their
// published client factories remain tested in the real Electron runtime.
const publicClientSuites = new Set(['client-i18n.test.mjs', 'client-load.test.mjs',
  'native-deletion-batch-ui.test.mjs', 'native-deletion-client.test.mjs']);
if (!publicClientSuites.has(basename(process.argv[1] ?? ''))) registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith('@deepseek-ai/') ? next(specifier, { ...context, parentURL: anchor }) : next(specifier, context);
  },
});
