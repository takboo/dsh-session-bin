import { pathToFileURL } from 'node:url';

export const shutdownMessage = Object.freeze({ type: 'dsh-gui-host-shutdown', signal: 'SIGTERM' });

export function isShutdownMessage(message) {
  return message !== null && typeof message === 'object' && !Array.isArray(message)
    && Object.keys(message).length === 2
    && message.type === shutdownMessage.type && message.signal === shutdownMessage.signal;
}

async function main() {
  const [cli, ...args] = process.argv.slice(2);
  if (!cli) throw new Error('The GUI Host worker requires the public dsh CLI path.');
  process.argv = [process.execPath, cli, ...args];
  let shuttingDown = false;
  process.on('message', message => {
    if (!isShutdownMessage(message) || shuttingDown) return;
    shuttingDown = true;
    const listeners = process.listenerCount('SIGTERM');
    if (listeners < 1) {
      process.send?.({ type: 'dsh-gui-host-shutdown-error', reason: 'sdk-sigterm-handler-missing' });
      process.exitCode = 1;
      process.disconnect?.();
      return;
    }
    process.send?.({ type: 'dsh-gui-host-shutdown-delivered', listeners });
    process.emit('SIGTERM');
    process.disconnect?.();
  });
  const module = await import(pathToFileURL(cli).href);
  if (typeof module.runCli !== 'function') throw new Error('The installed public dsh CLI does not export runCli().');
  await module.runCli();
  process.send?.({ type: 'dsh-gui-host-cli-returned', sigtermListeners: process.listenerCount('SIGTERM') });
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    process.send?.({ type: 'dsh-gui-host-worker-error', error: String(error?.stack ?? error) });
    console.error(error);
    process.exitCode = 1;
    process.disconnect?.();
  }
}
