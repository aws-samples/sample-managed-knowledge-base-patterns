/**
 * Release instruction changes one tenant at a time.
 *
 * Each tenant's release configuration lives in sample-state.json: the live version and an
 * optional canary.
 */

import { UsageError } from './errors';

export const VERSION_RE = /^[1-9][0-9]{0,8}$/;

// The application owns routing. Amazon Bedrock serves the version you pin on each request.
export interface Canary {
  version: string; // version that gets the canary share, for example "2"
  every: number; // one request in `every` goes to `version`
}

export interface ReleaseConfig {
  live: string; // version for normal traffic, for example "1"
  canary?: Canary;
}

export function versionFor(cfg: ReleaseConfig, requestIndex: number): string {
  if (cfg.canary && requestIndex % cfg.canary.every === 0) return cfg.canary.version;
  return cfg.live;
}

// Promote: { live: "2" }. Roll back: { live: "1" }.

/** `2 (1 in 5)`, or `none`. */
export function canaryText(cfg: ReleaseConfig | undefined): string {
  if (cfg?.canary === undefined) return 'none';
  return `${cfg.canary.version} (1 in ${cfg.canary.every})`;
}

/** `live 1, canary 2 (1 in 5)` or `live 1, no canary`. */
export function describeRelease(cfg: ReleaseConfig): string {
  if (cfg.canary === undefined) return `live ${cfg.live}, no canary`;
  return `live ${cfg.live}, canary ${canaryText(cfg)}`;
}

/** Validate `release set` options against the versions this sample recorded for the instruction. */
export function checkedRelease(
  name: string,
  versions: readonly string[],
  live: string,
  canary: string | undefined,
  every: number | undefined,
): ReleaseConfig {
  for (const value of [live, canary]) {
    if (value === undefined) continue;
    if (!VERSION_RE.test(value)) {
      throw new UsageError(`version '${value}' isn't a version number such as 1 or 2`);
    }
    if (!versions.includes(value)) {
      throw new UsageError(
        `version ${value} isn't recorded for ${name}; release show lists the versions`,
      );
    }
  }
  if (canary === undefined) {
    if (every !== undefined) throw new UsageError('--every needs --canary');
    return { live };
  }
  if (every === undefined) throw new UsageError('--canary needs --every');
  if (every < 1) throw new UsageError('--every must be 1 or more');
  return { live, canary: { version: canary, every } };
}
