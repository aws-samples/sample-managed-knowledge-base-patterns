/**
 * The filter boundary: the only module that builds a request filter for a tenant.
 *
 * Every filter comes from a tenant key that the command line names and the spec files and the
 * state file confirm. No filter is read from user input or from the question text.
 * `tenantScope()` is the only caller of `filterFor()`, and `tenantScope()` and
 * `southRetrieverFilters()` are the only code outside filters.ts that calls `eq()` or creates a
 * `TenantFilter`. The request builders accept a filter only as a `TenantFilter`, so tsc rejects
 * a plain object. See SECURITY.md.
 */

import { UsageError } from './errors';
import { type Filter, REGIONS, TEAMS, eq, filterFor, parseCell } from './filters';
import { tenantLine } from './labels';
import { STRUCTURED_JSON_KEY, combinedSpecs, tenantSpecs } from './specs';
import type { State } from './state';

declare const tenantFilterBrand: unique symbol;

/** A filter built here from the authenticated tenant. Only this module creates one. */
export type TenantFilter = Filter & { readonly [tenantFilterBrand]: true };

export interface TenantRequest {
  readonly tenant: string; // spec key, for example "team-support" or "sales-region-north.team-support"
  readonly instructionId: string; // from the state file
  readonly version: string | null; // null applies DRAFT: the request omits "version"
  readonly tenantLine: string | null; // null for a team tenant without --region, and for structured-json
  readonly tenantFilter: TenantFilter;
}

/** The tenant line and the filter for a tenant key, plus a region for a team tenant. */
export function tenantScope(
  tenant: string,
  region: string | null,
): [string | null, TenantFilter] {
  const tenants = tenantSpecs().map((spec) => spec.key);
  const combined = combinedSpecs().map((spec) => spec.key);
  if (tenants.includes(tenant) && REGIONS.includes(tenant)) {
    if (region !== null) throw new UsageError('--region works only with a team tenant');
    return [tenantLine(tenant), filterFor(tenant) as TenantFilter];
  }
  if (tenants.includes(tenant) && TEAMS.includes(tenant)) {
    if (region === null) return [null, filterFor(null, tenant) as TenantFilter];
    if (!REGIONS.includes(region)) {
      throw new UsageError(`--region must be one of ${REGIONS.join(', ')}`);
    }
    return [tenantLine(region), filterFor(region, tenant) as TenantFilter];
  }
  if (combined.includes(tenant)) {
    if (region !== null) throw new UsageError('--region works only with a team tenant');
    const [cellRegion, team] = parseCell(tenant);
    if (cellRegion === null || team === null)
      throw new UsageError(`${tenant} isn't a combined key`);
    return [tenantLine(cellRegion), filterFor(cellRegion, team) as TenantFilter];
  }
  if (tenant === STRUCTURED_JSON_KEY && region === null) {
    return [null, filterFor() as TenantFilter];
  }
  throw new UsageError(
    `--tenant must be one of ${tenants.join(', ')}, or a combined key: ${combined.join(', ')}`,
  );
}

/** The tenant's instruction from the state file, the version the caller chose, and its line and filter. */
export function tenantRequest(
  state: State | null,
  tenant: string,
  region: string | null,
  version: string | null,
): TenantRequest {
  const [line, tenantFilter] = tenantScope(tenant, region);
  const recorded = state?.instructions[tenant];
  if (recorded === undefined) {
    const hint = tenant.includes('.')
      ? 'run create-instructions --combined'
      : 'run create-instructions';
    throw new UsageError(
      `no instruction for ${tenant} in sample-state.json; ${hint} first`,
    );
  }
  return {
    tenant,
    instructionId: recorded.id,
    version: version === 'DRAFT' ? null : version,
    tenantLine: line,
    tenantFilter,
  };
}

/**
 * Filters for sales-region-south across two knowledge bases: [shared, South].
 *
 * Their union selects exactly what `filterFor("sales-region-south")` selects on one knowledge base.
 */
export function southRetrieverFilters(): [TenantFilter, TenantFilter] {
  const audience = eq('audience_team', 'all');
  const shared = { andAll: [audience, eq('region', 'global')] } as TenantFilter;
  const south = {
    andAll: [audience, eq('region', 'sales-region-south')],
  } as TenantFilter;
  return [shared, south];
}
