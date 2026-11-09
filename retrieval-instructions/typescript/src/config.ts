/**
 * AWS clients. The Region is AWS_REGION when set, else us-east-1. Creating the clients makes no
 * network call. Credentials come from the default chain (AWS_PROFILE, environment variables, and
 * so on).
 */

import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { STSClient } from '@aws-sdk/client-sts';

// One stream call can run for a minute or more. Standard retries cover throttling on the initial
// request. requestTimeout is the socket idle timeout, the same meaning as botocore's read_timeout.
export const RUNTIME_CONFIG = {
  maxAttempts: 5,
  retryMode: 'standard',
  requestHandler: { requestTimeout: 120_000 },
} as const;

export const region = process.env.AWS_REGION ?? 'us-east-1';
export const agent = new BedrockAgentClient({ region }); // retrieval instructions
export const runtime = new BedrockAgentRuntimeClient({ region, ...RUNTIME_CONFIG }); // AgenticRetrieveStream
export const sts = new STSClient({ region });
export const cloudformation = new CloudFormationClient({ region });
export const cloudtrail = new CloudTrailClient({ region });
