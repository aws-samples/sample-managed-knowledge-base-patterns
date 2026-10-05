/**
 * Entry point for the local embed-URL harness. See harness.ts for why this is a local
 * development tool and not a deployable backend.
 */

import { createServer } from 'node:http';
import { config as loadDotenv } from 'dotenv';
import {
  GenerateEmbedUrlForRegisteredUserCommand,
  QuickSightClient,
} from '@aws-sdk/client-quicksight';
import { ConfigError, loadConfig, type HarnessConfig } from './config.ts';
import { createHarnessHandler } from './harness.ts';

loadDotenv({ quiet: true });

let config: HarnessConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// Region only. Credentials come from the standard AWS credential chain: your shell
// during development, an execution role in a deployed service.
const quicksight = new QuickSightClient({ region: config.region });

const handler = createHarnessHandler(
  config,
  async (userArn) => {
    const response = await quicksight.send(
      new GenerateEmbedUrlForRegisteredUserCommand({
        AwsAccountId: config.accountId,
        UserArn: userArn,
        // RegisteredUserQuickChatEmbeddingConfiguration takes no fields. Which agent and
        // which knowledge bases are in play is decided by the Quick space the user has
        // access to, not by this call.
        ExperienceConfiguration: { QuickChat: {} },
        AllowedDomains: [config.allowedDomain],
        SessionLifetimeInMinutes: config.sessionLifetimeMinutes,
      }),
    );
    if (!response.EmbedUrl) throw new Error('Response contained no EmbedUrl');
    return response.EmbedUrl;
  },
  (message) => console.error(message),
);

createServer(handler).listen(config.port, '127.0.0.1', () => {
  console.log(`Embed URL harness listening on http://127.0.0.1:${config.port}`);
  console.log(`  account: ${config.accountId}   region: ${config.region}`);
  console.log(`  allowed embed origin: ${config.allowedDomain}`);
  if (config.fixedAgentId) console.log(`  locked to agent: ${config.fixedAgentId}`);
});
