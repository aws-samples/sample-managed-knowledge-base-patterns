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
 * The corpus bucket and its upload. The deployment deletes the objects it put under
 * docs/ when the stack is deleted (retainOnDelete false), so the bucket is empty when
 * CloudFormation deletes it, without the extra auto-delete handler.
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
    });

    this.deployment = new s3deploy.BucketDeployment(this, 'Deployment', {
      sources: [s3deploy.Source.asset(CORPUS_DOCS_DIR, { exclude: EXCLUDE })],
      destinationBucket: this.bucket,
      destinationKeyPrefix: CORPUS_PREFIX,
      prune: true,
      retainOnDelete: false,
      logGroup: bucketDeploymentLogGroup(this),
    });

    this.fingerprint = cdk.FileSystem.fingerprint(CORPUS_DOCS_DIR, {
      exclude: EXCLUDE,
    });
  }
}
