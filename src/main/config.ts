import { app } from 'electron';
import path from 'node:path';
import { getApiKey, getProviderConfig, getSettings } from './settings.js';
import type { ProviderKind } from '../shared/providers.js';

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
  providerId: string;
  providerKind: ProviderKind;
  /** Empty string means Anthropic's own endpoint. */
  baseUrl: string;
  localOnly: boolean;
  defaultWorkspace: string;
}

export async function loadConfig(): Promise<Config> {
  const key = await getApiKey();
  const settings = getSettings();
  // The encrypted workspace blob wins: it is the archive's own configuration.
  // settings.json is the fallback for anything written before 0.5.
  const blob = await getProviderConfig();
  const baseUrl = (blob.baseUrl ?? settings.baseUrl).trim();
  return {
    anthropicApiKey: key,
    model: blob.model ?? settings.model,
    providerId: blob.providerId ?? settings.providerId,
    providerKind: blob.providerKind ?? settings.providerKind,
    baseUrl,
    // Local-only is a real mode, not a degraded one: capture, folding, stemming
    // and keyword search all work, and nothing leaves the machine at all.
    //
    // A custom base URL counts as configured even with no key: a local agent on
    // 127.0.0.1 usually needs no credential, and refusing to work without one
    // would make the local-provider case impossible.
    localOnly: !key && !baseUrl,
    defaultWorkspace: path.join(app.getPath('userData'), 'workspace'),
  };
}
