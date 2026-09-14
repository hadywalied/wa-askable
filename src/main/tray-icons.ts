/**
 * Tray status icons, inlined as data URLs.
 *
 * Generated 16x16 PNGs rather than shipped asset files on purpose: an asset on
 * disk has to survive asar packing, asarUnpack rules and a path lookup that
 * differs between dev and a packaged build. A data URL has none of that and
 * costs ~200 bytes each.
 *
 * Red is load-bearing. If the phone unlinks the device, capture stops silently
 * and every message from then on is lost forever — the tray icon is the only
 * place a user will notice without opening the window. See PLAN.md §4 Phase 2.
 */
export type TrayState = 'idle' | 'connecting' | 'open' | 'error';

export const TRAY_ICONS: Record<TrayState, string> = {
  idle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZ0lEQVR42mPo6upioATjknAE4h4g3gTFPVAxggbIQDX8x4E3QdVgNQAkcQuPZhi+hWwIsgGbiNCM7BIUAxxJ0AzDjsgG9JBhQA+yAZvIMGATVQ2g2AsUByLF0UiVhERxUqZKZiIZAwBL5Ct3Mw79pAAAAABJRU5ErkJggg==',
  connecting: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZ0lEQVR42mO42cXAQAnGJeEIxD1AvAmKe6BiBA2QgWr4jwNvgqrBagBI4hYezTB8C9kQZAM2EaEZ2SUoBjiSoBmGHZEN6CHDgB5kAzaRYcAmqhpAsRcoDkSKo5EqCYnipEyVzEQyBgAoa/BoUh7xMgAAAABJRU5ErkJggg==',
  open: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZ0lEQVR42mOQnxvKQAnGJeEIxD1AvAmKe6BiBA2QgWr4jwNvgqrBagBI4hYezTB8C9kQZAM2EaEZ2SUoBjiSoBmGHZEN6CHDgB5kAzaRYcAmqhpAsRcoDkSKo5EqCYnipEyVzEQyBgBWk55oKxqwXAAAAABJRU5ErkJggg==',
  error: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZ0lEQVR42mO45urKQAnGJeEIxD1AvAmKe6BiBA2QgWr4jwNvgqrBagBI4hYezTB8C9kQZAM2EaEZ2SUoBjiSoBmGHZEN6CHDgB5kAzaRYcAmqhpAsRcoDkSKo5EqCYnipEyVzEQyBgDGgu1oTUWQtAAAAABJRU5ErkJggg==',
};
