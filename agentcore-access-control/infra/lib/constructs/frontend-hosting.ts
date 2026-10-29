import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { viteAppBundling } from "./bundling";

export interface FrontendHostingProps {
	/** Origins that the app may connect to (Cognito and AgentCore). */
	readonly connectSources: string[];
}

/** Runtime configuration of the web app, served as /config.json. */
export interface FrontendConfig {
	readonly region: string;
	readonly userPoolId: string;
	readonly userPoolClientId: string;
	readonly cognitoDomain: string;
	readonly agentRuntimeArn: string;
}

/**
 * Private S3 bucket behind CloudFront with origin access control. The
 * distribution is created first so that its URL can be registered as the
 * Cognito callback URL. The app itself is deployed later with `deploy()`.
 */
export class FrontendHosting extends Construct {
	readonly bucket: s3.Bucket;
	readonly distribution: cloudfront.Distribution;

	constructor(scope: Construct, id: string, props: FrontendHostingProps) {
		super(scope, id);

		this.bucket = new s3.Bucket(this, "Bucket", {
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			encryption: s3.BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		const contentSecurityPolicy = [
			"default-src 'self'",
			"script-src 'self'",
			// Cloudscape components set inline styles.
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data:",
			"font-src 'self' data:",
			`connect-src 'self' ${props.connectSources.join(" ")}`,
			"object-src 'none'",
			"base-uri 'self'",
			"form-action 'self'",
			"frame-ancestors 'none'",
		].join("; ");
		const securityHeaders = new cloudfront.ResponseHeadersPolicy(
			this,
			"SecurityHeaders",
			{
				// The generated name starts with the stack name, and CloudFront
				// reserves the "Managed" prefix for AWS managed policies.
				responseHeadersPolicyName: `SecurityHeaders-${cdk.Names.uniqueId(this).slice(-8)}`,
				securityHeadersBehavior: {
					contentSecurityPolicy: { contentSecurityPolicy, override: true },
					strictTransportSecurity: {
						accessControlMaxAge: cdk.Duration.days(365),
						includeSubdomains: true,
						override: true,
					},
					contentTypeOptions: { override: true },
					frameOptions: {
						frameOption: cloudfront.HeadersFrameOption.DENY,
						override: true,
					},
					referrerPolicy: {
						referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
						override: true,
					},
				},
			},
		);

		this.distribution = new cloudfront.Distribution(this, "Distribution", {
			comment: "Managed KB ACL sample web app",
			defaultRootObject: "index.html",
			defaultBehavior: {
				origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
				viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
				responseHeadersPolicy: securityHeaders,
			},
			priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
		});
	}

	/** HTTPS origin of the web app, without a trailing slash. */
	get url(): string {
		return `https://${this.distribution.distributionDomainName}`;
	}

	/** Build the app and publish it with its runtime configuration. */
	deploy(appPath: string, config: FrontendConfig): void {
		new s3deploy.BucketDeployment(this, "Deployment", {
			sources: [
				s3deploy.Source.asset(appPath, {
					bundling: viteAppBundling(appPath),
					exclude: ["node_modules", "dist", "coverage", "public/config.json"],
				}),
				s3deploy.Source.jsonData("config.json", config),
			],
			destinationBucket: this.bucket,
			cacheControl: [s3deploy.CacheControl.noCache()],
			distribution: this.distribution,
			distributionPaths: ["/*"],
		});
	}
}
