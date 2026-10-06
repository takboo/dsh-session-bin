import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'

// Compatibility experiment: scratch logs only; no user session configuration.
const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratchParent = join(projectRoot, '.local', 'compatibility')

async function scratchPath(path) {
  const parent = await realpath(scratchParent)
  const target = await realpath(path)
  const suffix = relative(parent, target)
  assert(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'Scratch path must stay under .local/compatibility')
  return target
}

async function openHost(root, compression) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  assert(ctx.sessionPersistence, 'JSONL service must activate')
  return ctx
}

async function contender(root, id, compression) {
  await scratchPath(root)
  const ctx = await openHost(root, compression)
  try {
    const writer = await ctx.sessionPersistence.open(SessionId(id), 'write')
    await writer.close()
    return { result: 'acquired' }
  } catch (error) {
    if (error instanceof SessionAlreadyOwnedError) return { result: 'refused', error: error.name }
    throw error
  } finally {
    await ctx.fiber.dispose()
  }
}

async function verifyEncoding(scratch, compression) {
  const root = join(scratch, compression)
  await mkdir(root)
  const hosts = []
  const handles = []
  try {
    const first = await openHost(root, compression)
    hosts.push(first)
    const id = SessionId(randomUUID())
    const session = first.sessions.prepare(id, { meta: { cwd: scratch } })
    const header = session.header
    assert.equal(header.version, SESSION_FORMAT_VERSION)
    const writer = await first.sessionPersistence.create(header)
    handles.push(writer)
    const events = [
      session.append('sandbox/mode', { mode: 'workspace-write' }),
      session.append('approval/policy', { policy: 'ask' }),
    ]
    await writer.append(events)
    await writer.flush()
    const snapshot = await first.sessionPersistence.stat(id)
    // The codec materializes the semantic default for an ordinary root session.
    assert.deepEqual(snapshot.header, { ...header, delegationDepth: 0 })
    assert(snapshot.sizeBytes > 0, 'Flushed log must have a materialized artifact')
    assert((await first.sessionPersistence.list()).some(snapshot => snapshot.header.id === id))
    await assert.rejects(first.sessionPersistence.open(id, 'write'), SessionAlreadyOwnedError)

    const reader = await first.sessionPersistence.open(id, 'read')
    handles.push(reader)
    assert.deepEqual((await reader.read()).events, events)
    await assert.rejects(reader.append([]), SessionReadOnlyError)

    const second = await openHost(root, compression)
    hosts.push(second)
    await assert.rejects(second.sessionPersistence.open(id, 'write'), SessionAlreadyOwnedError)
    const secondReader = await second.sessionPersistence.open(id, 'read')
    handles.push(secondReader)
    assert.deepEqual((await secondReader.read()).events, events)

    const childWhileHeld = await execFileAsync(process.execPath, [
      fileURLToPath(import.meta.url), '--writer-contender', root, id, compression,
    ], { cwd: projectRoot, timeout: 15000, maxBuffer: 1024 * 1024 })
    assert.equal(JSON.parse(childWhileHeld.stdout).result, 'refused')
    await writer.close()
    const childAfterClose = await execFileAsync(process.execPath, [
      fileURLToPath(import.meta.url), '--writer-contender', root, id, compression,
    ], { cwd: projectRoot, timeout: 15000, maxBuffer: 1024 * 1024 })
    assert.equal(JSON.parse(childAfterClose.stdout).result, 'acquired')

    const third = await openHost(root, compression)
    hosts.push(third)
    const reopened = await third.sessionPersistence.open(id, 'read')
    handles.push(reopened)
    assert.deepEqual((await reopened.read()).events, events)
    await assert.rejects(third.sessionPersistence.open(SessionId(randomUUID()), 'read'), SessionPersistenceNotFoundError)
    assert.equal(typeof third.sessionPersistence.delete, 'undefined')
    assert.equal(typeof third.sessionPersistence.purge, 'undefined')

    return {
      compression,
      sessionId: id,
      events: events.length,
      roundtrip: 'passed',
      readOnlyMutationRefusal: 'passed',
      sameInstanceWriterRefusal: 'passed',
      separateInstanceWriterRefusal: 'passed',
      separateProcessWriterRefusal: 'passed',
      writerReleaseAfterClose: 'passed',
      missingSessionRefusal: 'passed',
      nativeDeleteCapability: 'absent',
    }
  } finally {
    for (const handle of handles.reverse()) await handle.close()
    for (const ctx of hosts.reverse()) await ctx.fiber.dispose()
  }
}

export async function verifyJsonl() {
  await mkdir(scratchParent, { recursive: true })
  const scratch = await mkdtemp(join(scratchParent, 'jsonl-probe-'))
  const results = []
  for (const compression of ['none', 'zstd']) results.push(await verifyEncoding(scratch, compression))
  const report = {
    dshVersion: '0.2.0-rc.2',
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    scratch: relative(projectRoot, scratch),
    results,
    limitations: [
      'Public JSONL provider and handle ownership only; no agent loop or full GUI.',
      'No permanent deletion, historical migrations, crash-tail injection, or linked-resource cleanup tested.',
      'Scratch logs are retained for inspection.',
    ],
  }
  await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  return report
}

if (process.argv[2] === '--writer-contender') {
  console.log(JSON.stringify(await contender(process.argv[3], process.argv[4], process.argv[5])))
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyJsonl()
}
