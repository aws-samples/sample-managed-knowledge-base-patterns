import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SampleOptions } from './config';
import { Corpus, CORPUS_PREFIX } from './constructs/corpus';
import { ManagedKnowledgeBase } from './constructs/managed-knowledge-base';
import { PlatformAdminRole } from './constructs/platform-admin-role';
import { TenantRoles } from './constructs/tenant-roles';
import {
  configureAutoDeleteObjectsHandler,
  deleteLogGroupsAfterRoles,
} from './log-groups';
import { acknowledgeStackFindings } from './nag-acknowledgments';
import {
  OUTPUT_KEYS,
  SAMPLE_TAG_KEY,
  SAMPLE_TAG_VALUE,
  SHARED_DATA_SOURCE_NAME,
  SHARED_KNOWLEDGE_BASE_NAME,
  SOUTH_DATA_SOURCE_NAME,
  SOUTH_KNOWLEDGE_BASE_NAME,
  TENANT_OUTPUT_PREFIXES,
  TenantKey,
  pascal,
} from './names';

/** The South knowledge base indexes only what a Sales Region South tenant may read. */
const SOUTH_PREFIXES = [
  `${CORPUS_PREFIX}global/`,
  `${CORPUS_PREFIX}sales-region-south/`,
];

export interface RetrievalInstructionsSampleStackProps extends cdk.StackProps {
  readonly options: SampleOptions;
}

/**
 * Everything CloudFormation can own for the sample: the corpus bucket and upload, the
 * shared and the optional Sales Region South knowledge bases with ingestion on deploy,
 * and, only with trustedPrincipalArn, the tenant roles and the platform admin role.
 * Retrieval instructions and their versions are created by the SDK programs.
 */
export class RetrievalInstructionsSampleStack extends cdk.Stack {
  readonly corpus: Corpus;
  readonly sharedKnowledgeBase: ManagedKnowledgeBase;
  readonly southKnowledgeBase?: ManagedKnowledgeBase;
  readonly tenantRoles: ReadonlyMap<TenantKey, TenantRoles>;
  readonly platformAdmin?: PlatformAdminRole;

  constructor(
    scope: Construct,
    id: string,
    props: RetrievalInstructionsSampleStackProps,
  ) {
    super(scope, id, {
      ...props,
      tags: { ...props.tags, [SAMPLE_TAG_KEY]: SAMPLE_TAG_VALUE },
    });
    cdk.Tags.of(this).add(SAMPLE_TAG_KEY, SAMPLE_TAG_VALUE);
    const { options } = props;

    this.corpus = new Corpus(this, 'Corpus');
    configureAutoDeleteObjectsHandler(this, { [SAMPLE_TAG_KEY]: SAMPLE_TAG_VALUE });
    const corpus = {
      bucket: this.corpus.bucket,
      corpusFingerprint: this.corpus.fingerprint,
      deployment: this.corpus.deployment,
    };

    this.sharedKnowledgeBase = new ManagedKnowledgeBase(this, 'SharedKnowledgeBase', {
      ...corpus,
      name: SHARED_KNOWLEDGE_BASE_NAME,
      description: 'Shared knowledge base of the retrieval instructions sample',
      dataSourceName: SHARED_DATA_SOURCE_NAME,
      dataSourceDescription: 'Every document of the synthetic AnyCompany corpus',
      inclusionPrefixes: [CORPUS_PREFIX],
    });
    this.output(
      OUTPUT_KEYS.sharedKnowledgeBaseId,
      this.sharedKnowledgeBase.knowledgeBaseId,
    );
    this.output(
      OUTPUT_KEYS.sharedKnowledgeBaseArn,
      this.sharedKnowledgeBase.knowledgeBaseArn,
    );
    this.output(OUTPUT_KEYS.sharedDataSourceId, this.sharedKnowledgeBase.dataSourceId);

    if (options.southKnowledgeBase) {
      this.southKnowledgeBase = new ManagedKnowledgeBase(this, 'SouthKnowledgeBase', {
        ...corpus,
        name: SOUTH_KNOWLEDGE_BASE_NAME,
        description:
          'Sales Region South knowledge base of the retrieval instructions sample',
        dataSourceName: SOUTH_DATA_SOURCE_NAME,
        dataSourceDescription: 'Global and Sales Region South documents',
        inclusionPrefixes: SOUTH_PREFIXES,
      });
      this.output(
        OUTPUT_KEYS.southKnowledgeBaseId,
        this.southKnowledgeBase.knowledgeBaseId,
      );
      this.output(
        OUTPUT_KEYS.southKnowledgeBaseArn,
        this.southKnowledgeBase.knowledgeBaseArn,
      );
      this.output(OUTPUT_KEYS.southDataSourceId, this.southKnowledgeBase.dataSourceId);
    }
    this.output(OUTPUT_KEYS.corpusBucketName, this.corpus.bucket.bucketName);

    const tenantRoles = new Map<TenantKey, TenantRoles>();
    if (options.trustedPrincipalArn !== undefined) {
      const trustedPrincipalArn = options.trustedPrincipalArn;
      this.platformAdmin = new PlatformAdminRole(this, 'PlatformAdmin', {
        trustedPrincipalArn,
      });
      this.output(OUTPUT_KEYS.platformAdminRoleArn, this.platformAdmin.role.roleArn);
      for (const tenant of options.tenantRoles) {
        const knowledgeBaseArns = [this.sharedKnowledgeBase.knowledgeBaseArn];
        if (tenant === 'sales-region-south' && this.southKnowledgeBase) {
          knowledgeBaseArns.push(this.southKnowledgeBase.knowledgeBaseArn);
        }
        const roles = new TenantRoles(this, `TenantRoles${pascal(tenant)}`, {
          tenant,
          trustedPrincipalArn,
          knowledgeBaseArns,
        });
        tenantRoles.set(tenant, roles);
        this.output(
          `${TENANT_OUTPUT_PREFIXES.applierRoleArn}${pascal(tenant)}`,
          roles.applier.roleArn,
        );
        this.output(
          `${TENANT_OUTPUT_PREFIXES.tenantAdminRoleArn}${pascal(tenant)}`,
          roles.tenantAdmin.roleArn,
        );
      }
      if (tenantRoles.size > 0) {
        this.output(OUTPUT_KEYS.tenantRoleTenants, [...tenantRoles.keys()].join(','));
      }
    }
    this.tenantRoles = tenantRoles;

    acknowledgeStackFindings(this, this.corpus.bucket);
    deleteLogGroupsAfterRoles(this);
  }

  private output(key: string, value: string): void {
    new cdk.CfnOutput(this, key, { value });
  }
}
