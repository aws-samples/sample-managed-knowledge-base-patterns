import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { IdentityStack } from '../lib/identity-stack';

/**
 * Email is the ACL join key: Bedrock matches document permissions on the email in the
 * verified token, exactly. That makes the user pool's email handling part of the access
 * control story rather than a detail of it, so the settings that bear on it are asserted
 * rather than left to defaults.
 */
function synth(props: { appOrigins?: readonly string[] } = {}): Template {
  const app = new cdk.App();
  const stack = new IdentityStack(app, 'TestIdentity', {
    stageName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return Template.fromStack(stack);
}

describe('IdentityStack', () => {
  it('provisions a user pool, a client, and a hosted UI domain', () => {
    const template = synth();

    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    // Without a domain there is no hosted UI, and no way to sign in at all.
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  /**
   * The setting with the largest blast radius.
   *
   * With self-service sign-up enabled, anyone who can reach the hosted UI can create an
   * account against a corpus with document-level permissions.
   */
  it('disables self-service sign-up', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });

  it('requires email and makes it immutable', () => {
    const template = synth();

    // A mutable email is a mutable authorization identity: changing it changes which
    // documents the user retrieves, with no trace in the retrieval path.
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'email', Required: true, Mutable: false }),
      ]),
    });
  });

  it('signs in by email, case-insensitively', () => {
    const template = synth();

    // A case difference between the token and a data source's access entry returns
    // nothing, so two identities differing only by case must not both exist.
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
    });
  });

  it('auto-verifies email, which the backend requires', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPool', {
      AutoVerifiedAttributes: ['email'],
    });
  });

  it('enforces a password policy of at least 12 characters with all four classes', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      },
    });
  });

  describe('the app client', () => {
    it('is a public client with no secret', () => {
      const template = synth();
      const clients = template.findResources('AWS::Cognito::UserPoolClient');
      const [client] = Object.values(clients);

      // A browser application cannot keep a secret; PKCE authenticates the exchange.
      expect(client?.Properties).not.toHaveProperty('GenerateSecret', true);
    });

    it('allows only the authorization code grant', () => {
      const template = synth();

      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        AllowedOAuthFlows: ['code'],
      });

      // The implicit flow returns tokens in the URL fragment, which puts them in browser
      // history and referrer headers.
      const clients = JSON.stringify(
        template.findResources('AWS::Cognito::UserPoolClient'),
      );
      expect(clients).not.toContain('implicit');
    });

    it('requests the openid and email scopes', () => {
      const template = synth();
      const clients = template.findResources('AWS::Cognito::UserPoolClient');
      const scopes = (
        Object.values(clients)[0]?.Properties as { AllowedOAuthScopes?: string[] }
      ).AllowedOAuthScopes;

      // Without `email` the ID token has no email claim, and a token with no email
      // retrieves nothing from any ACL-enabled source — which fails safe and reads
      // exactly like an empty index.
      expect(scopes).toEqual(expect.arrayContaining(['openid', 'email']));
    });

    /**
     * The admin flow is the deliberate exception, pinned so it cannot drift either way.
     *
     * `AdminInitiateAuth` requires AWS credentials carrying
     * `cognito-idp:AdminInitiateAuth`, which an end user does not have. It exists so the
     * end-to-end verification can obtain a real token without driving a browser — without
     * it that check needs a human, and so would not be run.
     */
    it('enables the admin password flow, which IAM gates rather than the public', () => {
      synth().hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ExplicitAuthFlows: Match.arrayWith(['ALLOW_ADMIN_USER_PASSWORD_AUTH']),
      });
    });

    it('enables no authentication flow reachable without AWS credentials', () => {
      const template = synth();
      const clients = JSON.stringify(
        template.findResources('AWS::Cognito::UserPoolClient'),
      );

      // The client ID is public — it appears in every authorization redirect — so a
      // password or SRP flow would let anyone holding it authenticate straight against
      // the Cognito API, bypassing the hosted UI and anything configured on it.
      for (const flow of [
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
        'ALLOW_CUSTOM_AUTH',
      ]) {
        expect(clients, flow).not.toContain(flow);
      }
    });

    it('does not disclose whether an address is registered', () => {
      synth().hasResourceProperties('AWS::Cognito::UserPoolClient', {
        PreventUserExistenceErrors: 'ENABLED',
      });
    });

    it('derives both callback and sign-out URLs from each origin', () => {
      const template = synth({
        appOrigins: ['https://app.example.test', 'http://localhost:5173'],
      });

      // Configured as origins rather than full URLs, so the two forms cannot drift.
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        CallbackURLs: [
          'https://app.example.test/callback',
          'http://localhost:5173/callback',
        ],
        LogoutURLs: ['https://app.example.test/', 'http://localhost:5173/'],
      });
    });

    it('tolerates a trailing slash on a configured origin', () => {
      synth({ appOrigins: ['https://app.example.test/'] }).hasResourceProperties(
        'AWS::Cognito::UserPoolClient',
        { CallbackURLs: ['https://app.example.test/callback'] },
      );
    });

    it('rejects an empty origin list at synth time', () => {
      expect(() => synth({ appOrigins: [] })).toThrow(/at least one origin/);
    });
  });

  it('outputs the identifiers the two .env files need', () => {
    const outputs = Object.keys(synth().toJSON().Outputs ?? {});

    expect(outputs).toEqual(
      expect.arrayContaining(['UserPoolId', 'UserPoolClientId', 'HostedUiDomain']),
    );
  });
});
