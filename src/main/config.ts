import { app } from 'electron';
import path from 'node:path';
import { getApiKey, getSettings } from './settings.js';

/**
 * Runtime configuration.
 *
 * Deliberately rebuilt from settings rather than captured once at boot: the
 * whole point of Phase 3 is that pasting a key flips the app from local-only to
 * model-assisted without a relaunch, and that only works if nothing holds a
 * stale copy. See PLAN.md §4 Phase 3.
 */
export interface Config {
  anthropicApiKey: string | undefined;
  model: string;
  localOnly: boolean;
  defaultWorkspace: string;
}

export async function loadConfig(): Promise<Config> {
  const key = await getApiKey();
  return {
    anthropicApiKey: key,
    model: getSettings().model,
    // Local-only is a real mode, not a degraded one: capture, folding, stemming
    // and keyword search all work, and nothing leaves the machine at all.
    localOnly: !key,
    defaultWorkspace: path.join(app.getPath('userData'), 'workspace'),
  };
}
