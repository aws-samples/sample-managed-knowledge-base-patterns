/**
 * Configuration for the local embed-URL harness, read from webapp/.env. None of it
 * reaches the browser.
 */

export interface DemoUser {
  readonly label: string;
  readonly arn: string;
}

export interface HarnessConfig {
  readonly port: number;
  readonly region: string;
  readonly accountId: string;
  /** Exact browser origin allowed to host the embed, e.g. http://localhost:5173. */
  readonly allowedDomain: string;
  readonly fixedAgentId: string | null;
  readonly sessionLifetimeMinutes: number;
  /**
   * The only identities the harness will ever mint a URL for, keyed by the opaque
   * selector the browser sends. A Map rather than an object literal so that keys such
   * as `__proto__` or `constructor` cannot resolve to anything.
   */
  readonly users: ReadonlyMap<string, DemoUser>;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv): HarnessConfig {
  const missing: string[] = [];
  const region = env.QUICK_REGION;
  const accountId = env.QUICK_AWS_ACCOUNT_ID;
  const userAArn = env.QUICK_USER_A_ARN;
  const userBArn = env.QUICK_USER_B_ARN;

  if (!region) missing.push('QUICK_REGION');
  if (!accountId) missing.push('QUICK_AWS_ACCOUNT_ID');
  if (!userAArn) missing.push('QUICK_USER_A_ARN');
  if (!userBArn) missing.push('QUICK_USER_B_ARN');
  if (!region || !accountId || !userAArn || !userBArn) {
    throw new ConfigError(
      `Missing required configuration in webapp/.env: ${missing.join(', ')}\n` +
        'Copy webapp/.env.example to webapp/.env and fill it in.',
    );
  }

  // Caught here rather than surfacing as an opaque validation error from the Quick API
  // on the first request.
  const sessionLifetimeMinutes = Number(env.QUICK_SESSION_LIFETIME_MINUTES || 60);
  if (
    !Number.isInteger(sessionLifetimeMinutes) ||
    sessionLifetimeMinutes < 15 ||
    sessionLifetimeMinutes > 600
  ) {
    throw new ConfigError(
      'QUICK_SESSION_LIFETIME_MINUTES must be an integer between 15 and 600; ' +
        `got "${env.QUICK_SESSION_LIFETIME_MINUTES}".`,
    );
  }

  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be a valid TCP port; got "${env.PORT}".`);
  }

  const allowedDomain = env.QUICK_ALLOWED_DOMAIN || 'http://localhost:5173';
  let parsedOrigin: string;
  try {
    parsedOrigin = new URL(allowedDomain).origin;
  } catch {
    throw new ConfigError(
      `QUICK_ALLOWED_DOMAIN ("${allowedDomain}") is not a valid URL.`,
    );
  }
  if (parsedOrigin !== allowedDomain) {
    throw new ConfigError(
      `QUICK_ALLOWED_DOMAIN must be a bare origin with no path or trailing slash, ` +
        `e.g. "${parsedOrigin}"; got "${allowedDomain}".`,
    );
  }

  return {
    port,
    region,
    accountId,
    allowedDomain,
    fixedAgentId: env.QUICK_FIXED_AGENT_ID || null,
    sessionLifetimeMinutes,
    users: new Map([
      ['a', { label: 'User A (shared + finance)', arn: userAArn }],
      ['b', { label: 'User B (shared + engineering)', arn: userBArn }],
    ]),
  };
}
