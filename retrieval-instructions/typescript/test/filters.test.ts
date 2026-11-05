import { describe, expect, it } from 'vitest';
import {
  describeFilter,
  entitled,
  eq,
  type Filter,
  filterFor,
  matches,
  parseCell,
} from '../src/filters';
import { fixture } from './support';

interface Case {
  tenant: string;
  region: string | null;
  filter: Filter;
  describe: string;
}

const DOCS: Record<string, string>[] = fixture('..', 'corpus', 'manifest.json').docs;
const CASES: Case[] = fixture('filters.json');
const caseId = (c: Case): string => (c.region ? `${c.tenant}+${c.region}` : c.tenant);

describe.each(CASES.map((c) => [caseId(c), c] as const))('%s', (_, c) => {
  it('expresses exactly the entitlement', () => {
    for (const doc of DOCS) {
      expect(matches(c.filter, doc), doc.path).toBe(entitled(c.tenant, doc, c.region));
    }
  });

  it('equals the fixture from filterFor and describeFilter', () => {
    const [region, team] = parseCell(c.tenant);
    expect(filterFor(c.region || region, team)).toEqual(c.filter);
    expect(describeFilter(c.filter)).toBe(c.describe);
  });

  it('never entitles the restricted engineering documents', () => {
    const restricted = DOCS.filter((d) => d.sensitivity === 'restricted');
    expect(restricted).toHaveLength(2);
    expect(restricted.some((d) => entitled(c.tenant, d, c.region))).toBe(false);
  });
});

describe('filters', () => {
  it('applies the entitlement rules', () => {
    const north = { region: 'sales-region-north', audience_team: 'all' };
    const supportDoc = { region: 'global', audience_team: 'team-support' };
    const southSales = {
      region: 'sales-region-south',
      audience_team: 'team-field-sales',
    };
    expect(entitled('sales-region-north', north)).toBe(true);
    expect(entitled('sales-region-central', north)).toBe(false);
    expect(entitled('sales-region-north', supportDoc)).toBe(false);
    expect(
      entitled('team-support', north) && entitled('team-support', supportDoc),
    ).toBe(true);
    expect(entitled('sales-region-south.team-field-sales', southSales)).toBe(true);
    expect(entitled('sales-region-north.team-field-sales', southSales)).toBe(false);
    expect(entitled('team-field-sales', southSales, 'sales-region-north')).toBe(false);
    expect(
      entitled('structured-json', north) && !entitled('structured-json', supportDoc),
    ).toBe(true);
  });

  it('parses cells', () => {
    expect(parseCell('sales-region-south.team-field-sales')).toEqual([
      'sales-region-south',
      'team-field-sales',
    ]);
    expect(parseCell('team-support')).toEqual([null, 'team-support']);
    expect(parseCell('sales-region-central')).toEqual(['sales-region-central', null]);
    expect(parseCell('structured-json')).toEqual([null, null]);
  });

  it('builds the filter structure', () => {
    expect(filterFor()).toEqual(eq('audience_team', 'all'));
    expect(filterFor(null, 'team-support')).toEqual({
      orAll: [eq('audience_team', 'all'), eq('audience_team', 'team-support')],
    });
  });

  it('rejects unsupported operators', () => {
    expect(() =>
      matches({ in: { key: 'region', value: ['global'] } }, DOCS[0] ?? {}),
    ).toThrow(RangeError);
  });

  it('describes filters', () => {
    expect(describeFilter(null)).toBe('none');
    expect(
      describeFilter({ andAll: [eq('audience_team', 'all'), eq('region', 'global')] }),
    ).toBe('audience_team = all; region = global');
    expect(() =>
      describeFilter({ orAll: [eq('region', 'global'), eq('audience_team', 'all')] }),
    ).toThrow(RangeError);
  });
});
