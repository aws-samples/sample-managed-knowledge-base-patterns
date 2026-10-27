/** Runtime configuration written by the CDK stack to /config.json. */
export interface AppConfig {
	region: string;
	userPoolId: string;
	userPoolClientId: string;
	/** Managed login base URL, for example https://<prefix>.auth.<region>.amazoncognito.com */
	cognitoDomain: string;
	agentRuntimeArn: string;
}

const KEYS: (keyof AppConfig)[] = [
	"region",
	"userPoolId",
	"userPoolClientId",
	"cognitoDomain",
	"agentRuntimeArn",
];

export async function loadConfig(): Promise<AppConfig> {
	const response = await fetch("/config.json", { cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Failed to load /config.json (HTTP ${response.status})`);
	}
	const config: unknown = await response.json();
	for (const key of KEYS) {
		if (typeof (config as Record<string, unknown>)[key] !== "string") {
			throw new Error(`/config.json is missing "${key}"`);
		}
	}
	return config as AppConfig;
}
