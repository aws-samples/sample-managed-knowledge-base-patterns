/**
 * Names shared by the stack and both SDK programs. The Python and TypeScript programs
 * keep their own copies, and every copy is tested against
 * test-fixtures/constants.json.
 */

export const STACK_NAME = 'RetrievalInstructionsSample';

/** Tag on every taggable stack resource and on every retrieval instruction. */
export const SAMPLE_TAG_KEY = 'app';
export const SAMPLE_TAG_VALUE = 'retrieval-instructions-sample';

/** Tag on tenant roles and retrieval instructions. Its value is the tenant key. */
export const TENANT_TAG_KEY = 'tenant';

export const SHARED_KNOWLEDGE_BASE_NAME = 'retrieval-instructions-sample-shared';
export const SHARED_DATA_SOURCE_NAME = 'shared-corpus';
export const SOUTH_KNOWLEDGE_BASE_NAME = 'retrieval-instructions-sample-south';
export const SOUTH_DATA_SOURCE_NAME = 'south-corpus';

export const OUTPUT_KEYS = {
  sharedKnowledgeBaseId: 'SharedKnowledgeBaseId',
  sharedKnowledgeBaseArn: 'SharedKnowledgeBaseArn',
  sharedDataSourceId: 'SharedDataSourceId',
  southKnowledgeBaseId: 'SouthKnowledgeBaseId',
  southKnowledgeBaseArn: 'SouthKnowledgeBaseArn',
  southDataSourceId: 'SouthDataSourceId',
  corpusBucketName: 'CorpusBucketName',
  tenantRoleTenants: 'TenantRoleTenants',
  platformAdminRoleArn: 'PlatformAdminRoleArn',
} as const;

/** Per-tenant output keys are these prefixes plus the Pascal-cased tenant key. */
export const TENANT_OUTPUT_PREFIXES = {
  applierRoleArn: 'ApplierRoleArn',
  tenantAdminRoleArn: 'TenantAdminRoleArn',
} as const;

export const REGION_KEYS = [
  'sales-region-north',
  'sales-region-central',
  'sales-region-south',
] as const;

export const TEAM_KEYS = [
  'team-support',
  'team-field-sales',
  'team-legal-compliance',
] as const;

/** The six tenants: three sales regions and three teams. */
export const TENANT_KEYS = [...REGION_KEYS, ...TEAM_KEYS] as const;
export type TenantKey = (typeof TENANT_KEYS)[number];

export const COMBINED_KEYS = [
  'sales-region-north.team-support',
  'sales-region-north.team-field-sales',
  'sales-region-south.team-support',
  'sales-region-south.team-field-sales',
] as const;

export const STRUCTURED_JSON_KEY = 'structured-json';

/** Instruction names allow no dots, so combined keys use hyphens. */
export function instructionName(key: string): string {
  return `assistant-${key.replace(/\./g, '-')}`;
}

/** Every instruction name the sample can create, in spec order. */
export const INSTRUCTION_NAMES = [
  ...TENANT_KEYS,
  STRUCTURED_JSON_KEY,
  ...COMBINED_KEYS,
].map(instructionName);

/** `sales-region-north` becomes `SalesRegionNorth`. */
export function pascal(key: string): string {
  return key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
