import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

export interface IdentityStackProps extends cdk.StackProps {
  readonly stageName: string;

  /**
   * Origins the frontend is served from, without a trailing slash.
   *
   * The UI derives its callback and sign-out URLs from the browser's own origin
   * (`<origin>/callback` and `<origin>/`), so only the origins are configured here and
   * the two URL forms are built from them. Configuring the full URLs separately lets
   * them drift apart, and Cognito requires the redirect URL to match a registered
   * callback URL exactly.
   */
  readonly appOrigins?: readonly string[];
}

/**
 * A Cognito user pool for signing in to the sample.
 *
 * Optional, like conversation memory: `-c identity=true`. A `byo` operator almost
 * certainly has an identity provider already, and this exists so the sample can be
 * evaluated end to end from a clean account. Search and chat require a verified
 * token, so this gives an evaluator a way to sign in without bringing their own
 * identity provider.
 *
 * ## Why the pool is configured the way it is
 *
 * Email is the ACL join key. Bedrock matches document permissions on the email in the
 * verified token, exactly, with no alias resolution — so the pool's email handling *is*
 * the access control story, not a detail of it. Three settings follow from that and are
 * worth stating rather than leaving to defaults:
 *
 * 1. **Self-service sign-up is disabled.** With it enabled, anyone who can reach the
 *    hosted UI can create an account. The backend additionally requires
 *    `email_verified`, so an attacker cannot simply claim a colleague's address — but
 *    "the second check saves us" is a poor reason to leave the first one off, and a
 *    sample should not ship a pool the internet can register with. Users are seeded
 *    deliberately instead.
 * 2. **Email is required and immutable.** A mutable email is a mutable authorization
 *    identity: changing it silently changes which documents the user can retrieve, with
 *    no trace in the retrieval path.
 * 3. **Only the authorization code grant.** The implicit flow returns tokens in the URL
 *    fragment, which puts them in browser history and referrer headers.
 */
export class IdentityStack extends cdk.Stack {
  /** Pass to the backend as `COGNITO_USER_POOL_ID`. */
  readonly userPoolId: string;

  /** Pass to the backend as `COGNITO_CLIENT_ID` and the UI as `VITE_COGNITO_CLIENT_ID`. */
  readonly userPoolClientId: string;

  /** Pass to the UI as `VITE_COGNITO_DOMAIN`. */
  readonly hostedUiDomain: string;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    const origins = (props.appOrigins ?? ['http://localhost:5173']).map((origin) =>
      origin.replace(/\/$/, ''),
    );
    if (origins.length === 0) {
      throw new Error('appOrigins must contain at least one origin.');
    }

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `unified-search-${props.stageName}`,

      // See the class comment: an open pool is an open door to a permissioned corpus.
      selfSignUpEnabled: false,

      signInAliases: { email: true, username: false },
      // Email is the ACL join key, so a case difference must not create a second
      // identity that resolves to different documents.
      signInCaseSensitive: false,

      standardAttributes: {
        email: { required: true, mutable: false },
      },

      // Cognito sets `email_verified` when it sends and the user completes the code
      // flow. The backend rejects a token whose `email_verified` is not true.
      autoVerify: { email: true },

      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },

      // Optional rather than required, so the sample can be evaluated without setting up
      // an authenticator app. Available, and named here so the choice is visible rather
      // than absent.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },

      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // Destroyed with the sample. A real deployment wants RETAIN, and would not be
      // using this stack at all.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * Two cdk-nag findings, both acknowledged deliberately.
     *
     * `COG8` wants the Plus feature plan, which is a paid tier providing threat
     * protection and compromised-credential detection. `COG2` wants MFA required rather
     * than optional.
     *
     * Both are right for a production pool and wrong for this one. This pool exists so
     * an evaluator can sign in to a sample holding three synthetic documents; a real
     * deployment uses its own identity provider through `byo` mode and never instantiates
     * this stack. Optional MFA keeps the sample quick to evaluate without enrolling an
     * authenticator, and staying on the default tier keeps the cost of trying the sample
     * predictable.
     *
     * They are acknowledged rather than suppressed silently so that the record shows the
     * decision was taken, and so anyone adapting this stack for real use sees exactly
     * which two things to turn on first.
     */
    cdk.Validations.of(userPool).acknowledge({
      id: 'AwsSolutions-COG8',
      reason:
        'The Plus feature plan is a paid tier. This pool holds synthetic sample accounts ' +
        'only; a real deployment uses its own identity provider through byo mode rather ' +
        'than this stack. Enable it for any pool holding real users.',
    });
    cdk.Validations.of(userPool).acknowledge({
      id: 'AwsSolutions-COG2',
      reason:
        'MFA is available and set to OPTIONAL with TOTP, rather than required, so the ' +
        'sample can be evaluated without enrolling an authenticator. Require it for any ' +
        'pool holding real users.',
    });

    const client = userPool.addClient('WebClient', {
      userPoolClientName: `unified-search-${props.stageName}-web`,

      // A browser application is a public client and cannot keep a secret. PKCE
      // authenticates the token exchange instead, which the UI implements.
      generateSecret: false,

      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          // Returns tokens in the URL fragment: browser history, referrer headers.
          implicitCodeGrant: false,
          clientCredentials: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          // Without this the ID token carries no email claim, and a token with no email
          // retrieves nothing from any ACL-enabled data source — which fails safe and
          // reads exactly like an empty index.
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: origins.map((origin) => `${origin}/callback`),
        logoutUrls: origins.map((origin) => `${origin}/`),
      },

      // Do not disclose whether an address is registered. Otherwise the sign-in form is
      // an oracle for which colleagues have accounts.
      preventUserExistenceErrors: true,

      // The UI holds no refresh token — the ID token lives in memory and a reload
      // re-authenticates against Cognito's session cookie. Kept short so a leaked token
      // is short-lived, and revocation is enabled so sign-out can be made to stick.
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
      enableTokenRevocation: true,

      authFlows: {
        /**
         * Human sign-in goes through the hosted UI, so every flow reachable *without*
         * AWS credentials is off. `userPassword` and `userSrp` in particular would let
         * anyone holding the client ID — which is public, it appears in every redirect —
         * authenticate straight against the Cognito API, bypassing the hosted UI and
         * anything configured on it.
         */
        user: false,
        userPassword: false,
        userSrp: false,
        custom: false,

        /**
         * `adminUserPassword` is on, and it is a deliberate exception worth justifying.
         *
         * It is the only way to obtain a real token without driving a browser, which is
         * what makes the end-to-end verification in `make test-e2e` possible — signing in
         * as two seeded users and confirming through the full HTTP stack that they get
         * different documents. Without it that check needs a human and a browser, so in
         * practice it would not be run.
         *
         * The risk profile is materially different from the flows above: `AdminInitiateAuth`
         * requires AWS credentials carrying `cognito-idp:AdminInitiateAuth`. An end user
         * has none, so this is not a path into the application — it is an administrative
         * capability governed by IAM, like the ACL diagnostics CLI.
         *
         * Turn it off in a pool holding real users unless something needs it.
         */
        adminUserPassword: true,
      },
    });

    // A hosted UI needs a domain. Domain prefixes must be unique within a Region, so the
    // account ID is included in the prefix.
    const domain = userPool.addDomain('HostedUi', {
      cognitoDomain: {
        domainPrefix: `unified-search-${props.stageName}-${this.account}`,
      },
    });

    this.userPoolId = userPool.userPoolId;
    this.userPoolClientId = client.userPoolClientId;
    this.hostedUiDomain = `${domain.domainName}.auth.${this.region}.amazoncognito.com`;

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Set as COGNITO_USER_POOL_ID on the backend',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: client.userPoolClientId,
      description:
        'Set as COGNITO_CLIENT_ID on the backend and VITE_COGNITO_CLIENT_ID in the UI',
    });
    new cdk.CfnOutput(this, 'HostedUiDomain', {
      value: this.hostedUiDomain,
      description: 'Set as VITE_COGNITO_DOMAIN in the UI',
    });
    new cdk.CfnOutput(this, 'CallbackUrls', {
      value: origins.map((origin) => `${origin}/callback`).join(','),
      description:
        'Registered callback URLs. The UI must be served from one of these origins',
    });
  }
}
