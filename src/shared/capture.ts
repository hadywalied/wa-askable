/**
 * What to capture.
 *
 * Two separate axes, because they cost different things. Sources decide how much
 * noise enters the archive — a few busy groups can drown every real
 * conversation. Media decides how much disk and bandwidth it costs, and whether
 * a download happens at all.
 */

export type ChatSource = 'direct' | 'group' | 'community' | 'broadcast';
export type MediaKind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface CaptureFilter {
  sources: Record<ChatSource, boolean>;
  media: Record<MediaKind, boolean>;
}

export const DEFAULT_CAPTURE: CaptureFilter = {
  // Everything except broadcasts, which are almost entirely automated.
  sources: { direct: true, group: true, community: true, broadcast: false },
  // Text always; stickers off because they carry no searchable content and
  // still cost a download and a row.
  media: { text: true, image: true, video: true, audio: true, document: true, sticker: false },
};

export const SOURCE_LABELS: Record<ChatSource, string> = {
  direct: 'Direct chats',
  group: 'Groups',
  community: 'Communities and channels',
  broadcast: 'Broadcast lists',
};

export const MEDIA_LABELS: Record<MediaKind, string> = {
  text: 'Text messages',
  image: 'Images',
  video: 'Videos',
  audio: 'Voice notes and audio',
  document: 'Documents',
  sticker: 'Stickers',
};

/** Classify a chat from its JID suffix. */
export function sourceOf(jid: string): ChatSource {
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@newsletter')) return 'community';
  if (jid.endsWith('@broadcast')) return 'broadcast';
  return 'direct';
}

/**
 * Map a stored message kind onto a media toggle. Kinds with no toggle of their
 * own (link, location, contact, other) ride with text — they are all small and
 * text-shaped, and hiding them behind "Text messages" is what a user expects.
 */
export function mediaOf(kind: string): MediaKind {
  switch (kind) {
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker':
      return kind;
    default:
      return 'text';
  }
}

export function shouldCapture(filter: CaptureFilter, jid: string, kind: string): boolean {
  return filter.sources[sourceOf(jid)] !== false && filter.media[mediaOf(kind)] !== false;
}


/**
 * Apply one checkbox to a filter, refusing changes that would archive nothing.
 *
 * Extracted so it can be tested without a DOM. An empty group silently stops
 * all capture and is indistinguishable from the app being broken, which is
 * exactly the confusion this project has already produced once.
 */
export function toggleCapture(
  filter: CaptureFilter,
  group: 'sources' | 'media',
  key: string,
  on: boolean,
): { filter: CaptureFilter; ok: boolean; reason?: string } {
  const next: CaptureFilter = {
    sources: { ...filter.sources },
    media: { ...filter.media },
  };
  (next[group] as Record<string, boolean>)[key] = on;

  if (!Object.values(next.sources).some(Boolean)) {
    return { filter, ok: false, reason: 'Keep at least one kind of conversation, or nothing is archived at all.' };
  }
  if (!Object.values(next.media).some(Boolean)) {
    return { filter, ok: false, reason: 'Keep at least one message type, or nothing is archived at all.' };
  }
  return { filter: next, ok: true };
}
