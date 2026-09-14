import { rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DB } from './db.js';

/**
 * Workspace maintenance.
 *
 * Every operation here destroys something, so each one is narrow and says
 * exactly what it removed. The dangerous shape would be a single "clean up"
 * button whose blast radius nobody can predict.
 */

export interface WorkspaceUsage {
  dbBytes: number;
  mediaBytes: number;
  mediaFiles: number;
  messages: number;
  chats: number;
  contacts: number;
  conversations: number;
  pending: number;
  failed: number;
  oldest: number | null;
  newest: number | null;
}

async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        try {
          bytes += (await stat(full)).size;
          files++;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

export async function workspaceUsage(
  db: DB,
  dbPath: string,
  mediaDir: string,
): Promise<WorkspaceUsage> {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const range = db.prepare('SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM messages').get() as {
    oldest: number | null;
    newest: number | null;
  };
  const media = await dirSize(mediaDir);
  let dbBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      dbBytes += (await stat(dbPath + suffix)).size;
    } catch {
      /* not present */
    }
  }
  return {
    dbBytes,
    mediaBytes: media.bytes,
    mediaFiles: media.files,
    messages: one('SELECT COUNT(*) AS n FROM messages'),
    chats: one('SELECT COUNT(*) AS n FROM chats'),
    contacts: one('SELECT COUNT(*) AS n FROM contacts'),
    conversations: one('SELECT COUNT(*) AS n FROM conversations'),
    pending: one("SELECT COUNT(*) AS n FROM messages WHERE enrich_state = 'pending'"),
    failed: one("SELECT COUNT(*) AS n FROM messages WHERE enrich_state = 'failed'"),
    oldest: range.oldest,
    newest: range.newest,
  };
}

/**
 * Delete downloaded media but keep every message.
 *
 * Usually the right first move when space is short: the files are the bulk,
 * the text is the value, and the messages stay searchable and readable.
 */
export async function clearMedia(db: DB, mediaDir: string): Promise<{ files: number }> {
  const { files } = await dirSize(mediaDir);
  await rm(mediaDir, { recursive: true, force: true });
  db.prepare('UPDATE messages SET media_sha256 = NULL').run();
  db.prepare('DELETE FROM media').run();
  return { files };
}

/** Forget saved Ask conversations. The archive itself is untouched. */
export function clearConversations(db: DB): { conversations: number } {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
  db.prepare('DELETE FROM conversation_turns').run();
  db.prepare('DELETE FROM conversations').run();
  return { conversations: n };
}

/**
 * Queue everything for enrichment again.
 *
 * For when the model or provider changed and the existing glosses were produced
 * by something worse. Costs a full re-run, so it is never automatic.
 */
export function reindexAll(db: DB): { queued: number } {
  const r = db
    .prepare("UPDATE messages SET enrich_state = 'pending' WHERE body_raw <> ''")
    .run();
  return { queued: r.changes };
}

/** Remove messages older than a cutoff, and any chat left with nothing in it. */
export function deleteOlderThan(db: DB, cutoffMs: number): { messages: number; chats: number } {
  const msgs = db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoffMs);
  const chats = db
    .prepare('DELETE FROM chats WHERE jid NOT IN (SELECT DISTINCT chat_jid FROM messages)')
    .run();
  return { messages: msgs.changes, chats: chats.changes };
}

/** Delete one conversation's messages, keeping the rest of the archive. */
export function deleteChat(db: DB, chatJid: string): { messages: number } {
  const r = db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
  db.prepare('DELETE FROM chats WHERE jid = ?').run(chatJid);
  return { messages: r.changes };
}

/**
 * Empty the archive but keep the WhatsApp session.
 *
 * Deliberately does not touch auth/: someone resetting their data almost never
 * means "and make me scan a QR code again". Unlinking is its own action.
 */
export async function resetArchive(db: DB, mediaDir: string): Promise<{ messages: number }> {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  await rm(mediaDir, { recursive: true, force: true });
  db.exec(`
    DELETE FROM conversation_turns;
    DELETE FROM conversations;
    DELETE FROM messages;
    DELETE FROM chats;
    DELETE FROM contacts;
    DELETE FROM contacts_fts;
    DELETE FROM media;
  `);
  return { messages: n };
}

/** Reclaim disk after deletions. SQLite does not shrink on its own. */
export function compact(db: DB): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
}
