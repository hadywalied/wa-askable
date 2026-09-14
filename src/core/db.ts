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

/*
 * People.
 *
 * A JID is not an identity a human recognises. Questions are asked with names
 * and numbers — "what did Ahmed say", "the guy ending 4698" — so the names have
 * to be stored, searchable, and resolvable back to a JID before a search can
 * even start. WhatsApp supplies them from several places of differing quality,
 * hence the separate columns rather than one overwritten name column.
 */
CREATE TABLE IF NOT EXISTS contacts (
  jid           TEXT PRIMARY KEY,
  /* Name from the user's own address book — the most trustworthy. */
  name          TEXT,
  /* The push name a person set for themselves. */
  notify        TEXT,
  /* Business-verified name, when there is one. */
  verified_name TEXT,
  /* Digits from the JID, i.e. the phone number. */
  phone         TEXT,
  /* Linked-ID alias WhatsApp increasingly uses in groups. */
  lid           TEXT,
  is_me         INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

/* Searching people by any of their names, including transliterated Arabic. */
CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
  jid UNINDEXED, names, phone,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

/*
 * Saved Ask conversations. They live in the workspace, not in app settings,
 * because a conversation is only meaningful against the archive it was asked
 * of — moving workspaces should not drag someone else's answers along.
 */
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  tool_calls      TEXT,
  ts              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_conv ON conversation_turns(conversation_id, id);
`;

export type DB = Database.Database;

export function openDatabase(dbPath: string): DB {
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Additive migrations for archives created by an earlier version.
 *
 * CREATE TABLE IF NOT EXISTS covers new tables but never new columns, so an
 * existing archive silently keeps the old shape. Checked rather than attempted,
 * because a failed ALTER here would take the whole app down on startup.
 */
function migrate(db: DB): void {
  const columns = (table: string): string[] =>
    (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);

  if (!columns('conversation_turns').includes('citations')) {
    db.exec('ALTER TABLE conversation_turns ADD COLUMN citations TEXT');
  }
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


// --- saved Ask conversations -------------------------------------------------

export interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  turns?: number;
}

export interface TurnRow {
  role: 'user' | 'assistant';
  content: string;
  toolCalls: { name: string; input: unknown }[];
  /** Verified sources for this answer, so reopening a chat keeps its links. */
  citations: unknown[];
  ts: number;
}

export function listConversations(db: DB, limit = 100): ConversationRow[] {
  return db
    .prepare(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM conversation_turns t WHERE t.conversation_id = c.id) AS turns
         FROM conversations c
        ORDER BY c.updated_at DESC
        LIMIT ?`,
    )
    .all(limit) as ConversationRow[];
}

export function createConversation(db: DB, title = 'New chat'): ConversationRow {
  const now = Date.now();
  const id = `c_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, title, now, now);
  return { id, title, created_at: now, updated_at: now, turns: 0 };
}

export function conversationTurns(db: DB, conversationId: string): TurnRow[] {
  const rows = db
    .prepare(
      `SELECT role, content, tool_calls AS toolCalls, citations, ts
         FROM conversation_turns WHERE conversation_id = ? ORDER BY id ASC`,
    )
    .all(conversationId) as {
    role: string; content: string; toolCalls: string | null; citations: string | null; ts: number;
  }[];
  return rows.map((r) => ({
    role: r.role as 'user' | 'assistant',
    content: r.content,
    toolCalls: r.toolCalls ? (JSON.parse(r.toolCalls) as TurnRow['toolCalls']) : [],
    citations: r.citations ? (JSON.parse(r.citations) as unknown[]) : [],
    ts: r.ts,
  }));
}

export function appendTurn(
  db: DB,
  conversationId: string,
  turn: { role: 'user' | 'assistant'; content: string; toolCalls?: unknown[]; citations?: unknown[] },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO conversation_turns (conversation_id, role, content, tool_calls, citations, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    conversationId,
    turn.role,
    turn.content,
    turn.toolCalls?.length ? JSON.stringify(turn.toolCalls) : null,
    turn.citations?.length ? JSON.stringify(turn.citations) : null,
    now,
  );
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

  // Name the conversation after its first question, the way every chat app
  // does — "New chat" repeated twenty times is not a history.
  if (turn.role === 'user') {
    db.prepare(
      `UPDATE conversations SET title = ?
        WHERE id = ? AND (title = 'New chat' OR title = '')`,
    ).run(turn.content.replace(/\s+/g, ' ').trim().slice(0, 60), conversationId);
  }
}

export function deleteConversation(db: DB, id: string): void {
  db.prepare('DELETE FROM conversation_turns WHERE conversation_id = ?').run(id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}


// --- contacts ----------------------------------------------------------------

export interface ContactRow {
  jid: string;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
  phone: string | null;
  lid: string | null;
  isMe: 0 | 1;
}

/** Digits of a JID are the phone number; LID-form JIDs have no usable number. */
export function phoneOf(jid: string): string | null {
  if (!jid || jid.includes('@lid')) return null;
  const digits = jid.split('@')[0]?.split(':')[0]?.replace(/[^0-9]/g, '') ?? '';
  return digits.length >= 6 ? digits : null;
}

/** The name a person should be shown as, best source first. */
export function displayName(c: Partial<ContactRow>): string | null {
  return c.name || c.verifiedName || c.notify || null;
}

/**
 * Upsert a contact without letting a weaker source overwrite a stronger one:
 * an address-book name must survive a later pushName update.
 */
export function upsertContact(
  db: DB,
  c: { jid: string; name?: string | null; notify?: string | null; verifiedName?: string | null; lid?: string | null; isMe?: boolean },
): void {
  const jid = c.jid;
  if (!jid) return;
  db.prepare(
    `INSERT INTO contacts (jid, name, notify, verified_name, phone, lid, is_me, updated_at)
     VALUES (@jid, @name, @notify, @verifiedName, @phone, @lid, @isMe, @now)
     ON CONFLICT(jid) DO UPDATE SET
       name          = COALESCE(excluded.name, contacts.name),
       notify        = COALESCE(excluded.notify, contacts.notify),
       verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
       lid           = COALESCE(excluded.lid, contacts.lid),
       is_me         = MAX(contacts.is_me, excluded.is_me),
       updated_at    = excluded.updated_at`,
  ).run({
    jid,
    name: c.name?.trim() || null,
    notify: c.notify?.trim() || null,
    verifiedName: c.verifiedName?.trim() || null,
    phone: phoneOf(jid),
    lid: c.lid ?? null,
    isMe: c.isMe ? 1 : 0,
    now: Date.now(),
  });
  reindexContact(db, jid);
}

function reindexContact(db: DB, jid: string): void {
  const row = db
    .prepare('SELECT jid, name, notify, verified_name AS verifiedName, phone FROM contacts WHERE jid = ?')
    .get(jid) as (ContactRow & { verifiedName: string | null }) | undefined;
  if (!row) return;
  const names = [row.name, row.notify, row.verifiedName].filter(Boolean).join(' ');
  db.prepare('DELETE FROM contacts_fts WHERE jid = ?').run(jid);
  db.prepare('INSERT INTO contacts_fts (jid, names, phone) VALUES (?, ?, ?)').run(
    jid,
    names,
    row.phone ?? '',
  );
}

export function contactFor(db: DB, jid: string): ContactRow | undefined {
  return db
    .prepare(
      `SELECT jid, name, notify, verified_name AS verifiedName, phone, lid, is_me AS isMe
         FROM contacts WHERE jid = ?`,
    )
    .get(jid) as ContactRow | undefined;
}

export function contactCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
}
