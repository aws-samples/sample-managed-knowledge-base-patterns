/**
 * Typed builder for the Amazon S3 managed-connector `connectorParameters`.
 *
 * CloudFormation types `ConnectorParameters` as raw `Json`, and CDK surfaces it
 * as `any`. That means a misspelled field is accepted at synth and only reported
 * when CloudFormation calls `CreateDataSource` during deployment. These interfaces
 * move that check to compile time.
 *
 * Field names are easy to get wrong; the ones below match the connector's parameter
 * schema:
 *
 * - `bucketName`, **not** `bucketArn`. The classic first-class S3 data source
 *   takes an ARN; the managed connector envelope takes a bare name.
 * - `aclConfiguration`, not `accessControlConfiguration`.
 * - `maxFileSizeInMegaBytes` is a **string**, not a number.
 * - `aclEnabled` is top-level, not nested under `aclConfiguration`.
 */

export interface S3ConnectionConfiguration {
  readonly bucketName: string;

  /**
   * Owning account of the bucket.
   *
   * The managed S3 connector requires it for same-account and cross-account
   * buckets, so it is always populated here.
   */
  readonly bucketOwnerAccountId: string;
}

export interface S3FilterConfiguration {
  readonly inclusionPrefixes?: readonly string[];
  readonly exclusionPrefixes?: readonly string[];
  readonly inclusionPatterns?: readonly string[];
  readonly exclusionPatterns?: readonly string[];
  /** Numeric string, e.g. `'500'`. Defaults to `'500'` service-side. */
  readonly maxFileSizeInMegaBytes?: string;
}

export interface S3AclConfiguration {
  /**
   * S3 URI of a JSON file mapping key prefixes to access control entries.
   *
   * Must live in the **same bucket** as the content it governs.
   */
  readonly globalAccessControlListS3Uri: string;
}

export interface S3ConnectorParameters {
  readonly type: 'S3';
  readonly version: '1';
  readonly connectionConfiguration: S3ConnectionConfiguration;
  readonly filterConfiguration?: S3FilterConfiguration;

  /**
   * Enables document-level access control.
   *
   * **Cannot be changed after the data source is created.** Turning it on later
   * means replacing the data source and re-ingesting.
   *
   * When enabled, a document with no matching ACL entry is *not ingested at all*
   * — not merely hidden. Every object under a crawled prefix therefore needs
   * coverage in the global ACL file or its own `.metadata.json` sidecar.
   */
  readonly aclEnabled?: boolean;

  /** Required when `aclEnabled` is true; ignored otherwise. */
  readonly aclConfiguration?: S3AclConfiguration;

  /** Prefix holding `.metadata.json` sidecar files. */
  readonly metadataFilesPrefix?: string;
}

export interface BuildS3ConnectorParamsOptions {
  readonly bucketName: string;
  readonly bucketOwnerAccountId: string;
  readonly aclEnabled?: boolean;
  readonly globalAclS3Uri?: string;
  readonly inclusionPrefixes?: readonly string[];
  readonly exclusionPrefixes?: readonly string[];
  readonly maxFileSizeInMegaBytes?: string;
}

/**
 * Builds the connector parameters, rejecting internally inconsistent input.
 *
 * @throws {Error} if ACL is enabled without a global ACL file URI. The data
 * source would be created and then index nothing, since with ACL enabled a
 * document lacking an ACL entry is not ingested.
 */
export function buildS3ConnectorParameters(
  options: BuildS3ConnectorParamsOptions,
): S3ConnectorParameters {
  const aclEnabled = options.aclEnabled ?? false;

  if (aclEnabled && (options.globalAclS3Uri ?? '') === '') {
    throw new Error(
      'aclEnabled requires globalAclS3Uri. Without an ACL file no document has an ' +
        'ACL entry, and documents without one are not ingested — the data source ' +
        'would sync successfully and index nothing.',
    );
  }

  const filterConfiguration: S3FilterConfiguration = {
    ...(options.inclusionPrefixes
      ? { inclusionPrefixes: options.inclusionPrefixes }
      : {}),
    ...(options.exclusionPrefixes
      ? { exclusionPrefixes: options.exclusionPrefixes }
      : {}),
    ...(options.maxFileSizeInMegaBytes
      ? { maxFileSizeInMegaBytes: options.maxFileSizeInMegaBytes }
      : {}),
  };

  return {
    type: 'S3',
    version: '1',
    connectionConfiguration: {
      bucketName: options.bucketName,
      bucketOwnerAccountId: options.bucketOwnerAccountId,
    },
    ...(Object.keys(filterConfiguration).length > 0 ? { filterConfiguration } : {}),
    ...(aclEnabled
      ? {
          aclEnabled: true,
          aclConfiguration: { globalAccessControlListS3Uri: options.globalAclS3Uri! },
        }
      : {}),
  };
}
