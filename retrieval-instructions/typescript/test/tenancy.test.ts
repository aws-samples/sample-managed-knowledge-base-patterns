import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import { filterFor, matches } from '../src/filters';
import * as stateFile from '../src/state';
import { southRetrieverFilters, tenantRequest, tenantScope } from '../src/tenancy';
import { fixture } from './support';

interface Case {
  tenant: string;
  region: string | null;
  tenantLine: string | null;
  filter: unknown;
}

const CASES: Case[] = fixture('filters.json');
const DOCS: Record<string, string>[] = fixture('..', 'corpus', 'manifest.json').docs;

describe('tenancy', () => {
  it.each(CASES.map((c) => [`${c.tenant}+${c.region}`, c] as const))(
    'tenantScope equals the fixture for %s',
    (_, c) => {
      expect(tenantScope(c.tenant, c.region)).toEqual([c.tenantLine, c.filter]);
    },
  );

  it.each<[string, string | null]>([
    ['sales-region-north', 'sales-region-south'],
    ['sales-region-north.team-support', 'sales-region-north'],
    ['team-support', 'sales-region-west'],
    ['structured-json', 'sales-region-north'],
    ['team-engineering', null],
    ['sales-region-west', null],
  ])('refuses %s with region %s (exit 2)', (tenant, region) => {
    expect(() => tenantScope(tenant, region)).toThrow(UsageError);
  });

  it('reads the instruction from the state file and maps DRAFT', () => {
    const state = stateFile.parse(fixture('state.json'));
    const req = tenantRequest(state, 'team-support', 'sales-region-north', '2');
    expect([req.instructionId, req.version]).toEqual(['fghij67890', '2']);
    expect(req.tenantLine).toBe('Customer sales region: Sales Region North.');
    expect(req.tenantFilter).toEqual(filterFor('sales-region-north', 'team-support'));
    expect(
      tenantRequest(state, 'sales-region-north', null, 'DRAFT').version,
    ).toBeNull();
  });

  it('refuses a tenant without an instruction (exit 2)', () => {
    const state = stateFile.parse(fixture('state.json'));
    expect(() => tenantRequest(state, 'sales-region-central', null, '1')).toThrow(
      'run create-instructions first',
    );
    expect(() =>
      tenantRequest(null, 'sales-region-north.team-support', null, '1'),
    ).toThrow('--combined');
  });

  it('builds South filters whose union selects what the single knowledge base filter selects', () => {
    const [shared, south] = southRetrieverFilters();
    expect(shared).toEqual({
      andAll: [
        { equals: { key: 'audience_team', value: 'all' } },
        { equals: { key: 'region', value: 'global' } },
      ],
    });
    expect('andAll' in south && south.andAll[1]).toEqual({
      equals: { key: 'region', value: 'sales-region-south' },
    });
    const single = filterFor('sales-region-south');
    for (const doc of DOCS) {
      expect(matches(shared, doc) || matches(south, doc), doc.path).toBe(
        matches(single, doc),
      );
    }
  });
});
