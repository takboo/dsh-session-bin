import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { installHistoryDelayInBrowser } from '../scripts/gui-history-delay.mjs';

const options = { sessionId: 'fixture-history', delayMs: 1500, counterKey: 'fixture-count' };
const open = (id = 'history', sessionId = options.sessionId) => JSON.stringify({ type: 'open', streamId: id,
  endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } });
const event = id => JSON.stringify({ type: 'open', streamId: id, endpoint: '$events', payload: {} });
function fixture(storage = new Map()) {
  const timers = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor(url = 'ws://127.0.0.1:1234/api/remote.mux') { this.url = url; }
    send(data) {
      if (this.readyState === 0) throw new Error('WebSocket is connecting');
      if (this.readyState === 1) this.sent.push(data);
    }
  }
  const sandbox = { WebSocket: Socket, URL, location: new URL('http://127.0.0.1:1234/'),
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); } };
  const install = () => runInNewContext(`(${installHistoryDelayInBrowser.toString()})(${JSON.stringify(options)})`, sandbox);
  install();
  return { Socket, storage, timers, install, async elapse() {
    for (const timer of timers.splice(0)) { assert.equal(timer.ms, 1500); timer.callback(); }
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test('Gateway readiness and unrelated sessions use the native send immediately', () => {
  const { Socket, timers } = fixture(); const socket = new Socket();
  for (const frame of [event('ready'), open('other', 'unrelated')]) socket.send(frame);
  assert.deepEqual(socket.sent, [event('ready'), open('other', 'unrelated')]);
  assert.equal(timers.length, 0);
});
test('only the fixed history stream waits while other streams continue', async () => {
  const f = fixture(); const socket = new f.Socket();
  socket.send(open()); socket.send(event('ready'));
  assert.deepEqual(socket.sent, [event('ready')]);
  assert.equal(f.storage.get(options.counterKey), '1');
  await f.elapse(); assert.deepEqual(socket.sent, [event('ready'), open()]);
});
test('queued history items and cancellation retain their per-stream order', async () => {
  const f = fixture(); const socket = new f.Socket();
  const frames = [open(), JSON.stringify({ type: 'item', streamId: 'history', value: 1 }),
    JSON.stringify({ type: 'cancel', streamId: 'history' })];
  for (const frame of frames) socket.send(frame);
  assert.deepEqual(socket.sent, []);
  await f.elapse(); assert.deepEqual(socket.sent, frames);
});
test('equal stream ids on independent sockets never share a delay', async () => {
  const f = fixture(); const a = new f.Socket(); const b = new f.Socket();
  a.send(open('same')); b.send(event('same'));
  assert.deepEqual(b.sent, [event('same')]); assert.deepEqual(a.sent, []);
  await f.elapse(); assert.deepEqual(a.sent, [open('same')]);
});
test('other origins, endpoints, binary data and invalid JSON keep native behavior', () => {
  const f = fixture(); const socket = new f.Socket(); const binary = new Uint8Array([1, 2]);
  socket.send(binary); socket.send('not JSON');
  assert.deepEqual(socket.sent, [binary, 'not JSON']);
  for (const url of ['ws://elsewhere:1234/api/remote.mux', 'ws://127.0.0.1:1234/other']) {
    const other = new f.Socket(url); other.send(open()); assert.deepEqual(other.sent, [open()]);
  }
  socket.readyState = 0; assert.throws(() => socket.send(open()), /connecting/);
  assert.equal(f.timers.length, 0);
});
test('closing a socket discards delayed work without opening an orphan stream', async () => {
  const f = fixture(); const socket = new f.Socket(); socket.send(open()); socket.readyState = 3;
  await f.elapse(); assert.deepEqual(socket.sent, []);
});
test('the delay count survives a fresh document while transport state does not', async () => {
  const storage = new Map();
  for (let i = 0; i < 2; i++) { const f = fixture(storage); new f.Socket().send(open()); await f.elapse(); }
  assert.equal(storage.get(options.counterKey), '2');
});
test('installing twice cannot double-delay a history request', async () => {
  const f = fixture(); f.install(); const socket = new f.Socket(); socket.send(open());
  assert.equal(f.timers.length, 1); assert.equal(f.storage.get(options.counterKey), '1');
  await f.elapse(); assert.deepEqual(socket.sent, [open()]);
});
