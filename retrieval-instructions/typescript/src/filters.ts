/**
 * Tenant entitlements and the metadata filters that express them.
 *
 * Each document's metadata has `region` (global or sales-region-*), `audience_team` (all or
 * team-*), and `sensitivity`. Filters use only `equals` inside `andAll` and `orAll`. Only
 * tenancy.ts builds request filters from these functions; see SECURITY.md.
 */

export const REGIONS = [
  'sales-region-north',
  'sales-region-central',
  'sales-region-south',
];
export const TEAMS = ['team-support', 'team-field-sales', 'team-legal-compliance'];

export interface Equals {
  equals: { key: string; value: string };
}
export interface AndAll {
  andAll: Filter[];
}
export interface OrAll {
  orAll: Filter[];
}
export type Filter = Equals | AndAll | OrAll;

export type Metadata = Readonly<Record<string, unknown>>;

/** Split a tenant key into [region, team]. A combined key is `<region>.<team>`. */
export function parseCell(tenant: string): [string | null, string | null] {
  const dot = tenant.indexOf('.');
  const first = dot === -1 ? tenant : tenant.slice(0, dot);
  const second = dot === -1 ? '' : tenant.slice(dot + 1);
  const region = REGIONS.includes(first) ? first : null;
  const teamPart = second || first;
  const team = TEAMS.includes(teamPart) ? teamPart : null;
  return [region, team];
}

/**
 * Whether a tenant may see a document.
 *
 *   region tenant  = region in {global, own}  and audience = all
 *   team tenant    = any region               and audience in {all, own team}
 *   team + region  = region in {global, own}  and audience in {all, own team}
 *   other keys     = any region               and audience = all (the structured JSON instruction)
 */
export function entitled(
  tenant: string,
  doc: Metadata,
  region: string | null = null,
): boolean {
  const [cellRegion, team] = parseCell(tenant);
  const scope = region || cellRegion;
  const regionOk = scope ? doc.region === 'global' || doc.region === scope : true;
  const audienceOk = team
    ? doc.audience_team === 'all' || doc.audience_team === team
    : doc.audience_team === 'all';
  return regionOk && audienceOk;
}

// Build on the server from the authenticated tenant, never from user input.
export function eq(key: string, value: string): Equals {
  return { equals: { key, value } };
}

export function filterFor(
  region: string | null = null,
  team: string | null = null,
): Filter {
  // Region tenant: global plus own region, audience "all".
  // Team tenant: any region, audience "all" plus own team.
  const regionF = region
    ? { orAll: [eq('region', 'global'), eq('region', region)] }
    : null;
  const audienceF = team
    ? { orAll: [eq('audience_team', 'all'), eq('audience_team', team)] }
    : eq('audience_team', 'all');
  return regionF ? { andAll: [audienceF, regionF] } : audienceF;
}

function operators(f: object): string {
  return `[${Object.keys(f)
    .sort()
    .map((k) => `'${k}'`)
    .join(', ')}]`;
}

/** Evaluate the equals, andAll, and orAll subset of a retrieval filter against document metadata. */
export function matches(f: object, doc: Metadata): boolean {
  if ('equals' in f) {
    const { key, value } = (f as Equals).equals;
    return doc[key] === value;
  }
  if ('andAll' in f) return (f as AndAll).andAll.every((g) => matches(g, doc));
  if ('orAll' in f) return (f as OrAll).orAll.some((g) => matches(g, doc));
  throw new RangeError(`unsupported filter operator: ${operators(f)}`);
}

/** `key = value`, `key in (v1, v2)` for an orAll on one key, and andAll parts joined with `; `. */
export function describeFilter(f: Filter | null): string {
  if (f === null) return 'none';
  if ('equals' in f) return `${f.equals.key} = ${f.equals.value}`;
  if ('orAll' in f) {
    const parts = f.orAll;
    const keys = new Set(parts.map((g) => ('equals' in g ? g.equals.key : undefined)));
    if (keys.size !== 1 || !parts.every((g) => 'equals' in g)) {
      throw new RangeError('describeFilter supports orAll of equals on one key');
    }
    const values = parts.map((g) => (g as Equals).equals.value).join(', ');
    return `${[...keys][0]} in (${values})`;
  }
  if ('andAll' in f) return f.andAll.map((g) => describeFilter(g)).join('; ');
  throw new RangeError(`unsupported filter operator: ${operators(f)}`);
}
