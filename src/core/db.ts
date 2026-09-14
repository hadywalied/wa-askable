import Database from 'better-sqlite3';
import { foldForSearch, stemsForSearch } from './normalize.js';

export type MessageKind =
  | 'text' | 'image' | 'video' | 'audio' | 'document'
  | 'sticker' | 'link' | 'location' | 'contact' | 'other';

/** What enrichment still owes this row. */
export type EnrichState = 'done' | 'pending' | 'failed' | 'skipped';

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name: string | null;
  ts: number;
  from_me: 0 | 1;
  kind: MessageKind;
  /** Exactly as it arrived. Shown back to the user. Never searched. */
  body_raw: string;
  /** Canonical Arabic. Franco transliterated here too, once enrichment runs. */
  body_ar: string;
  /** Meaning in English. The bridge that makes either query language work. */
  body_en: string;
  /** Prefix-stripped Arabic stems, so "للشقة" is reachable by searching "الشقة". */
  body_stem: string;
  media_sha256: string | null;
  quoted_id: string | null;
  enrich_state: EnrichState;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chats (
  jid             TEXT PRIMARY KEY,
  name            TEXT,
  is_group        INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  first_seen_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  chat_jid     TEXT NOT NULL REFERENCES chats(jid),
  sender_jid   TEXT,
  sender_name  TEXT,
  ts           INTEGER NOT NULL,
  from_me      INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL,
  body_raw     TEXT NOT NULL DEFAULT '',
  body_ar      TEXT NOT NULL DEFAULT '',
  body_en      TEXT NOT NULL DEFAULT '',
  body_stem    TEXT NOT NULL DEFAULT '',
  media_sha256 TEXT REFERENCES media(sha256),
  quoted_id    TEXT,
  enrich_state TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages(chat_jid, ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_ts      ON messages(ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_sender  ON messages(sender_jid);
CREATE INDEX IF NOT EXISTS idx_msg_enrich  ON messages(enrich_state) WHERE enrich_state = 'pending';

/*
 * Media is keyed by content hash, not by message. The same forwarded video
 * arrives fifteen times across five groups; we transcribe or caption it once
 * and every message that carries those bytes points at the same row.
 */
CREATE TABLE IF NOT EXISTS media (
  sha256      TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  rel_path    TEXT,
  description TEXT,
  transcript  TEXT,
  seen_count  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

/*
 * External-content FTS: the index stores only the tokens, the text lives in
 * messages. body_ar and body_en are separate columns so a query can be aimed
 * at one script or allowed to hit both.
 */
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body_ar, body_en, body_stem, sender_name,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body_ar, body_en, body_stem, sender_name)
  VALUES (new.rowid, new.body_ar, new.body_en, new.body_stem, new.sender_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body_ar, body_en, body_stem, sender_name)
  VALUES ('delete', old.rowid, old.body_ar, old.body_en, old.body_stem, old.sender_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body_ar, body_en, body_stem, sender_name)
  VALUES ('delete', old.rowid, old.body_ar, old.body_en, old.body_stem, old.sender_name);
  INSERT INTO messages_fts(rowid, body_ar, body_en, body_stem, sender_name)
  VALUES (new.rowid, new.body_ar, new.body_en, new.body_stem, new.sender_name);
END;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export type DB = Database.Database;

export function openDatabase(dbPath: string): DB {
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
}

export function upsertChat(
  db: DB,
  chat: { jid: string; name?: string | null; isGroup: boolean; ts: number },
): void {
  db.prepare(
    `INSERT INTO chats (jid, name, is_group, last_message_at, first_seen_at)
     VALUES (@jid, @name, @isGroup, @ts, @ts)
     ON CONFLICT(jid) DO UPDATE SET
       name            = COALESCE(excluded.name, chats.name),
       last_message_at = MAX(COALESCE(chats.last_message_at, 0), excluded.last_message_at)`,
  ).run({ jid: chat.jid, name: chat.name ?? null, isGroup: chat.isGroup ? 1 : 0, ts: chat.ts });
}

/**
 * Insert a message. body_ar is pre-folded here so plain text is searchable
 * immediately — enrichment later overwrites it with a transliteration and
 * fills body_en.
 */
export function insertMessage(
  db: DB,
  m: Omit<MessageRow, 'body_ar' | 'body_stem'> & { body_ar?: string; body_stem?: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO messages
       (id, chat_jid, sender_jid, sender_name, ts, from_me, kind,
        body_raw, body_ar, body_en, body_stem, media_sha256, quoted_id, enrich_state)
     VALUES
       (@id, @chat_jid, @sender_jid, @sender_name, @ts, @from_me, @kind,
        @body_raw, @body_ar, @body_en, @body_stem, @media_sha256, @quoted_id, @enrich_state)`,
  ).run({
    ...m,
    body_ar: m.body_ar ?? foldForSearch(m.body_raw),
    body_stem: m.body_stem ?? stemsForSearch(m.body_raw),
  });
}

export function rememberMedia(
  db: DB,
  media: { sha256: string; kind: string; byteSize: number; relPath?: string | null },
): { isNew: boolean } {
  const existing = db.prepare('SELECT sha256 FROM media WHERE sha256 = ?').get(media.sha256);
  if (existing) {
    db.prepare('UPDATE media SET seen_count = seen_count + 1 WHERE sha256 = ?').run(media.sha256);
    return { isNew: false };
  }
  db.prepare(
    `INSERT INTO media (sha256, kind, byte_size, rel_path, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(media.sha256, media.kind, media.byteSize, media.relPath ?? null, Date.now());
  return { isNew: true };
}

export interface WorkspaceStats {
  chats: number;
  messages: number;
  pending: number;
  mediaUnique: number;
  mediaReferences: number;
  oldest: number | null;
  newest: number | null;
}

export function stats(db: DB): WorkspaceStats {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const m = one<{ n: number; oldest: number | null; newest: number | null }>(
    'SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM messages',
  );
  const md = one<{ uniq: number; refs: number | null }>(
    'SELECT COUNT(*) AS uniq, SUM(seen_count) AS refs FROM media',
  );
  return {
    chats: one<{ n: number }>('SELECT COUNT(*) AS n FROM chats').n,
    messages: m.n,
    pending: one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE enrich_state = 'pending'").n,
    mediaUnique: md.uniq,
    mediaReferences: md.refs ?? 0,
    oldest: m.oldest,
    newest: m.newest,
  };
}
