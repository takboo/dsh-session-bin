import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filesystemEvidence } from '../scripts/filesystem-evidence.mjs';

const path = '/fixture/workspace with spaces';
const df = 'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk4s5 100 20 80 20% /System/Volumes/Data\n';
function options(type, mounts) {
  return { platform: 'darwin', readStatfs: async () => ({ type, bsize: 4096n }),
    capture: async (file, args) => {
      if (file === '/bin/df') { assert.deepEqual(args, ['-P', path]); return df; }
      assert.equal(file, '/sbin/mount'); assert.deepEqual(args, []); return mounts;
    } };
}
for (const type of [0x19n, 0x1an]) test(`Darwin filesystem evidence reads the mounted name independently of f_type ${type}`, async () => {
  const result = await filesystemEvidence(path, options(type,
    '/dev/disk1s1 on / (hfs, local)\n/dev/disk4s5 on /System/Volumes/Data (apfs, local, journaled)\n'));
  assert.deepEqual(result, { name: 'apfs', type: `0x${type.toString(16)}`, blockSize: '4096' });
});
test('Darwin evidence does not label a different filesystem APFS because its numeric index matches', async () => {
  assert.equal((await filesystemEvidence(path, options(0x1an, '/dev/disk4s5 on /fixture (hfs, local)\n'))).name, 'hfs');
});
for (const mounts of ['/dev/disk9s1 on / (apfs, local)\n',
  '/dev/disk4s5 on /one (apfs, local)\n/dev/disk4s5 on /two (hfs, local)\n']) {
  test('Darwin evidence refuses a missing or inconsistent device identity', async () => {
    await assert.rejects(filesystemEvidence(path, options(0x19n, mounts)));
  });
}
