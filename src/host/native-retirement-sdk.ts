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
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "6fad466aa1f7aa64bfa038681ead5721f66c88e9891e25d357d2b8edbccd5494",
      "lib/types/index.js": "c5495c724adf558e5cba6d504d8ee03b1fe78657d056cbb4238f4af20b21418c"
    }
  },
  "dsh-session-persistence": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "cc0b6d3a224133af611b428d5a49020e300f86c3b4ba28037aeb219029bde3eb"
    }
  },
  "dsh-session-persistence-jsonl": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "69efef5f84dddf947032bc1425067878fa610416c8885acde2ded9b01230c9b7"
    }
  },
  "dsh-session-format-catalog": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "836bbb772ab505c299f1a4a246164c50c7c08b67ab0d17f1251d7ea2cd8c1818",
      "lib/types/index.js": "c7d797760bf2b9bc654751f2f8cb0b8a6b98998c8d9c1e41323c71a4d5f316f2"
    }
  },
  "dsh-storage-domain": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "c425203d549c358d0a72d6476cec32235e51ae8e98ef32cac8576bd4c9b217c2"
    }
  },
  "dsh-storage-json": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "39e6857f984570267a96fc52c08c04e520b15c322336f6f95838554f6ce16dec"
    }
  },
  "dsh-workspace": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "931ca0cb10c5102066c7723690a887f0e6e8e7ab0ffdee1a782686745b0b934f",
      "lib/types/index.js": "ed69989d8286598fddb3a40030723810a1238968e91ccfec05fc84657bb5ec74"
    }
  },
  "dsh-session-query": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "76ce2944e561c12f48b5e240d68cafe54ce6d667b1d20722e6939ed834489939"
    }
  },
  "dsh-session-query-sqlite": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0"
    }
  },
  "dsh-session-projection-cache": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "faf307dce5db2fb7ff58b4c7d9e544fc7cad5de2f270a89326a8d7bb2bda9c80"
    }
  },
  "dsh-api-session-controller": {
    "version": "0.2.2-rc.1",
    "files": {
      "lib/index.js": "4cf6c66e65cce865d270fa89405b96d048ffa62e493e4ffbd1a826be2207a4cd",
      "lib/types/index.js": "16a1fa74380490e14d5f0d2cbae3ade0c9c2c4d0a06fa8f1e87c573d1c8da9fd"
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
  if (JSON.parse(await readFile(hostPath, 'utf8')).version !== '0.2.2-rc.1') return null;
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
    'dsh-agent': '8673b5cfadfbb6e6ce0bcb341d0ea2877adc2986eab1c2b6c8baf32726534c92',
    'dsh-agent-loop': 'a6fa8e0c7c90191caf5f4a3bb5c624a86e9845cf3c79d020b71420d0e20ae4c1',
  })) {
    let path: string;
    try { path = runtime.resolve(`@deepseek-ai/${name}/package.json`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return null; throw error; }
    if ((JSON.parse(await readFile(path, 'utf8')) as { version: string }).version !== '0.2.2-rc.1'
      || createHash('sha256').update(await readFile(join(dirname(path), 'lib/index.js'))).digest('hex') !== expected) return null;
  }
  return legacyDurableContractFingerprint;
}
