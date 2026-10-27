import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export async function candidateOverlay({ workspace, baseline, targetVersion, output }) {
  const path = join(workspace, 'src/host/native-retirement-sdk.ts');
  let source = await readFile(path, 'utf8');
  const sourcesMatch = /export const nativeRetirementSdkSources = (\{[\s\S]*?\n\}) as const;/.exec(source);
  assert(sourcesMatch, 'Unknown SDK audit table shape');
  const inventory = JSON.parse(sourcesMatch[1]);
  const rootRequire = createRequire(join(workspace, 'package.json'));
  const hostRequire = createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json'));
  const resolvePackage = name => { try { return rootRequire.resolve(`@deepseek-ai/${name}/package.json`); } catch { return hostRequire.resolve(`@deepseek-ai/${name}/package.json`); } };
  const audit = [];
  for (const [name, expected] of Object.entries(inventory)) {
    const packagePath = resolvePackage(name);
    const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
    assert.equal(metadata.version, name.startsWith('dsh') ? targetVersion : expected.version, `Unexpected ${name} version`);
    for (const [file, old] of Object.entries(expected.files)) {
      const actual = createHash('sha256').update(await readFile(join(dirname(packagePath), file))).digest('hex');
      audit.push({ name, file, version: metadata.version, baseline: old, actual, unchanged: old === actual });
      expected.files[file] = actual;
    }
    expected.version = metadata.version;
  }
  const runtimeRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-base/package.json'));
  for (const name of ['dsh-agent', 'dsh-agent-loop']) {
    const packagePath = runtimeRequire.resolve(`@deepseek-ai/${name}/package.json`);
    assert.equal(JSON.parse(await readFile(packagePath, 'utf8')).version, targetVersion);
    const actual = createHash('sha256').update(await readFile(join(dirname(packagePath), 'lib/index.js'))).digest('hex');
    const pattern = new RegExp(`'${name}': '([a-f0-9]{64})'`);
    const old = pattern.exec(source)?.[1]; assert(old);
    audit.push({ name, file: 'lib/index.js', version: targetVersion, baseline: old, actual, unchanged: old === actual });
    source = source.replace(pattern, `'${name}': '${actual}'`);
  }
  source = source.replace(sourcesMatch[1], JSON.stringify(inventory, null, 2));
  source = source.replaceAll(`'${baseline.engines.dsh}'`, `'${targetVersion}'`);
  await writeFile(path, source);
  const jsonlPath = join(workspace, 'src/host/native-jsonl-files.ts');
  const jsonl = await readFile(jsonlPath, 'utf8');
  assert(jsonl.includes(`version !== '${baseline.engines.dsh}'`));
  await writeFile(jsonlPath, jsonl.replace(`version !== '${baseline.engines.dsh}'`, `version !== '${targetVersion}'`));
  // This marker affects reports only. No production API/environment bypass is added.
  await writeFile(join(workspace, '.compatibility-candidate.json'), JSON.stringify({ version: targetVersion, audit }));
  await writeFile(join(output, 'sdk-audit.json'), JSON.stringify(audit, null, 2));
  return { files: audit.length, changed: audit.filter(row => !row.unchanged).map(row => `${row.name}/${row.file}`) };
}
