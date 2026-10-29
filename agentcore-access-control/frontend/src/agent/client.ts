import type { AppConfig } from "../config";
import { type AgentEvent, SseParser } from "./events";

export interface InvokeOptions {
	prompt: string;
	/** Runtime session ID: at least 33 characters. */
	sessionId: string;
	/** The user's Cognito access token. The runtime validates it. */
	accessToken: string;
	onEvent: (event: AgentEvent) => void;
	signal?: AbortSignal;
}

/**
 * Invoke the agent through the AgentCore Runtime HTTPS endpoint. With OAuth
 * inbound authorization, the runtime is called with the bearer token
 * instead of AWS Signature Version 4.
 */
export async function invokeAgent(
	config: AppConfig,
	options: InvokeOptions,
): Promise<void> {
	const arn = encodeURIComponent(config.agentRuntimeArn);
	const url = `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/${arn}/invocations?qualifier=DEFAULT`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${options.accessToken}`,
			"Content-Type": "application/json",
			"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": options.sessionId,
		},
		body: JSON.stringify({ prompt: options.prompt }),
		signal: options.signal,
	});
	if (!response.ok || !response.body) {
		throw new Error(
			`The agent returned HTTP ${response.status}: ${await response.text()}`,
		);
	}

	const parser = new SseParser();
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		parser.push(value).forEach(options.onEvent);
	}
	parser.flush().forEach(options.onEvent);
}
