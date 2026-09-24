#!/usr/bin/env tsx
/**
 * Creates the sample sign-in accounts in the Cognito user pool.
 *
 * The identities come from `lib/seed-acl.ts`, the same constants the document access
 * lists and the ACL test suite use. A user who can sign in but is named in no access
 * entry retrieves nothing, so restating the addresses here would let the two drift
 * and leave a signed-in user with an empty search page.
 *
 * A script rather than CDK: a `CfnUserPoolUser` does not set a permanent password. It
 * leaves the account in `FORCE_CHANGE_PASSWORD`, and completing that through the hosted
 * UI needs an email, which these reserved addresses cannot receive. This script sets a
 * permanent password with `AdminSetUserPassword` instead.
 *
 *   npm run seed:users -- --stage dev
 *   npm run seed:users -- --stage dev --password 'MyOwnPassw0rd!'
 */
import { randomBytes } from 'node:crypto';

import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

import { CONTENT_PREFIX, SEED_ACL, SEED_USERS } from '../lib/seed-acl';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const cloudformation = new CloudFormationClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

async function stackOutput(stackName: string, key: string): Promise<string> {
  const response = await cloudformation.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const value = (response.Stacks?.[0]?.Outputs ?? []).find(
    (output) => output.OutputKey === key,
  )?.OutputValue;

  if (value === undefined || value === '') {
    throw new Error(
      `Stack ${stackName} has no ${key} output. Deploy the identity stack first:\n` +
        '  make sample-deploy IDENTITY=true',
    );
  }
  return value;
}

/**
 * A password satisfying the pool's policy: 12+ characters with all four classes.
 *
 * Generated rather than defaulted to a literal, so a deployment left running does not
 * have a password that is also written down in this repository. Printed once, and not
 * stored anywhere — which is stated in the output, because an operator who loses it needs
 * to know the recovery path is to re-run this command.
 */
function generatePassword(): string {
  const body = randomBytes(12)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, '');
  return `Aa1!${body}`;
}

async function main(): Promise<void> {
  const stage = arg('stage', 'dev') ?? 'dev';
  const stackName = arg('stack', `UnifiedSearch-${stage}-Identity`) ?? '';
  const userPoolId = await stackOutput(stackName, 'UserPoolId');

  const supplied = arg('password');
  const password = supplied ?? generatePassword();

  process.stdout.write(`Seeding users into ${userPoolId} (${REGION})\n\n`);

  for (const email of Object.values(SEED_USERS)) {
    try {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            // Set explicitly. The backend rejects a token whose `email_verified` is not
            // true, and these reserved addresses can never receive a verification code,
            // so an unverified account here could never sign in at all.
            { Name: 'email_verified', Value: 'true' },
          ],
          // No invitation email: the addresses are unroutable by design.
          MessageAction: 'SUPPRESS',
        }),
      );
      process.stdout.write(`  created  ${email}\n`);
    } catch (error) {
      if (!(error instanceof UsernameExistsException)) throw error;
      // Idempotent: re-running resets the password rather than failing, which is what an
      // operator who has lost it actually wants.
      await cognito.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
        }),
      );
      process.stdout.write(`  exists   ${email}\n`);
    }

    // Permanent, so the account is immediately usable. A temporary password forces a
    // change through the hosted UI, which needs a deliverable email address.
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
  }

  process.stdout.write(
    '\nSign in with any of the addresses above and this password:\n\n',
  );
  process.stdout.write(`  ${password}\n\n`);

  if (supplied === undefined) {
    process.stdout.write(
      'Generated, printed once, and stored nowhere. Re-run this command to set a new\n' +
        'one, or pass --password to choose your own.\n\n',
    );
  }

  // Derived from SEED_ACL rather than restated, so this listing cannot drift from the
  // access control entries that were actually uploaded.
  process.stdout.write(
    'What each account can see, per the seeded access control entries:\n',
  );
  for (const email of Object.values(SEED_USERS)) {
    const departments = SEED_ACL.filter((entry) => entry.allow.includes(email)).map(
      (entry) => entry.prefix.slice(CONTENT_PREFIX.length).replace(/\/$/, ''),
    );
    const access =
      departments.length > 0
        ? `${departments.join(', ')} documents`
        : 'nothing — named in no entry';
    process.stdout.write(`  ${email.padEnd(30)} ${access}\n`);
  }
  process.stdout.write(
    `\n${SEED_USERS.outsider} can sign in but sees no results. That is expected:\n` +
      'authentication and authorization are separate.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
