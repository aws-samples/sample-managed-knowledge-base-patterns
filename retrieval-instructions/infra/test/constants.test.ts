import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as names from '../lib/names';
import { PATTERN_DIR } from './support';

const constants = JSON.parse(
  fs.readFileSync(path.join(PATTERN_DIR, 'test-fixtures', 'constants.json'), 'utf8'),
) as Record<string, unknown>;

describe('names.ts equals test-fixtures/constants.json', () => {
  it('has the same values', () => {
    expect({
      stackName: names.STACK_NAME,
      sampleTagKey: names.SAMPLE_TAG_KEY,
      sampleTagValue: names.SAMPLE_TAG_VALUE,
      tenantTagKey: names.TENANT_TAG_KEY,
      sharedKnowledgeBaseName: names.SHARED_KNOWLEDGE_BASE_NAME,
      sharedDataSourceName: names.SHARED_DATA_SOURCE_NAME,
      southKnowledgeBaseName: names.SOUTH_KNOWLEDGE_BASE_NAME,
      southDataSourceName: names.SOUTH_DATA_SOURCE_NAME,
      outputKeys: names.OUTPUT_KEYS,
      tenantOutputPrefixes: names.TENANT_OUTPUT_PREFIXES,
      tenantKeys: names.TENANT_KEYS,
      regionKeys: names.REGION_KEYS,
      teamKeys: names.TEAM_KEYS,
      combinedKeys: names.COMBINED_KEYS,
      structuredJsonKey: names.STRUCTURED_JSON_KEY,
      instructionNames: names.INSTRUCTION_NAMES,
    }).toEqual(constants);
  });

  it('has 11 instruction names', () => {
    expect(names.INSTRUCTION_NAMES).toHaveLength(11);
  });

  it('Pascal-cases tenant keys for the per-tenant output keys', () => {
    expect(names.pascal('sales-region-north')).toBe('SalesRegionNorth');
    expect(names.pascal('team-legal-compliance')).toBe('TeamLegalCompliance');
  });
});
