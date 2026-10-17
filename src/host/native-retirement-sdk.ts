import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

/** Locked public npm implementation files actually inspected and tested. */
export const nativeRetirementSdkSources = {
  "cordis": {
    "version": "4.0.5",
    "files": {
      "lib/index.js": "6a9394c0877ff45218818c6e815edd038f8057e1a1deb390a8d43ec81c57691e"
    }
  },
  "dsh-session": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf",
      "lib/types/index.js": "59cced30c7ee65813c62f4858c2fc15c8c636df96507b60c15543468178b72f2"
    }
  },
  "dsh-session-persistence": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "cc0b6d3a224133af611b428d5a49020e300f86c3b4ba28037aeb219029bde3eb"
    }
  },
  "dsh-session-persistence-jsonl": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "973dd78679b2661d6f492343bc22b124ae958aa597d3b36c698a2c650f909984"
    }
  },
  "dsh-session-format-catalog": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "836bbb772ab505c299f1a4a246164c50c7c08b67ab0d17f1251d7ea2cd8c1818",
      "lib/types/index.js": "c7d797760bf2b9bc654751f2f8cb0b8a6b98998c8d9c1e41323c71a4d5f316f2"
    }
  },
  "dsh-storage-domain": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "a54f7664d2f64fe04a08c7058ca5bff4fc69ed6a0d30c2bc11561b620698ef16"
    }
  },
  "dsh-storage-json": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "0a6b75d5569db3379edd93e863570170e1f4121b6c9fabd856f5b476cffe8df4"
    }
  },
  "dsh-workspace": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "931ca0cb10c5102066c7723690a887f0e6e8e7ab0ffdee1a782686745b0b934f",
      "lib/types/index.js": "ed69989d8286598fddb3a40030723810a1238968e91ccfec05fc84657bb5ec74"
    }
  },
  "dsh-session-query": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "76ce2944e561c12f48b5e240d68cafe54ce6d667b1d20722e6939ed834489939"
    }
  },
  "dsh-session-query-sqlite": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0"
    }
  },
  "dsh-session-projection-cache": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "faf307dce5db2fb7ff58b4c7d9e544fc7cad5de2f270a89326a8d7bb2bda9c80"
    }
  },
  "dsh-api-session-controller": {
    "version": "0.2.1-rc.1",
    "files": {
      "lib/index.js": "a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386",
      "lib/types/index.js": "616ced16623b7448afa908ff65093eb6ef2a478d32e5ef9bc22634bfa9f80472"
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
  if (JSON.parse(await readFile(hostPath, 'utf8')).version !== '0.2.1-rc.1') return null;
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
    'dsh-agent': '7b59cf82c2784c25bdce4e3e24e5e5303b02b9f1003efacf50255492d17baf8b',
    'dsh-agent-loop': 'cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033',
  })) {
    let path: string;
    try { path = runtime.resolve(`@deepseek-ai/${name}/package.json`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return null; throw error; }
    if ((JSON.parse(await readFile(path, 'utf8')) as { version: string }).version !== '0.2.1-rc.1'
      || createHash('sha256').update(await readFile(join(dirname(path), 'lib/index.js'))).digest('hex') !== expected) return null;
  }
  return legacyDurableContractFingerprint;
}
