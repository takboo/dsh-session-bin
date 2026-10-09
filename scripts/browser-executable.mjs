import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

function candidate(path, browser, source) {
  return path ? { path, browser, source } : null;
}

/** Pure platform mapping. Discovery performs filesystem access separately. */
export function browserExecutableCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const override = candidate(env.DSH_GUI_BROWSER_EXECUTABLE, 'configured', 'DSH_GUI_BROWSER_EXECUTABLE');
  let installed = [];
  if (platform === 'darwin') {
    installed = [
      candidate('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome', 'system'),
      candidate(path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'), 'chrome', 'user'),
      candidate('/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium', 'system'),
      candidate(path.join(home, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), 'chromium', 'user'),
      candidate('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge', 'fallback'),
      candidate(path.join(home, 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'), 'edge', 'fallback-user'),
    ];
  } else if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    installed = [
      ...roots.map(root => candidate(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'chrome', 'program-files')),
      candidate(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'chrome', 'local-app-data'),
      ...roots.map(root => candidate(path.join(root, 'Chromium', 'Application', 'chrome.exe'), 'chromium', 'program-files')),
      candidate(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'), 'chromium', 'local-app-data'),
      ...roots.map(root => candidate(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'edge', 'fallback-program-files')),
      candidate(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'edge', 'fallback-local-app-data'),
    ];
  } else if (platform === 'linux') {
    installed = [
      candidate('/usr/bin/google-chrome-stable', 'chrome', 'system'),
      candidate('/usr/bin/google-chrome', 'chrome', 'system'),
      candidate('/usr/bin/chromium', 'chromium', 'system'),
      candidate('/usr/bin/chromium-browser', 'chromium', 'system'),
      candidate('/snap/bin/chromium', 'chromium', 'snap'),
      candidate('/usr/bin/microsoft-edge-stable', 'edge', 'fallback'),
      candidate('/usr/bin/microsoft-edge', 'edge', 'fallback'),
    ];
  } else {
    throw new Error(`GUI browser discovery does not support platform ${JSON.stringify(platform)}.`);
  }
  const seen = new Set();
  return [override, ...installed].filter(item => item && !seen.has(item.path) && seen.add(item.path));
}

export async function selectReadableBrowser(candidates, check = path => access(path, constants.X_OK)) {
  const failures = [];
  for (const item of candidates) {
    try {
      await check(item.path);
      return item;
    } catch (error) {
      failures.push({ path: item.path, code: error?.code ?? 'UNKNOWN' });
    }
  }
  const error = new Error(`No installed Chrome, Chromium, or Edge executable was readable. Checked:\n${failures.map(row => `- ${row.path} (${row.code})`).join('\n')}`);
  error.code = 'DSH_GUI_BROWSER_NOT_FOUND';
  error.failures = failures;
  throw error;
}

export async function discoverBrowserExecutable(options = {}) {
  const candidates = browserExecutableCandidates(options);
  if (options.fallbackExecutable) candidates.push({ path: options.fallbackExecutable, browser: 'chromium', source: 'configured-tool-cache' });
  return selectReadableBrowser(candidates);
}
