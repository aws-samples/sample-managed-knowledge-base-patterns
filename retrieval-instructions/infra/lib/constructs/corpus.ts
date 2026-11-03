import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { bucketDeploymentLogGroup } from '../log-groups';

/** The 32 documents and their metadata sidecars, uploaded under docs/. */
export const CORPUS_DOCS_DIR = path.join(__dirname, '..', '..', '..', 'corpus', 'docs');
export const CORPUS_PREFIX = 'docs/';

const EXCLUDE = ['**/.DS_Store'];

/**
 * The corpus bucket and its upload. `autoDeleteObjects` empties the bucket when the
 * stack is deleted, so CloudFormation can delete it. `retainOnDelete: false` on the
 * deployment wouldn't: CDK tags the bucket as owned by the deployment, and the
 * deployment's handler skips its delete for a bucket with that tag.
 */
export class Corpus extends Construct {
  readonly bucket: s3.Bucket;
  readonly deployment: s3deploy.BucketDeployment;
  /** Changes when any corpus file changes, so a deploy starts a new ingestion job. */
  readonly fingerprint: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.deployment = new s3deploy.BucketDeployment(this, 'Deployment', {
      sources: [s3deploy.Source.asset(CORPUS_DOCS_DIR, { exclude: EXCLUDE })],
      destinationBucket: this.bucket,
      destinationKeyPrefix: CORPUS_PREFIX,
      prune: true,
      logGroup: bucketDeploymentLogGroup(this),
    });

    this.fingerprint = cdk.FileSystem.fingerprint(CORPUS_DOCS_DIR, {
      exclude: EXCLUDE,
    });
  }
}
