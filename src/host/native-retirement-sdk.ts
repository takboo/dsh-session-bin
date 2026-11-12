import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

/** Locked public npm implementation files actually inspected and tested. */
export const nativeRetirementSdkSources = {
  "cordis": {
    "version": "4.1.0",
    "files": {
      "lib/index.js": "627409afa06a265f7253200d3bc4648e88805c39fd3768568eb9b9518a31fe8f"
    }
  },
  "dsh-session": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "d9911b5e1585bcb142d03ce46eb2990b3fc7c254de5a76d3ffb124bd2469216c",
      "lib/types/index.js": "1fab1e6e7e2dbcd1c3a43d563e5a322d8f32acc1fde79a9b4971de8c59e30345"
    }
  },
  "dsh-session-persistence": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "cc0b6d3a224133af611b428d5a49020e300f86c3b4ba28037aeb219029bde3eb"
    }
  },
  "dsh-session-persistence-jsonl": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "69efef5f84dddf947032bc1425067878fa610416c8885acde2ded9b01230c9b7"
    }
  },
  "dsh-session-format-catalog": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "836bbb772ab505c299f1a4a246164c50c7c08b67ab0d17f1251d7ea2cd8c1818",
      "lib/types/index.js": "c7d797760bf2b9bc654751f2f8cb0b8a6b98998c8d9c1e41323c71a4d5f316f2"
    }
  },
  "dsh-storage-domain": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "c425203d549c358d0a72d6476cec32235e51ae8e98ef32cac8576bd4c9b217c2"
    }
  },
  "dsh-storage-json": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "39e6857f984570267a96fc52c08c04e520b15c322336f6f95838554f6ce16dec"
    }
  },
  "dsh-workspace": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "8964c54f3c3f2fd79ed92e5fb1413d84ba80272c4eb984677aaf70bf4d687848",
      "lib/types/index.js": "ce43ed8267aa1c33ba68e0c22b63bb75010445de46839faa6817e3b1d3ae37ac"
    }
  },
  "dsh-session-query": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "cd479b998f66e04639ec3e626fca706ce4f8aad40b75e983e549043ae9d0185b"
    }
  },
  "dsh-session-query-sqlite": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0"
    }
  },
  "dsh-session-projection-cache": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "faf307dce5db2fb7ff58b4c7d9e544fc7cad5de2f270a89326a8d7bb2bda9c80"
    }
  },
  "dsh-api-session-controller": {
    "version": "0.2.2-rc.2",
    "files": {
      "lib/index.js": "c6ce8f8014d943c8f2dceaf7a9b184a56b2de757de6097938646549d2d2a9087",
      "lib/types/index.js": "62ed25594059345feb580a0a54c2e89e83fa1c956aa6f0d73121a0070f3e1ace"
    }
  }
} as const;

/** Schema-1 resource identity, preserved across the audited runtime upgrade.
 * These are historical wire identifiers, not the installed SDK version. */
export const legacyDurableHostContract = '0.2.0-rc.2';
const legacyDurableContractFingerprint = '2618a33decce99fe8ae893245236273d10ac5536bb9dd582dddd115ef27069f3';

export async function nativeRetirementSdkFingerprint(): Promise<string | null> {
  const root = createRequire(import.meta.url);
  const hostPath = root.resolve('@deepseek-ai/dsh/package.json');
  if (JSON.parse(await readFile(hostPath, 'utf8')).version !== '0.2.2-rc.2') return null;
  const base = createRequire(hostPath);
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
  // Idle API lifecycle release additionally uses the returned AgentHandle and
  // the driver's phase (maintenance is publicly reported as idle). These extra
  // runtime checks do not change the existing durable resource/journal identity.
  const runtime = createRequire(base.resolve('@deepseek-ai/dsh-base/package.json'));
  for (const [name, expected] of Object.entries({
    'dsh-agent': 'bc2a39dea1174c2b2dc0641f08094f840d3a1e414bef42ac93c945f7235d7ead',
    'dsh-agent-loop': 'f09f60814d4e96a880f41b9fc3832f33c56a28f954f48810d8439ce83ad6ffa8',
  })) {
    let path: string;
    try { path = runtime.resolve(`@deepseek-ai/${name}/package.json`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return null; throw error; }
    if ((JSON.parse(await readFile(path, 'utf8')) as { version: string }).version !== '0.2.2-rc.2'
      || createHash('sha256').update(await readFile(join(dirname(path), 'lib/index.js'))).digest('hex') !== expected) return null;
  }
  return legacyDurableContractFingerprint;
}
