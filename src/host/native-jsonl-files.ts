import type { BigIntStats } from 'node:fs';
import { lstat, realpath, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { zstdDecompressSync } from 'node:zlib';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
import { acquireWindowsSemaphore, nativePlatformCandidate, openRegularFile, RegularFileRefusal, syncDirectory, windowsSemaphoreName } from './platform-files.js';
import { z } from 'zod';

const integer = z.string().regex(/^\d+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInteger = z.string().regex(/^[1-9]\d*$/);
const nodeIdentitySchema = z.object({ dev: integer, ino: positiveInteger, birthtimeNs: positiveInteger }).strict();
const fileIdentitySchema = nodeIdentitySchema.extend({ size: integer, mtimeNs: integer, ctimeNs: integer, nlink: z.literal('1') }).strict();
const lockIdentitySchema = nodeIdentitySchema.extend({ size: z.literal('0'), nlink: z.literal('1') }).strict();
const windowsLockSchema = z.object({ kind: z.literal('win32-semaphore'), name: z.string().min(1) }).strict();
const nativeLockSchema = z.union([lockIdentitySchema, windowsLockSchema]);
const headerIdentitySchema = z.object({ id: z.string().min(1), createdAt: z.number().int().nonnegative(), cwd: z.string().nullable(),
  parentSession: z.string().nullable(), origin: z.literal('subagent').nullable(), isSeeded: z.boolean(),
  delegationDepth: z.number().int().nonnegative(), agentPreset: z.string().nullable() }).strict();
const fileRowSchema = z.object({ resourceId: z.string().min(1), kind: z.enum(['generation', 'staging']),
  formatVersion: z.number().int().min(0).max(4), compression: z.enum(['none', 'zstd']),
  identity: fileIdentitySchema, digest: hash, header: headerIdentitySchema, revision: hash }).strict().superRefine((value, ctx) => {
    try {
      const kind = classify(value.resourceId);
      if (kind.kind !== value.kind || kind.version !== value.formatVersion || kind.compression !== value.compression
        || value.revision !== sha(JSON.stringify({ identity: value.identity, digest: value.digest, header: value.header }))) {
        ctx.addIssue({ code: 'custom', message: 'Resource classification and identity digest must agree.' });
      }
    } catch { ctx.addIssue({ code: 'custom', message: 'Unknown physical resource name.' }); }
  });
export const nativeJsonlFileSchema = fileRowSchema;
export const nativeJsonlInventorySchema = z.object({ schemaVersion: z.literal(1), root: z.string(),
  rootIdentity: nodeIdentitySchema, directory: z.string(), directoryIdentity: nodeIdentitySchema,
  sessionId: z.string().min(1), compression: z.enum(['none', 'zstd']), header: headerIdentitySchema,
  anchor: z.object({ resourceId: z.string(), identity: nodeIdentitySchema, header: headerIdentitySchema }).strict(),
  lock: nativeLockSchema, files: z.array(fileRowSchema).max(4096), revision: hash }).strict().superRefine((value, ctx) => {
    try {
      const anchor = generation(value.anchor.resourceId);
      if (!isAbsolute(value.root) || value.directory !== join(project(value.header.cwd), segment(value.sessionId))
        || value.header.id !== value.sessionId || !same(value.anchor.header, value.header)
        || !anchor || anchor.compression !== value.compression
        || new Set(value.files.map(row => row.resourceId)).size !== value.files.length
        || value.files.some(row => row.compression !== value.compression || !same(row.header, value.header))
        || value.revision !== sha(JSON.stringify(value.files))) {
        ctx.addIssue({ code: 'custom', message: 'Frozen directory, header identities, file scope and digest must agree.' });
      }
    } catch { ctx.addIssue({ code: 'custom', message: 'Invalid frozen directory or anchor.' }); }
  });
export type NativeJsonlInventory = z.infer<typeof nativeJsonlInventorySchema>;
export type NativeJsonlFileRow = z.infer<typeof fileRowSchema>;
type NodeIdentity = z.infer<typeof nodeIdentitySchema>;
type HeaderIdentity = z.infer<typeof headerIdentitySchema>;
type Encoding = 'none' | 'zstd';

export class NativeJsonlRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NativeJsonlRefusal'; }
}
function refuse(code: string, message: string): never { throw new NativeJsonlRefusal(code, message); }
function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function nodeIdentity(stat: BigIntStats): NodeIdentity {
  if (stat.ino <= 0n || stat.birthtimeNs <= 0n) refuse('jsonl/identity-unavailable', 'The filesystem does not provide a stable inode and creation identity.');
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}
function nodeIdentityFromRow(row: NativeJsonlFileRow): NodeIdentity {
  return { dev: row.identity.dev, ino: row.identity.ino, birthtimeNs: row.identity.birthtimeNs };
}
function fileIdentity(stat: BigIntStats) {
  if (!stat.isFile() || stat.nlink !== 1n) refuse('jsonl/unsafe-file', 'Resources must be exclusive regular files without additional hard links.');
  return fileIdentitySchema.parse({ ...nodeIdentity(stat), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), nlink: '1' });
}
function lockIdentity(stat: BigIntStats) {
  const identity = fileIdentity(stat);
  if (identity.size !== '0') refuse('jsonl/lock-invalid', 'The existing stable lock must contain no session content.');
  return lockIdentitySchema.parse({ ...nodeIdentity(stat), size: '0', nlink: '1' });
}
function headerIdentity(header: { id: string; createdAt: number; cwd?: string; parentSession?: string; origin?: 'subagent'; isSeeded: boolean; delegationDepth?: number; agentPreset?: string }): HeaderIdentity {
  return headerIdentitySchema.parse({ id: header.id, createdAt: header.createdAt, cwd: header.cwd ?? null,
    parentSession: header.parentSession ?? null, origin: header.origin ?? null, isSeeded: header.isSeeded,
    delegationDepth: header.delegationDepth ?? 0, agentPreset: header.agentPreset ?? null });
}
// Independently expressed rules of the pinned on-disk layout; no private SDK imports.
function segment(value: string): string {
  if (!value) refuse('jsonl/identity-invalid', 'A path identity cannot be empty.');
  if (value === '.' || value === '..') return value.replace(/\./g, '~002E');
  return value.replace(/[^A-Za-z0-9._-]/g, unit => `~${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}
function project(cwd: string | null): string {
  if (cwd === null) return '_no-cwd';
  if (!isAbsolute(cwd)) refuse('jsonl/identity-invalid', 'The stored cwd must be absolute.');
  const readable = segment(cwd.replace(/[/\\:]+/g, '-')).replace(/^-+/, '') || 'root';
  return `--${readable.slice(0, 251)}--`;
}
function generation(name: string): { version: number; compression: Encoding } | undefined {
  const match = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/.exec(name);
  if (!match) return;
  const version = match[1] === undefined ? 0 : Number(match[1]);
  if (!Number.isSafeInteger(version) || version > SESSION_FORMAT_VERSION) refuse('jsonl/unsupported-generation', 'Unknown future physical generations cannot be retired.');
  return { version, compression: match[2] ? 'zstd' : 'none' };
}
function classify(name: string) {
  const committed = generation(name);
  if (committed) return { ...committed, kind: 'generation' as const };
  const materializing = /^(session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?)\.[a-f0-9]{12}\.tmp$/.exec(name);
  if (materializing) return { ...generation(materializing[1]!)!, kind: 'staging' as const };
  const migrating = /^session\.migration\.[a-f0-9]{16}\.jsonl(\.zstd)?\.tmp$/.exec(name);
  if (migrating) return { version: SESSION_FORMAT_VERSION, compression: migrating[1] ? 'zstd' as const : 'none' as const, kind: 'staging' as const };
  refuse('jsonl/unknown-resource', `Unclassified session resource: ${name}`);
}

const HEADER_LIMIT = 1024 * 1024;
// Locate one standard Zstandard frame by its frame header and block lengths.
// Decode exactly that frame; a torn later event frame does not hide the header.
function firstFrameEnd(bytes: Buffer): number | undefined {
  if (bytes.length < 5) return;
  if (bytes.readUInt32LE(0) !== 0xfd2fb528) refuse('jsonl/header-invalid', 'The first Zstandard frame is not a standard frame.');
  const descriptor = bytes[4]!;
  if (descriptor & 0x18) refuse('jsonl/header-invalid', 'Reserved Zstandard frame flags are unsupported.');
  const single = Boolean(descriptor & 0x20);
  const sizeFlag = descriptor >>> 6;
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]!;
  const sizeBytes = sizeFlag === 0 ? single ? 1 : 0 : [0, 2, 4, 8][sizeFlag]!;
  let cursor = 5 + (single ? 0 : 1) + dictionaryBytes + sizeBytes;
  if (cursor > bytes.length) return;
  for (;;) {
    if (cursor + 3 > bytes.length) return;
    const block = bytes.readUIntLE(cursor, 3);
    const type = (block >>> 1) & 3;
    if (type === 3) refuse('jsonl/header-invalid', 'Reserved Zstandard block type.');
    cursor += 3 + (type === 1 ? 1 : block >>> 3);
    if (cursor > bytes.length) return;
    if (block & 1) {
      cursor += descriptor & 4 ? 4 : 0;
      return cursor <= bytes.length ? cursor : undefined;
    }
  }
}
function decodeHeader(bytes: Buffer, compression: Encoding, version: number): HeaderIdentity {
  let line: Buffer;
  if (compression === 'none') {
    const newline = bytes.indexOf(10);
    if (newline < 0) refuse('jsonl/header-invalid', 'A complete physical header is required, including for staging.');
    line = bytes.subarray(0, newline);
  } else {
    const end = firstFrameEnd(bytes);
    if (end === undefined) refuse('jsonl/header-invalid', 'A complete Zstandard header frame is required.');
    let decoded: Buffer;
    try { decoded = zstdDecompressSync(bytes.subarray(0, end), { maxOutputLength: HEADER_LIMIT }); }
    catch { refuse('jsonl/header-invalid', 'The bounded first Zstandard frame cannot be decoded.'); }
    if (!decoded.length || decoded.indexOf(10) !== decoded.length - 1) refuse('jsonl/header-invalid', 'The header frame must contain exactly one newline-terminated record.');
    line = decoded.subarray(0, -1);
  }
  try {
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
    const result = sessionFormatCatalog.readHeader(raw);
    if (result.status !== 'current' && result.status !== 'migration-required') refuse('jsonl/header-invalid', 'Malformed or unsupported physical Session header.');
    if (result.storedVersion !== version) refuse('jsonl/header-invalid', 'Physical filename and header versions differ.');
    return headerIdentity(result.header);
  } catch (error) {
    if (error instanceof NativeJsonlRefusal) throw error;
    refuse('jsonl/header-invalid', 'The physical Session header cannot be decoded and identified.');
  }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'; }

interface HeldFileLease {
  stamp: string;
  closing: boolean;
  tail: Promise<void>;
  pending: Set<Promise<void>>;
  recovering: boolean;
}
function leaseStamp(inventory: NativeJsonlInventory): string {
  return JSON.stringify({ root: inventory.root, rootIdentity: inventory.rootIdentity, directory: inventory.directory,
    directoryIdentity: inventory.directoryIdentity, sessionId: inventory.sessionId, compression: inventory.compression,
    header: inventory.header, anchor: inventory.anchor, lock: inventory.lock });
}

/** Exact file erasure; platform kernel leases share the audited JSONL writer namespace. */
export class NativeJsonlFiles {
  private readonly leases = new Map<string, HeldFileLease>();
  private constructor(private readonly provider: Jsonl, readonly root: string, readonly compression: Encoding,
    private readonly rootIdentity: NodeIdentity) {}

  static async open(provider: unknown): Promise<NativeJsonlFiles | undefined> {
    if (!nativePlatformCandidate()) return;
    if (!(provider instanceof Jsonl) || provider.name !== 'session-persistence-jsonl' || SESSION_FORMAT_VERSION !== 4) return;
    const internals = provider as unknown as { root?: unknown; compression?: unknown };
    if (typeof internals.root !== 'string' || !isAbsolute(internals.root)
      || (internals.compression !== 'none' && internals.compression !== 'zstd')
      || typeof provider.config.root !== 'string' || resolve(provider.config.root) !== internals.root
      || (provider.config.compression ?? 'zstd') !== internals.compression) return;
    const require = createRequire(import.meta.url);
    const metadata: unknown = require('@deepseek-ai/dsh-session-persistence-jsonl/package.json');
    if ((metadata as { version?: unknown }).version !== '0.2.0-rc.2') return;
    let root: string;
    try { root = await realpath(internals.root); }
    catch (error) { if (missing(error)) return; throw error; }
    if (process.platform === 'win32' && resolve(internals.root).toLowerCase() !== root.toLowerCase()) return;
    const identity = await lstat(root, { bigint: true });
    if (!identity.isDirectory()) refuse('jsonl/root-invalid', 'The configured root must be an existing directory.');
    if (identity.ino <= 0n || identity.birthtimeNs <= 0n) return;
    return new NativeJsonlFiles(provider, root, internals.compression, nodeIdentity(identity));
  }

  async inspect(sessionId: string, header: SessionHeader): Promise<NativeJsonlInventory> {
    if (header.version !== SESSION_FORMAT_VERSION) refuse('jsonl/identity-invalid', 'Inspection requires the current logical Session header.');
    const identity = headerIdentity(header);
    if (sessionId !== identity.id) refuse('jsonl/identity-invalid', 'Requested session and header identities differ.');
    const directory = join(project(identity.cwd), segment(sessionId));
    const base = await this.directory(directory, sessionId, identity);
    const files = await this.rows(base.path, identity);
    const canonical = files.filter(row => row.kind === 'generation').sort((a, b) => a.formatVersion - b.formatVersion)[0];
    if (!canonical) refuse('jsonl/session-not-found', 'No identified committed generation exists.');
    const inventory = { schemaVersion: 1 as const, root: this.root, rootIdentity: this.rootIdentity,
      directory, directoryIdentity: base.identity, sessionId, compression: this.compression, header: identity,
      anchor: { resourceId: canonical.resourceId,
        identity: { dev: canonical.identity.dev, ino: canonical.identity.ino, birthtimeNs: canonical.identity.birthtimeNs }, header: identity },
      lock: await this.lockIdentity(base.path), files, revision: sha(JSON.stringify(files)) };
    await this.directory(directory, sessionId, identity);
    return nativeJsonlInventorySchema.parse(inventory);
  }

  /** Re-enumerate the entire scope without changing its original durable anchor. */
  async current(input: NativeJsonlInventory): Promise<NativeJsonlInventory> {
    const inventory = this.validate(input);
    const base = await this.assertDirectory(inventory);
    const files = await this.rows(base.path, inventory.header, inventory);
    const lock = await this.lockIdentity(base.path);
    if (!same(lock, inventory.lock)) refuse('jsonl/lock-changed', 'The stable coordination file changed.');
    return nativeJsonlInventorySchema.parse({ ...inventory, files, revision: sha(JSON.stringify(files)) });
  }

  async acquire(input: NativeJsonlInventory, options: { recovering?: boolean } = {}): Promise<{ release(): Promise<void> }> {
    const inventory = this.validate(input);
    const base = await this.assertDirectory(inventory);
    let fd: FileHandle | undefined;
    let unlock: (() => Promise<void>) | undefined;
    const record: HeldFileLease = { stamp: leaseStamp(inventory), closing: false, tail: Promise.resolve(), pending: new Set(),
      recovering: options.recovering === true };
    let held = false;
    try {
      if (process.platform === 'win32') {
        try { unlock = await acquireWindowsSemaphore(join(base.path, 'session.lock'), 'session'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EBUSY') refuse('jsonl/writer-active', 'Another writer holds the session kernel lease.');
          throw error;
        }
      } else {
        fd = await this.openFile(join(base.path, 'session.lock'), 'write');
        if (!same(lockIdentity(await fd.stat({ bigint: true })), inventory.lock)) refuse('jsonl/lock-changed', 'The frozen stable lock changed.');
        try { await tryLockExclusive(fd.fd); }
        catch (error) {
          if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) refuse('jsonl/writer-active', 'Another writer holds the session lock.');
          throw error;
        }
      }
      await this.assertDirectory(inventory);
      if (!same(await this.lockIdentity(base.path), inventory.lock)) refuse('jsonl/lock-changed', 'The held lock no longer has its frozen namespace identity.');
      this.leases.set(inventory.directory, record);
      held = true;
    } finally {
      if (!held) {
        try { await unlock?.(); } finally { await fd?.close(); }
      }
    }
    let releasing: Promise<void> | undefined;
    return { release: () => releasing ??= (async () => {
      record.closing = true;
      await Promise.allSettled([...record.pending]);
      try { try { await unlock?.(); } finally { await fd?.close(); } }
      finally { if (this.leases.get(inventory.directory) === record) this.leases.delete(inventory.directory); }
    })() };
  }

  /** Caller must have persisted the exact retirement intent before this method. */
  async erase(input: NativeJsonlInventory, inputRow: NativeJsonlFileRow): Promise<void> {
    const inventory = this.validate(input); const row = fileRowSchema.parse(inputRow);
    const lease = this.leases.get(inventory.directory);
    if (!lease || lease.closing || lease.stamp !== leaseStamp(inventory)) refuse('jsonl/lease-required', 'Erasure requires the same stable namespace kernel lease.');
    if (!inventory.files.some(saved => same(saved, row))) refuse('jsonl/scope-changed', 'The resource is outside the frozen inventory.');
    const operation = lease.tail.then(() => this.eraseInner(inventory, row));
    lease.tail = operation.then(() => undefined, () => undefined);
    lease.pending.add(operation);
    try { await operation; } finally { lease.pending.delete(operation); }
  }

  private async eraseInner(inventory: NativeJsonlInventory, row: NativeJsonlFileRow): Promise<void> {
    const base = await this.assertDirectory(inventory);
    const names = await readdir(base.path);
    if (names.some(name => name !== 'session.lock' && !inventory.files.some(saved => saved.resourceId === name))) refuse('jsonl/scope-changed', 'A new or unknown file entered the frozen scope.');
    if (!same(await this.lockIdentity(base.path), inventory.lock)) refuse('jsonl/lock-changed', 'The held lock changed.');
    const absolute = join(base.path, row.resourceId);
    const target = resolve(absolute);
    if (target !== absolute || relative(base.path, target) !== row.resourceId) refuse('jsonl/path-invalid', 'The exact resource must be a direct child of its bound directory.');
    const remainder = await this.isWindowsErasureRemainder(inventory, row);
    try {
      if (!remainder) {
        const observed = await this.readRow(base.path, row.resourceId, inventory.header);
        if (!same(row, observed)) refuse('jsonl/resource-changed', 'The physical resource identity or bytes changed after confirmation.');
      }
    } catch (error) { if (missing(error)) { await this.syncDirectory(base.path); return; } throw error; }
    await this.assertDirectory(inventory);
    const latest = fileIdentity(await lstat(absolute, { bigint: true }));
    if (remainder ? latest.size !== '0' || !same(nodeIdentity(await lstat(absolute, { bigint: true })), nodeIdentityFromRow(row))
      : !same(latest, row.identity)) refuse('jsonl/resource-changed', 'The exact resource changed before erasure.');
    if (process.platform === 'win32') {
      // Node cannot fsync a Windows directory. Clear and sync the exact exclusive
      // file before removing its name, so an unlink rollback cannot restore logs.
      // Only a saved maintenance operation may resume an interrupted empty file.
      const handle = await this.openFile(absolute, 'write');
      try {
        const opened = fileIdentity(await handle.stat({ bigint: true }));
        if (remainder ? opened.size !== '0' || !same(nodeIdentity(await handle.stat({ bigint: true })), nodeIdentityFromRow(row))
          : !same(opened, row.identity)) refuse('jsonl/resource-changed', 'The opened erasure object differs from the frozen file.');
        await handle.truncate(0);
        await handle.sync();
      } finally { await handle.close(); }
      const cleared = await lstat(absolute, { bigint: true });
      if (!cleared.isFile() || cleared.nlink !== 1n || cleared.size !== 0n
        || !same(nodeIdentity(cleared), nodeIdentityFromRow(row))) refuse('jsonl/resource-changed', 'The cleared erasure object changed before unlink.');
    }
    await unlink(absolute);
    await this.syncDirectory(base.path);
  }

  private validate(input: NativeJsonlInventory): NativeJsonlInventory {
    const value = nativeJsonlInventorySchema.parse(input);
    if (value.root !== this.root || value.compression !== this.compression || !same(value.rootIdentity, this.rootIdentity)
      || value.sessionId !== value.header.id || value.directory !== join(project(value.header.cwd), segment(value.sessionId))
      || value.files.some(row => row.resourceId.includes(sep) || row.resourceId.includes('/') || row.resourceId.includes('\\')
        || row.resourceId === 'session.lock' || !same(row.header, value.header))) refuse('jsonl/binding-invalid', 'The inventory is not bound to this adapter and exact directory.');
    const windowsLock = 'kind' in value.lock;
    if ((process.platform === 'win32') !== windowsLock
      || ('kind' in value.lock && value.lock.name !== windowsSemaphoreName(join(this.root, value.directory, 'session.lock'), 'session'))) {
      refuse('jsonl/binding-invalid', 'The inventory kernel lease belongs to another platform or namespace.');
    }
    if (new Set(value.files.map(row => row.resourceId)).size !== value.files.length || value.revision !== sha(JSON.stringify(value.files))) refuse('jsonl/binding-invalid', 'The frozen resource inventory digest is invalid.');
    for (const row of value.files) {
      const classified = classify(row.resourceId);
      if (classified.kind !== row.kind || classified.version !== row.formatVersion || classified.compression !== row.compression
        || row.revision !== sha(JSON.stringify({ identity: row.identity, digest: row.digest, header: row.header }))) refuse('jsonl/binding-invalid', 'Frozen resource classification or digest changed.');
    }
    return value;
  }

  private async directory(directory: string, sessionId: string, header: HeaderIdentity) {
    const internals = this.provider as unknown as { root: string; compression: Encoding };
    if (await realpath(internals.root) !== this.root || internals.compression !== this.compression
      || (process.platform === 'win32' && resolve(internals.root).toLowerCase() !== this.root.toLowerCase())
      || resolve(this.provider.config.root) !== internals.root || (this.provider.config.compression ?? 'zstd') !== this.compression) refuse('jsonl/provider-changed', 'The provider root or encoding changed.');
    const root = await lstat(this.root, { bigint: true });
    if (!root.isDirectory() || !same(nodeIdentity(root), this.rootIdentity)) refuse('jsonl/root-changed', 'The configured root identity changed.');
    if (directory !== join(project(header.cwd), segment(sessionId))) refuse('jsonl/path-invalid', 'Directory does not match the stored identity.');
    const matches: string[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      const projectPath = join(this.root, entry.name);
      if ([`${segment(sessionId)}.jsonl`, `${segment(sessionId)}.jsonl.zstd`].includes(entry.name)) refuse('jsonl/legacy-layout', 'Root-level flat session artifacts are not admitted.');
      if (entry.isSymbolicLink()) refuse('jsonl/unsafe-directory', 'Symlink project directories cannot certify a unique target.');
      if (!entry.isDirectory()) continue;
      for (const suffix of ['.jsonl', '.jsonl.zstd']) {
        try { await lstat(join(projectPath, segment(sessionId) + suffix)); refuse('jsonl/legacy-layout', 'Flat session artifacts are not admitted.'); }
        catch (error) { if (!missing(error)) throw error; }
      }
      const candidate = join(projectPath, segment(sessionId));
      try {
        const stat = await lstat(candidate, { bigint: true });
        if (!stat.isDirectory()) refuse('jsonl/unsafe-directory', 'Session directories must be direct regular directories.');
        matches.push(candidate);
      } catch (error) { if (!missing(error)) throw error; }
    }
    const path = join(this.root, directory);
    if (matches.length !== 1 || matches[0] !== path) refuse('jsonl/identity-ambiguous', 'The session directory is missing, misplaced, or duplicated across projects.');
    const actual = await realpath(path);
    const rel = relative(this.root, actual);
    if (actual !== path || rel !== directory || rel.startsWith(`..${sep}`) || isAbsolute(rel)) refuse('jsonl/unsafe-directory', 'The session directory leaves the configured root.');
    return { path, identity: nodeIdentity(await lstat(path, { bigint: true })) };
  }
  private async assertDirectory(inventory: NativeJsonlInventory) {
    const base = await this.directory(inventory.directory, inventory.sessionId, inventory.header);
    if (!same(base.identity, inventory.directoryIdentity)) refuse('jsonl/directory-changed', 'The bound directory incarnation changed.');
    return base;
  }
  private async lockIdentity(directory: string): Promise<z.infer<typeof nativeLockSchema>> {
    if (process.platform === 'win32') return { kind: 'win32-semaphore', name: windowsSemaphoreName(join(directory, 'session.lock'), 'session') };
    return lockIdentity(await lstat(join(directory, 'session.lock'), { bigint: true }));
  }
  private async isWindowsErasureRemainder(inventory: NativeJsonlInventory, row: NativeJsonlFileRow): Promise<boolean> {
    const lease = this.leases.get(inventory.directory);
    if (process.platform !== 'win32' || !lease?.recovering || lease.stamp !== leaseStamp(inventory)) return false;
    try {
      const handle = await this.openFile(join(this.root, inventory.directory, row.resourceId), 'read');
      try {
        const stat = await handle.stat({ bigint: true });
        return stat.size === 0n && same(nodeIdentity(stat), nodeIdentityFromRow(row));
      } finally { await handle.close(); }
    } catch (error) { if (missing(error)) return false; throw error; }
  }
  private async rows(directory: string, header: HeaderIdentity, frozen?: NativeJsonlInventory): Promise<NativeJsonlFileRow[]> {
    const names = (await readdir(directory)).sort();
    if (names.length > 4097) refuse('jsonl/scope-too-large', 'Session scope exceeds the bounded inventory.');
    const posix = process.platform !== 'win32';
    if (posix && !names.includes('session.lock')) refuse('jsonl/lock-missing', 'The existing stable writer lock is required.');
    const rows: NativeJsonlFileRow[] = [];
    for (const name of names) {
      if (posix && name === 'session.lock') continue;
      const original = frozen?.files.find(row => row.resourceId === name);
      if (frozen && original && await this.isWindowsErasureRemainder(frozen, original)) rows.push(original);
      else rows.push(await this.readRow(directory, name, header));
    }
    if (!same(names, (await readdir(directory)).sort())) refuse('jsonl/scope-changed', 'The directory changed while enumerating resources.');
    return rows;
  }
  private async readRow(directory: string, name: string, expected: HeaderIdentity): Promise<NativeJsonlFileRow> {
    const classified = classify(name);
    if (classified.compression !== this.compression) refuse('jsonl/encoding-mismatch', 'Mixed raw and Zstandard session generations are not admitted.');
    const path = join(directory, name);
    const before = fileIdentity(await lstat(path, { bigint: true }));
    const fd = await this.openFile(path, 'read');
    try {
      if (!same(before, fileIdentity(await fd.stat({ bigint: true })))) refuse('jsonl/resource-changed', 'Resource was replaced before reading.');
      const digest = createHash('sha256'); const chunks: Buffer[] = []; let headerBytes = 0;
      const buffer = Buffer.alloc(64 * 1024); let total = 0n;
      for (;;) {
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += BigInt(bytesRead); digest.update(buffer.subarray(0, bytesRead));
        if (headerBytes < HEADER_LIMIT) { const chunk = Buffer.from(buffer.subarray(0, Math.min(bytesRead, HEADER_LIMIT - headerBytes))); chunks.push(chunk); headerBytes += chunk.length; }
      }
      if (String(total) !== before.size || !same(before, fileIdentity(await fd.stat({ bigint: true })))
        || !same(before, fileIdentity(await lstat(path, { bigint: true })))) refuse('jsonl/resource-changed', 'The resource changed while hashing its exact bytes.');
      const header = decodeHeader(Buffer.concat(chunks), classified.compression, classified.version);
      if (!same(header, expected)) refuse('jsonl/identity-changed', 'A physical generation or staging header belongs to another lifecycle.');
      const value = { resourceId: name, kind: classified.kind, formatVersion: classified.version, compression: classified.compression,
        identity: before, digest: digest.digest('hex'), header };
      return fileRowSchema.parse({ ...value, revision: sha(JSON.stringify({ identity: value.identity, digest: value.digest, header })) });
    } finally { await fd.close(); }
  }
  private async openFile(path: string, access: 'read' | 'write'): Promise<FileHandle> {
    try { return await openRegularFile(path, access); }
    catch (error) {
      if (error instanceof RegularFileRefusal) refuse(error.code === 'platform/unsafe-file' ? 'jsonl/unsafe-file'
        : error.code === 'platform/identity-unavailable' ? 'jsonl/identity-unavailable' : 'jsonl/resource-changed', error.message);
      throw error;
    }
  }
  private async syncDirectory(directory: string) { await syncDirectory(directory); }
}
