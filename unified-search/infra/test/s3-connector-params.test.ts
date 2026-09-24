import { describe, expect, it } from 'vitest';
import { buildS3ConnectorParameters } from '../lib/s3-connector-params';

const base = {
  bucketName: 'my-content-bucket',
  bucketOwnerAccountId: '123456789012',
};

describe('buildS3ConnectorParameters', () => {
  it('emits the managed-connector envelope fields', () => {
    const params = buildS3ConnectorParameters(base);

    expect(params.type).toBe('S3');
    expect(params.version).toBe('1');
  });

  /**
   * The managed connector takes a bucket *name*; the classic first-class S3 data
   * source takes an ARN. Passing an ARN here is a plausible mistake that would
   * only be reported at deploy time.
   */
  it('uses bucketName, not bucketArn', () => {
    const params = buildS3ConnectorParameters(base);

    expect(params.connectionConfiguration.bucketName).toBe('my-content-bucket');
    expect(params.connectionConfiguration).not.toHaveProperty('bucketArn');
  });

  /**
   * The managed S3 connector requires it for same-account and cross-account
   * buckets, so it is always populated.
   */
  it('always includes bucketOwnerAccountId', () => {
    const params = buildS3ConnectorParameters(base);

    expect(params.connectionConfiguration.bucketOwnerAccountId).toBe('123456789012');
  });

  describe('access control', () => {
    it('sets aclEnabled at the top level and the URI under aclConfiguration', () => {
      const params = buildS3ConnectorParameters({
        ...base,
        aclEnabled: true,
        globalAclS3Uri: 's3://my-content-bucket/acl/global-acl.json',
      });

      expect(params.aclEnabled).toBe(true);
      expect(params.aclConfiguration?.globalAccessControlListS3Uri).toBe(
        's3://my-content-bucket/acl/global-acl.json',
      );
    });

    /**
     * With ACL enabled, a document lacking an ACL entry is not ingested at all. So
     * enabling ACL without an ACL file produces a data source that syncs and
     * indexes nothing.
     */
    it('refuses to enable ACL without a global ACL file', () => {
      expect(() => buildS3ConnectorParameters({ ...base, aclEnabled: true })).toThrow(
        /requires globalAclS3Uri/,
      );
    });

    it('omits ACL fields entirely when disabled', () => {
      const params = buildS3ConnectorParameters(base);

      expect(params).not.toHaveProperty('aclEnabled');
      expect(params).not.toHaveProperty('aclConfiguration');
    });
  });

  describe('filters', () => {
    it('includes only the prefixes given', () => {
      const params = buildS3ConnectorParameters({
        ...base,
        inclusionPrefixes: ['content/'],
      });

      expect(params.filterConfiguration?.inclusionPrefixes).toEqual(['content/']);
    });

    it('omits filterConfiguration when no filters are set', () => {
      expect(buildS3ConnectorParameters(base)).not.toHaveProperty(
        'filterConfiguration',
      );
    });

    it('keeps maxFileSizeInMegaBytes a string', () => {
      const params = buildS3ConnectorParameters({
        ...base,
        maxFileSizeInMegaBytes: '500',
      });

      // The connector parameter is a numeric string, not a number.
      expect(params.filterConfiguration?.maxFileSizeInMegaBytes).toBe('500');
      expect(typeof params.filterConfiguration?.maxFileSizeInMegaBytes).toBe('string');
    });
  });
});
