const counterKey = 'dsh-session-bin:fixture-history-delays';

// Serialized into each real browser document. Keep the native WebSocket:
// only the selected fixture stream waits, entirely inside the browser.
export function installHistoryDelayInBrowser({ sessionId, delayMs, counterKey }) {
  const Socket = globalThis.WebSocket;
  const marker = Symbol.for('dsh-session-bin:fixture-history-delay');
  if (Object.hasOwn(Socket.prototype, marker)) return;
  Object.defineProperty(Socket.prototype, marker, { value: true });
  const send = Socket.prototype.send;
  const queues = new WeakMap();
  Socket.prototype.send = function sendWithHistoryDelay(data) {
    if (this.readyState !== Socket.OPEN || typeof data !== 'string') return send.call(this, data);
    const url = new URL(this.url);
    if (url.host !== location.host || url.pathname !== '/api/remote.mux') return send.call(this, data);
    let frame;
    try { frame = JSON.parse(data); } catch { return send.call(this, data); }
    if (!frame || typeof frame !== 'object') return send.call(this, data);
    const address = frame.payload?.args?.request?.address;
    let pending = queues.get(this);
    if (frame.type === 'open' && frame.endpoint === 'session/follow'
      && address?.kind === 'session' && address.sessionId === sessionId) {
      const count = Number(sessionStorage.getItem(counterKey) ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid fixture history-delay counter');
      sessionStorage.setItem(counterKey, String(count + 1));
      if (!pending) { pending = new Map(); queues.set(this, pending); }
      pending.set(frame.streamId, new Promise(resolve => setTimeout(resolve, delayMs)));
    }
    const previous = pending?.get(frame.streamId);
    if (!previous) return send.call(this, data);
    const socket = this;
    pending.set(frame.streamId, previous.then(() => {
      if (socket.readyState === Socket.OPEN) send.call(socket, data);
    }));
  };
}

export async function delayNativeHistory(page, { sessionId, delayMs = 1500 }) {
  await page.addInitScript(installHistoryDelayInBrowser, { sessionId, delayMs, counterKey });
  return () => page.evaluate(key => Number(sessionStorage.getItem(key) ?? 0), counterKey);
}
