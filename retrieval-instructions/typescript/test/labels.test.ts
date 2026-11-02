import { describe, expect, it } from 'vitest';
import { regionLabel, tenantLine } from '../src/labels';

describe('labels', () => {
  it('uses the current region labels', () => {
    expect(regionLabel('sales-region-north')).toBe('Sales Region North');
    expect(regionLabel('sales-region-central')).toBe('Sales Region Central');
    expect(regionLabel('sales-region-south')).toBe('Sales Region South');
  });

  it('builds the tenant line', () => {
    expect(tenantLine('sales-region-central')).toBe(
      'Customer sales region: Sales Region Central.',
    );
  });

  it('has no label for an unknown region', () => {
    expect(() => regionLabel('sales-region-1')).toThrow(RangeError);
  });
});
