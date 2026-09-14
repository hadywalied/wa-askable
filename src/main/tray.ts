import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron';
import { TRAY_ICONS, type TrayState } from './tray-icons.js';
import { getSettings, updateSettings, applyAutostart } from './settings.js';
import type { WhatsAppStatus } from '../shared/ipc.js';

/**
 * The tray is not decoration — it is the only place a user finds out that
 * capture has stopped.
 *
 * While linked, messages arrive by push and are written as they come. If the
 * phone unlinks the device, the socket closes and every message from that
 * moment on is lost permanently; there is no backfill. A window the user closed
 * three days ago cannot tell them that. The icon can.
 */

// Held at module scope: a Tray that gets garbage collected disappears from the
// system tray, which Electron's own docs call out.
let tray: Tray | null = null;
let lastState: TrayState = 'idle';
let lastDetail = 'not connected';

const STATE_MAP: Record<string, [TrayState, string]> = {
  open: ['open', 'connected — capturing'],
  qr: ['connecting', 'waiting for QR scan'],
  connecting: ['connecting', 'connecting…'],
  closed: ['connecting', 'reconnecting…'],
  logged_out: ['error', 'UNLINKED — not capturing'],
  idle: ['idle', 'not connected'],
};

export interface TrayHooks {
  showWindow: () => void;
  quit: () => void;
}

export function createTray(hooks: TrayHooks): void {
  if (tray) return;
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICONS.idle));
  tray.setToolTip('wa-askable — not connected');
  tray.on('click', hooks.showWindow);
  render(hooks);
}

export function updateTray(status: WhatsAppStatus, hooks: TrayHooks): void {
  const [state, detail] = STATE_MAP[status.state] ?? (['idle', status.state] as [TrayState, string]);
  const captured = status.capturedThisSession
    ? ` · ${status.capturedThisSession} captured this session`
    : '';
  lastState = state;
  lastDetail = detail + captured;
  if (!tray) return;
  tray.setImage(nativeImage.createFromDataURL(TRAY_ICONS[state]));
  tray.setToolTip(`wa-askable — ${lastDetail}`);
  render(hooks);
}

function render(hooks: TrayHooks): void {
  if (!tray) return;
  const settings = getSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: lastDetail, enabled: false },
      { type: 'separator' },
      { label: 'Open wa-askable', click: hooks.showWindow },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: settings.openAtLogin,
        click: (item) => {
          const ok = applyAutostart(item.checked);
          updateSettings({ openAtLogin: ok });
          // Report what actually happened, not what was requested. Believing
          // autostart is on when it silently failed means believing the archive
          // is capturing when it is not.
          item.checked = ok;
          render(hooks);
        },
      },
      { type: 'separator' },
      { label: 'Quit (stops capturing)', click: hooks.quit },
    ]),
  );
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

export const trayState = (): TrayState => lastState;
export const hasTray = (): boolean => tray !== null && !tray.isDestroyed();
