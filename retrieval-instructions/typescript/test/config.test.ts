import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Import a fresh src/config.ts under the given environment. Creating a client needs no credentials. */
async function reload(env: Record<string, string>): Promise<string> {
  vi.stubEnv('AWS_REGION', undefined);
  vi.stubEnv('AWS_DEFAULT_REGION', undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  const config = await import('../src/config.js');
  expect(await config.agent.config.region()).toBe(config.region);
  expect(await config.runtime.config.region()).toBe(config.region);
  expect(await config.cloudtrail.config.region()).toBe(config.region);
  return config.region;
}

describe('the Region rule', () => {
  it('defaults to us-east-1', async () => {
    expect(await reload({})).toBe('us-east-1');
  });

  it('uses AWS_REGION when set', async () => {
    expect(await reload({ AWS_REGION: 'eu-west-1' })).toBe('eu-west-1');
  });

  it('ignores AWS_DEFAULT_REGION', async () => {
    expect(await reload({ AWS_DEFAULT_REGION: 'eu-west-1' })).toBe('us-east-1');
  });

  it('gives the runtime client the stream timeout and retries', async () => {
    vi.resetModules();
    const config = await import('../src/config.js');
    expect(config.RUNTIME_CONFIG.requestHandler.requestTimeout).toBe(120_000);
    expect(await config.runtime.config.maxAttempts()).toBe(5);
    const mode = config.runtime.config.retryMode;
    expect(typeof mode === 'function' ? await mode() : mode).toBe('standard');
  });
});
