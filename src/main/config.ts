import { app } from 'electron';
import path from 'node:path';

/**
 * Phase 1 config: still environment-driven, exactly as the old server was.
 *
 * Phase 3 replaces this with a settings pane backed by safeStorage, and makes
 * the key changeable at runtime so flipping local-only <-> model-assisted does
 * not need a relaunch. Keeping the shape identical now means that change is
 * confined to this file. See PLAN.md §4 Phase 3.
 */
export interface Config {
  anthropicApiKey: string | undefined;
  model: string;
  localOnly: boolean;
  defaultWorkspace: string;
}

export function loadConfig(): Config {
  const key = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  return {
    anthropicApiKey: key,
    model: process.env.WA_MODEL?.trim() || 'claude-sonnet-5',
    // Local-only is a real mode, not a degraded one: capture, folding, stemming
    // and keyword search all work, and nothing leaves the machine at all.
    localOnly: !key,
    defaultWorkspace: path.join(app.getPath('userData'), 'workspace'),
  };
}
