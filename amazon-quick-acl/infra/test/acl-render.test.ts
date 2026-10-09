import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AclRenderError, renderAcl } from '../lib/acl-render';

const template = readFileSync(
  resolve(__dirname, '../seed-data/acl/global-acl.template.json'),
  'utf8',
);

const valid = {
  bucketName: 'amzn-s3-demo-bucket',
  userAEmail: 'martha_rivera@example.com',
  userBEmail: 'mateo_jackson@example.com',
};

interface AclEntry {
  Name: string;
}
interface AclPrefix {
  keyPrefix: string;
  aclEntries: AclEntry[];
}

describe('renderAcl', () => {
  it('covers every seed prefix and gives each user only their documents', () => {
    const acl = JSON.parse(renderAcl(template, valid)) as AclPrefix[];
    const byPrefix = Object.fromEntries(
      acl.map((p) => [p.keyPrefix, p.aclEntries.map((e) => e.Name)]),
    );

    expect(byPrefix).toEqual({
      's3://amzn-s3-demo-bucket/shared/': [valid.userAEmail, valid.userBEmail],
      's3://amzn-s3-demo-bucket/finance/': [valid.userAEmail],
      's3://amzn-s3-demo-bucket/engineering/': [valid.userBEmail],
    });
  });

  it('trims surrounding whitespace from the configured emails', () => {
    const rendered = renderAcl(template, {
      ...valid,
      userAEmail: '  martha_rivera@example.com ',
    });
    expect(rendered).toContain('"martha_rivera@example.com"');
  });

  it('rejects a missing email', () => {
    expect(() => renderAcl(template, { ...valid, userBEmail: undefined })).toThrow(
      AclRenderError,
    );
  });

  it('rejects something that is not an email address', () => {
    expect(() =>
      renderAcl(template, { ...valid, userAEmail: 'martha_rivera' }),
    ).toThrow(/does not look like an email/);
  });

  it('rejects two emails that Bedrock would treat as one identity', () => {
    expect(() =>
      renderAcl(template, { ...valid, userBEmail: 'Martha_Rivera@example.com' }),
    ).toThrow(/same identity/);
  });

  it('refuses to emit unsubstituted placeholders', () => {
    expect(() => renderAcl('["__SOMETHING_ELSE__"]', valid)).toThrow(/Unsubstituted/);
  });
});
