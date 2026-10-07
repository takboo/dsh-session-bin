import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';

const [inputRoot, compression, rawId] = process.argv.slice(2);
const root = await realpath(inputRoot);
const parent = await realpath(fileURLToPath(new URL('../../.local/lifecycle/', import.meta.url)));
const rel = relative(parent, root);
assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'worker requires isolated lifecycle data');
assert(['none', 'zstd'].includes(compression));
assert(rawId);
process.env.DSH_HOME = join(root, 'dsh-home');
const ctx = new Context();
let handle;
let result;
try {
  await ctx.plugin(SessionStore);
  const fiber = ctx.plugin(Jsonl, { root: join(root, 'logs'), compression });
  await fiber;
  if (fiber.error) throw fiber.error;
  try {
    handle = await ctx.sessionPersistence.open(SessionId(rawId), 'write');
    result = { opened: true };
  } catch (error) {
    if (!(error instanceof SessionAlreadyOwnedError)) throw error;
    result = { opened: false, error: error.constructor.name };
  }
} finally { await handle?.close(); await ctx.fiber.dispose(); }
await new Promise((resolve, reject) => process.send(result, error => error ? reject(error) : resolve()));
process.disconnect();
