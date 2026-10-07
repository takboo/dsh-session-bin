import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

await build({
  entryPoints: { index: 'src/index.ts', operations: 'src/operations/index.ts', remote: 'src/remote/contracts.ts' },
  outdir: 'dist', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', sourcemap: true,
});
const browser = await build({
  entryPoints: ['src/client/index.ts'], outfile: 'dist/client.js', bundle: true, write: false,
  platform: 'browser', format: 'cjs', target: 'es2022', sourcemap: 'external',
  jsx: 'automatic', tsconfig: 'tsconfig.client.json',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'local-css' },
});
const script = browser.outputFiles.find(file => file.path.endsWith('/client.js'));
const css = browser.outputFiles.find(file => file.path.endsWith('/client.css'));
if (!script || !css) throw new Error('Client build did not produce its script and CSS Modules stylesheet.');
const prefix = `window.__ModuleLoader__.load({ id: "dsh-session-bin", factory(require) {\nvar module = { exports: {} }; var exports = module.exports;\nconst __SESSION_BIN_CSS__ = ${JSON.stringify(css.text)};\n`;
await writeFile('dist/client.js', prefix + script.text + '\nreturn module.exports;\n} });\n');
const map = browser.outputFiles.find(file => file.path.endsWith('/client.js.map'));
if (map) {
  await writeFile('dist/client.js.map', JSON.stringify({ version: 3, file: 'client.js', sections: [{
    offset: { line: prefix.split('\n').length - 1, column: 0 }, map: JSON.parse(map.text),
  }] }));
}
// Pure model entry for public-Interface behavior tests; the product browser uses
// the lazy factory above and the Host has no import edge into this module.
await build({ entryPoints: ['src/client/model.ts'], outfile: 'dist/client-model.js', bundle: true,
  packages: 'external', platform: 'neutral', format: 'esm', target: 'es2022' });
