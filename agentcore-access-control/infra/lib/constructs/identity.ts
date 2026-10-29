import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { LOCAL_ARTIFACTS } from "./bundling";
import { JwtAuthorizerConfig } from "./kb-mcp-gateway";

export interface IdentityProps {
	/** Prefix of the Cognito domain for managed login. */
	readonly domainPrefix: string;
	/** Allowed sign-in callback and sign-out URLs of the web app. */
	readonly callbackUrls: string[];
	/** Emails of the demo users. They must match the document ACLs. */
	readonly demoUserEmails: string[];
}

/**
 * Amazon Cognito user pool that stands in for the corporate identity
 * provider. A pre token generation trigger adds the verified email to the
 * access token, which the gateway interceptor and the Cedar policies read.
 */
export class Identity extends Construct {
	readonly userPool: cognito.UserPool;
	readonly webClient: cognito.UserPoolClient;
	readonly domain: cognito.UserPoolDomain;
	readonly demoUserPassword: secretsmanager.Secret;

	constructor(scope: Construct, id: string, props: IdentityProps) {
		super(scope, id);

		// Access token customization requires the Essentials feature plan.
		// The email is immutable and users cannot sign themselves up, because
		// ACL awareness matches users by exact email.
		this.userPool = new cognito.UserPool(this, "UserPool", {
			featurePlan: cognito.FeaturePlan.ESSENTIALS,
			selfSignUpEnabled: false,
			signInAliases: { email: true },
			standardAttributes: { email: { required: true, mutable: false } },
			passwordPolicy: {
				minLength: 12,
				requireLowercase: true,
				requireUppercase: true,
				requireDigits: true,
				requireSymbols: true,
			},
			accountRecovery: cognito.AccountRecovery.NONE,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		const preTokenGeneration = new lambda.Function(this, "PreTokenGeneration", {
			description: "Adds the verified email to the access token",
			runtime: lambda.Runtime.PYTHON_3_14,
			architecture: lambda.Architecture.ARM_64,
			handler: "pre_token_generation.handler",
			code: lambda.Code.fromAsset(
				path.join(__dirname, "..", "..", "functions", "pre_token_generation"),
				{ exclude: LOCAL_ARTIFACTS },
			),
			timeout: cdk.Duration.seconds(5),
			logGroup: new logs.LogGroup(this, "PreTokenGenerationLogs", {
				retention: logs.RetentionDays.ONE_MONTH,
				removalPolicy: cdk.RemovalPolicy.DESTROY,
			}),
		});
		this.userPool.addTrigger(
			cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
			preTokenGeneration,
			cognito.LambdaVersion.V2_0,
		);

		this.domain = this.userPool.addDomain("Domain", {
			cognitoDomain: { domainPrefix: props.domainPrefix },
			managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
		});

		// Public client for the single-page app: authorization code flow with
		// PKCE and no client secret. ADMIN_USER_PASSWORD_AUTH lets the
		// verification script sign in with IAM credentials; it cannot be used
		// without cognito-idp:AdminInitiateAuth permission.
		this.webClient = this.userPool.addClient("WebClient", {
			generateSecret: false,
			authFlows: { adminUserPassword: true },
			oAuth: {
				flows: { authorizationCodeGrant: true },
				scopes: [
					cognito.OAuthScope.OPENID,
					cognito.OAuthScope.EMAIL,
					cognito.OAuthScope.PROFILE,
				],
				callbackUrls: props.callbackUrls,
				logoutUrls: props.callbackUrls,
			},
			supportedIdentityProviders: [
				cognito.UserPoolClientIdentityProvider.COGNITO,
			],
			preventUserExistenceErrors: true,
			accessTokenValidity: cdk.Duration.hours(1),
			idTokenValidity: cdk.Duration.hours(1),
			refreshTokenValidity: cdk.Duration.hours(12),
		});

		new cognito.CfnManagedLoginBranding(this, "ManagedLoginBranding", {
			userPoolId: this.userPool.userPoolId,
			clientId: this.webClient.userPoolClientId,
			useCognitoProvidedValues: true,
		});

		this.demoUserPassword = this.createDemoUsers(props.demoUserEmails);
	}

	/** Issuer discovery URL and client ID for the JWT authorizers. */
	get jwtAuthorizer(): JwtAuthorizerConfig {
		const { region } = cdk.Stack.of(this);
		return {
			discoveryUrl: `https://cognito-idp.${region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/openid-configuration`,
			allowedClients: [this.webClient.userPoolClientId],
		};
	}

	/**
	 * Create the demo users with verified emails and one generated password
	 * stored in AWS Secrets Manager. The password never appears in the
	 * template, the stack events, the logs, or the repository.
	 */
	private createDemoUsers(emails: string[]): secretsmanager.Secret {
		const secret = new secretsmanager.Secret(this, "DemoUserPassword", {
			description: "Password of the demo users of the Managed KB ACL sample",
			generateSecretString: {
				passwordLength: 20,
				requireEachIncludedType: true,
				excludeCharacters: "\"'\\`",
			},
		});

		const users = emails.map(
			(email, index) =>
				new cognito.CfnUserPoolUser(this, `DemoUser${index}`, {
					userPoolId: this.userPool.userPoolId,
					username: email,
					userAttributes: [
						{ name: "email", value: email },
						{ name: "email_verified", value: "true" },
					],
					messageAction: "SUPPRESS",
				}),
		);

		// CloudFormation does not resolve secure dynamic references inside
		// custom resource properties, and any resolved value would appear in
		// the stack events and in the provider logs. The function reads the
		// secret itself, so only its ARN is a property.
		const setPassword = new lambda.Function(this, "SetDemoUserPassword", {
			description: "Sets the password of the demo users from the secret",
			runtime: lambda.Runtime.PYTHON_3_14,
			architecture: lambda.Architecture.ARM_64,
			handler: "demo_user_password.handler",
			code: lambda.Code.fromAsset(
				path.join(__dirname, "..", "..", "functions", "demo_user_password"),
				{ exclude: LOCAL_ARTIFACTS },
			),
			timeout: cdk.Duration.seconds(30),
			logGroup: new logs.LogGroup(this, "SetDemoUserPasswordLogs", {
				retention: logs.RetentionDays.ONE_MONTH,
				removalPolicy: cdk.RemovalPolicy.DESTROY,
			}),
		});
		secret.grantRead(setPassword);
		setPassword.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ["cognito-idp:AdminSetUserPassword"],
				resources: [this.userPool.userPoolArn],
			}),
		);
		const provider = new cr.Provider(this, "DemoUserPasswordProvider", {
			onEventHandler: setPassword,
			logGroup: new logs.LogGroup(this, "DemoUserPasswordProviderLogs", {
				retention: logs.RetentionDays.ONE_MONTH,
				removalPolicy: cdk.RemovalPolicy.DESTROY,
			}),
		});
		const password = new cdk.CustomResource(this, "DemoUserPasswordSetting", {
			serviceToken: provider.serviceToken,
			resourceType: "Custom::DemoUserPassword",
			properties: {
				SecretArn: secret.secretArn,
				UserPoolId: this.userPool.userPoolId,
				Usernames: emails,
			},
		});
		for (const user of users) {
			password.node.addDependency(user);
		}
		return secret;
	}
}
