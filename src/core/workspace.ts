import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * A workspace is one directory holding everything: the database, the WhatsApp
 * credentials, and downloaded media. One directory means one thing to back up,
 * one thing to encrypt, and one thing to delete when you're done.
 */
export interface Workspace {
  root: string;
  dbPath: string;
  authDir: string;
  mediaDir: string;
}

export async function openWorkspace(root: string): Promise<Workspace> {
  const abs = path.resolve(root);
  const ws: Workspace = {
    root: abs,
    dbPath: path.join(abs, 'archive.sqlite'),
    authDir: path.join(abs, 'auth'),
    mediaDir: path.join(abs, 'media'),
  };

  await mkdir(ws.authDir, { recursive: true });
  await mkdir(ws.mediaDir, { recursive: true });

  // Owner-only. The auth directory in particular is a full WhatsApp account
  // takeover for anyone who can read it — treat it like an SSH private key.
  await chmod(abs, 0o700).catch(() => {});
  await chmod(ws.authDir, 0o700).catch(() => {});

  // A workspace that lands inside a git repo is one `git add -A` away from
  // publishing your contacts' messages. Drop a guard in unconditionally.
  const guard = path.join(abs, '.gitignore');
  if (!existsSync(guard)) {
    await writeFile(guard, '*\n', { mode: 0o600 });
  }
  return ws;
}

export interface WorkspaceWarning {
  level: 'warn' | 'danger';
  message: string;
}

/**
 * Checks that are cheap to run and expensive to skip. Surfaced in the UI rather
 * than logged, because a warning nobody reads is not a warning.
 */
export async function auditWorkspace(ws: Workspace): Promise<WorkspaceWarning[]> {
  const out: WorkspaceWarning[] = [];

  const inGitRepo = (() => {
    let dir = ws.root;
    for (let i = 0; i < 6; i++) {
      if (existsSync(path.join(dir, '.git'))) return true;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return false;
  })();
  if (inGitRepo) {
    out.push({
      level: 'danger',
      message:
        'This workspace sits inside a git repository. It contains WhatsApp credentials and ' +
        'other people\u2019s messages. A .gitignore has been written, but move the workspace ' +
        'outside the repo if you plan to share this code.',
    });
  }

  const cloudMarkers = ['Dropbox', 'Google Drive', 'OneDrive', 'iCloud', 'Sync'];
  if (cloudMarkers.some((m) => ws.root.includes(m))) {
    out.push({
      level: 'danger',
      message:
        'This path looks like a synced cloud folder. Your entire message archive and your ' +
        'WhatsApp session keys would be uploaded to a third party.',
    });
  }

  try {
    const s = await stat(ws.authDir);
    if ((s.mode & 0o077) !== 0) {
      out.push({
        level: 'warn',
        message: 'The credentials directory is readable by other users on this machine.',
      });
    }
  } catch {
    /* not created yet */
  }

  return out;
}
