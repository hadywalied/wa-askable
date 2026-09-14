import { app, BrowserWindow, net, powerMonitor, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  currentStatus,
  onStatusChange,
  reconnectNow,
  registerIpc,
  resumeLastWorkspace,
  shutdownRuntime,
} from './ipc.js';
import { createTray, destroyTray, hasTray, trayState, updateTray, type TrayHooks } from './tray.js';
import { applyAutostart, getSettings } from './settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Phase 2: tray-resident.
 *
 * The premise of the whole app is that messages arrive by push while linked and
 * there is no backfill — whatever happens while we are not running is lost
 * permanently. So the app must keep running with no window, start at login, and
 * say loudly when it has stopped capturing. Closing the window hides it.
 */

// Two processes on one SQLite WAL and one auth/ directory is corruption plus a
// possible WhatsApp unlink.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
/** Autostart passes --hidden so login does not throw a window in your face. */
const startHidden = process.argv.includes('--hidden');

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const hooks: TrayHooks = {
  showWindow,
  quit: () => {
    isQuitting = true;
    app.quit();
  },
};

function createWindow(show = true): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    title: 'wa-askable',
    webPreferences: {
      preload: path.join(HERE, '../preload/index.cjs'),
      // The renderer holds other people's private messages. It gets no Node,
      // an isolated context, and a sandbox. The only surface it sees is the
      // contextBridge in preload/index.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => {
    if (show) win.show();
  });

  // Closing hides. Quitting is a deliberate act from the tray menu, because
  // quitting means the archive stops recording and nothing fills the gap later.
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Renderer errors are otherwise invisible from the terminal, and the renderer
  // is where most of this app's behaviour lives. Positional args were deprecated
  // in Electron 35 in favour of this details object.
  win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (level === 'error' || level === 'warning') {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
    }
  });

  // Headless self-test: drives the real contextBridge from inside the renderer
  // and exits non-zero if anything is unreachable. Used by `bun run smoke` and,
  // later, CI — an IPC channel that silently stops resolving is otherwise only
  // noticed by a human clicking around.
  //
  // Hooked to did-finish-load, NOT ready-to-show: those are independent Chromium
  // callbacks with no guaranteed ordering, and ready-to-show fires on first
  // non-empty paint, which races the page's own async boot.
  if (process.env.WA_SMOKE === 'connect') {
    win.webContents.once('did-finish-load', () => void runConnectTest(win));
  } else if (process.env.WA_SMOKE === 'lifecycle') {
    win.webContents.once('did-finish-load', () => void runLifecycleTest(win));
  } else if (process.env.WA_SMOKE) {
    win.webContents.once('did-finish-load', () => void runSmokeTest(win));
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(HERE, '../renderer/index.html'));
  }
}

/**
 * net.online is a property, not an event — Chromium exposes no network-change
 * signal to the main process. So poll it, but only while we are not connected,
 * and only to catch the false -> true edge. Without this, coming back from a
 * dead network waits out the backoff, up to five minutes of lost messages.
 */
function watchNetwork(): void {
  let wasOnline = net.online;
  setInterval(() => {
    const online = net.online;
    if (online && !wasOnline) reconnectNow();
    wasOnline = online;
  }, 15_000).unref();
}

/**
 * Phase 2's actual contract: closing the window must NOT quit the app, because
 * quitting stops capture and nothing backfills the gap. Asserted here rather
 * than left to a human remembering to click the X.
 */
/**
 * Drives an actual WhatsApp connect against whatever build this is running in,
 * packaged or not, and reports where it got to. Everything before this verified
 * the app with an empty database; nothing ever exercised Baileys.
 */
async function runConnectTest(win: BrowserWindow): Promise<void> {
  const script = `(async () => {
    const out = {};
    await window.wa.openWorkspace('');
    try {
      out.connectReturned = JSON.stringify(await window.wa.connect());
    } catch (e) { out.connectThrew = String(e && e.message || e); }
    const seen = [];
    window.wa.onStatus((s) => seen.push(s.state + (s.qrDataUrl ? '(QR!)' : '') + (s.lastError ? ' err=' + String(s.lastError).slice(0,120) : '')));
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = (await window.wa.getStatus()).connection;
      if (st.qrDataUrl || st.state === 'open' || st.state === 'logged_out') break;
    }
    const fin = (await window.wa.getStatus()).connection;
    out.finalState = fin.state;
    out.gotQR = Boolean(fin.qrDataUrl);
    out.lastError = fin.lastError ? String(fin.lastError).slice(0, 200) : null;
    out.transitions = seen.join(' -> ');
    return JSON.stringify(out);
  })()`;
  try {
    console.log('[connect] RESULT', await win.webContents.executeJavaScript(script));
  } catch (err) {
    console.error('[connect] HARNESS FAILED', err);
  }
  isQuitting = true;
  app.exit(0);
}

async function runLifecycleTest(win: BrowserWindow): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const out: Record<string, unknown> = {};
  try {
    out.trayCreated = hasTray();
    out.trayState = trayState();

    win.close();
    await wait(600);

    out.appStillRunning = !app.isReady() ? false : true;
    out.windowDestroyed = win.isDestroyed();
    out.windowVisible = win.isDestroyed() ? null : win.isVisible();
    out.windowCount = BrowserWindow.getAllWindows().length;

    // Reopening from the tray must bring the same window back.
    showWindow();
    await wait(400);
    out.reopened = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isVisible();

    out.settings = getSettings();

    const ok =
      out.trayCreated === true &&
      out.windowDestroyed === false &&
      out.windowVisible === false &&
      out.reopened === true;
    console.log(ok ? '[lifecycle] OK' : '[lifecycle] FAILED', JSON.stringify(out));
    if (!ok) {
      isQuitting = true;
      app.exit(1);
      return;
    }
    // Exercise the real quit path rather than app.exit(): before-quit has to
    // close the Baileys socket and let SQLite checkpoint its WAL, and a hang
    // there would strand the process in the tray forever.
    const watchdog = setTimeout(() => {
      console.error('[lifecycle] FAILED — graceful quit hung');
      app.exit(1);
    }, 8_000);
    app.once('quit', () => clearTimeout(watchdog));
    hooks.quit();
  } catch (err) {
    console.error('[lifecycle] FAILED', err, JSON.stringify(out));
    isQuitting = true;
    app.exit(1);
  }
}

async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const testWorkspace = path.join(app.getPath('temp'), `wa-smoke-${Date.now()}`);
  const script = `(async () => {
    const WA_TEST_WORKSPACE = ${JSON.stringify(testWorkspace)};
    const out = { bridge: typeof window.wa };
    const $ = (id) => document.getElementById(id);

    // Wait for the page's own boot rather than sampling a half-painted UI.
    for (let i = 0; i < 100; i++) {
      if (($('onboarding') && !$('onboarding').hidden) || ($('shell') && !$('shell').hidden)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    out.onboardingShown = !$('onboarding').hidden;
    // Regression guard: a CSS display rule silently defeated the hidden
    // attribute, so the overlay stayed on top and Skip looked dead.
    out.hiddenWorks = (() => {
      const ob = $('onboarding');
      const was = ob.hidden;
      ob.hidden = true;
      const ok = getComputedStyle(ob).display === 'none';
      ob.hidden = was;
      return ok;
    })();

    // --- core IPC ------------------------------------------------------
    out.session = await window.wa.getSession();
    // Never the default workspace: opening it rewrites lastWorkspace, and a
    // real user's next launch would land on an empty archive. Isolate the test.
    const opened = await window.wa.openWorkspace(WA_TEST_WORKSPACE);
    out.workspace = opened.workspace;
    out.warnings = opened.warnings.length;
    out.status = (await window.wa.getStatus()).connection.state;
    out.chats = (await window.wa.listChats()).chats.length;
    out.hits = (await window.wa.search({ query: '' })).hits.length;

    // Errors thrown in main must surface as rejections, not hang.
    out.askError = await window.wa.ask('test').then(() => 'NO ERROR', (e) => e.message.slice(0, 60));

    // The sandbox must hold: no require, no process, no raw ipcRenderer.
    out.leaks = [typeof window.require, typeof window.process, typeof window.ipcRenderer].join(',');

    // --- settings ------------------------------------------------------
    const s0 = await window.wa.getSettings();
    out.keyNeverReturned = !JSON.stringify(s0).includes('sk-ant-');
    const s1 = await window.wa.saveSettings({ apiKey: 'sk-ant-test-not-a-real-key', model: 'claude-opus-5' });
    out.afterSet = [s1.hasKey, s1.localOnly, s1.model].join('|');
    out.keyStillNotReturned = !JSON.stringify(s1).includes('sk-ant-');
    const sB = await window.wa.saveSettings({ apiKey: null, providerId: 'ollama' });
    out.presetApplied = [sB.providerId, sB.providerKind, sB.baseUrl, sB.localOnly, sB.localEndpoint].join('|');
    out.presetCount = (sB.presets || []).length;
    const sC = await window.wa.saveSettings({ providerId: 'cohere' });
    out.cohere = [sC.providerKind, sC.baseUrl].join('|');
    const s2 = await window.wa.saveSettings({ providerId: 'anthropic', apiKey: null, baseUrl: '' });
    out.afterClear = [s2.hasKey, s2.localOnly].join('|');

    // --- redesign: shell, routing, panes, conversations ----------------
    // Exercise onboarding regardless of whether this archive is fresh: the
    // steps must work, and tying the test to app state means it silently stops
    // testing anything the moment there is data.
    out.obSteps = document.querySelectorAll('.ob-step').length;
    $('onboarding').hidden = false;
    document.querySelector('[data-goto="4"]').click();
    out.obStep4Visible = !document.querySelector('.ob-step[data-step="4"]').hidden;
    out.obProviderOptions = $('obProvider').options.length;
    $('obProvider').value = 'ollama';
    $('obProvider').dispatchEvent(new Event('change'));
    out.obPresetApplied = $('obCustomFields').hidden && $('obProviderNote').textContent.length > 0;
    $('obSkipAi').click();
    out.obFinished = $('onboarding').hidden;
    out.shellVisible = !$('shell').hidden;

    document.querySelector('.nav-item[data-view="settings"]').click();
    out.settingsRouted = !document.querySelector('.view[data-view="settings"]').hidden;
    for (const pane of ['connection', 'workspace', 'indexing', 'provider', 'about']) {
      document.querySelector('#settingsNav [data-pane="' + pane + '"]').click();
      if (document.querySelector('.pane[data-pane="' + pane + '"]').hidden) {
        out.paneFailed = pane;
      }
    }
    out.panesOk = !out.paneFailed;
    out.linkStageMounted = Boolean(document.querySelector('#linkHost .link-stage'));

    const conv = await window.wa.newConversation();
    const before = (await window.wa.listConversations()).conversations.length;
    await window.wa.getConversation(conv.id);
    await window.wa.deleteConversation(conv.id);
    const after = (await window.wa.listConversations()).conversations.length;
    out.conversations = before + '->' + after;

    document.querySelector('.nav-item[data-view="chats"]').click();
    out.chatsRouted = !document.querySelector('.view[data-view="chats"]').hidden;
    document.querySelector('.nav-item[data-view="ask"]').click();
    out.askRouted = !document.querySelector('.view[data-view="ask"]').hidden;
    out.modeText = $('mode').textContent;
    return JSON.stringify(out);
  })()`;
  try {
    const raw = (await win.webContents.executeJavaScript(script)) as string;
    console.log('[smoke] OK', raw);
    app.exit(0);
  } catch (err) {
    console.error('[smoke] FAILED', err);
    app.exit(1);
  }
}

if (gotLock) {
  // A second launch (clicking the icon again, or the login item firing twice)
  // surfaces the running instance instead of starting a rival one.
  app.on('second-instance', showWindow);

  void app.whenReady().then(async () => {
    // Carried over from the old server/security.ts. The HTTP server is gone, but
    // a strict CSP still costs nothing and stops an injected string — and every
    // string in this database was written by someone else — from phoning home.
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
              "connect-src 'self'; base-uri 'none'; form-action 'none'",
          ],
        },
      });
    });

    // Probe the QR rendering path directly. It lives inside an async Baileys
  // event handler, so a failure there is an unhandled rejection that leaves the
  // UI on 'connecting' forever with nothing logged — indistinguishable from a
  // hang. Dynamic import() from inside an asar is the specific worry.
  if (process.env.WA_SMOKE) {
    try {
      const { toDataURL } = await import('qrcode');
      const url = await toDataURL('probe', { margin: 1, width: 64 });
      console.log('[qrprobe] OK', url.slice(0, 30), 'len=', url.length);
    } catch (err) {
      console.error('[qrprobe] FAILED', err);
    }
  }

  registerIpc(await loadConfig());

    createTray(hooks);
    onStatusChange((s) => updateTray(s, hooks));
    updateTray(currentStatus(), hooks);

    // Honour the stored preference on every launch: an OS update or a profile
    // move can quietly drop the login item.
    applyAutostart(getSettings().openAtLogin);

    // Wake and screen-unlock are the moments a laptop is most likely to have a
    // working network again after hours of backoff.
    powerMonitor.on('resume', reconnectNow);
    powerMonitor.on('unlock-screen', reconnectNow);
    watchNetwork();

    createWindow(!startHidden);

    // Resume capture without waiting for anyone to click anything.
    const resumed = await resumeLastWorkspace();
    if (resumed) updateTray(currentStatus(), hooks);

    app.on('activate', showWindow);
  });
}

// Closing the last window must NOT quit — that is the whole point of Phase 2.
app.on('window-all-closed', () => {
  /* intentionally empty: the tray keeps the app alive */
});

// Close the socket and let SQLite checkpoint its WAL rather than being killed
// mid-write. The flag makes the second quit (the one we issue ourselves once
// shutdown finishes) fall straight through.
let shuttingDown = false;
app.on('before-quit', (e) => {
  if (shuttingDown) return;
  shuttingDown = true;
  isQuitting = true;
  e.preventDefault();
  void shutdownRuntime().finally(() => {
    destroyTray();
    app.quit();
  });
});
