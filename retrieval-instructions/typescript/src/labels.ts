/** Sales region labels and the tenant line placed before each question. */

export const REGION_LABELS: Readonly<Record<string, string>> = {
  'sales-region-north': 'Sales Region North',
  'sales-region-central': 'Sales Region Central',
  'sales-region-south': 'Sales Region South',
};

/** The label the corpus uses for a region key, for example `Sales Region Central`. */
export function regionLabel(region: string): string {
  const label = REGION_LABELS[region];
  if (label === undefined) throw new RangeError(`no label for region ${region}`);
  return label;
}

/** The tenant context on its own line before the user's question. */
export function tenantLine(region: string): string {
  return `Customer sales region: ${regionLabel(region)}.`;
}
