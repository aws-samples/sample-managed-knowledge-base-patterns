import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.ts';
import { createHarnessHandler, type EmbedUrlMinter } from '../server/harness.ts';

const USER_A_ARN =
  'arn:aws:quicksight:us-east-1:123456789012:user/default/martha_rivera';
const USER_B_ARN =
  'arn:aws:quicksight:us-east-1:123456789012:user/default/mateo_jackson';
const ORIGIN = 'http://localhost:5173';

interface Reply {
  status: number;
  body: Record<string, unknown> | unknown[];
}

let server: Server;
let port: number;
let minted: string[];
let logged: string[];
let minter: EmbedUrlMinter;

beforeEach(async () => {
  minted = [];
  logged = [];
  minter = async (arn) => {
    minted.push(arn);
    return `https://example.com/embed?for=${encodeURIComponent(arn)}`;
  };

  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  const config = loadConfig({
    QUICK_REGION: 'us-east-1',
    QUICK_AWS_ACCOUNT_ID: '123456789012',
    QUICK_USER_A_ARN: USER_A_ARN,
    QUICK_USER_B_ARN: USER_B_ARN,
    QUICK_ALLOWED_DOMAIN: ORIGIN,
    PORT: String(port),
  });
  server.on(
    'request',
    createHarnessHandler(
      config,
      (arn) => minter(arn),
      (m) => logged.push(m),
    ),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function send(
  method: string,
  path: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Reply['body'],
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const postEmbed = (user: unknown, headers: Record<string, string> = {}) =>
  send('POST', '/api/embed-url', {
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify({ user }),
  });

describe('embed-URL harness', () => {
  it('lists user labels without exposing ARNs', async () => {
    const reply = await send('GET', '/api/users');

    expect(reply.status).toBe(200);
    expect(JSON.stringify(reply.body)).not.toContain('arn:');
    expect(reply.body).toEqual([
      { key: 'a', label: expect.any(String) },
      { key: 'b', label: expect.any(String) },
    ]);
  });

  it('mints a URL for a configured selector', async () => {
    const reply = await postEmbed('b');

    expect(reply.status).toBe(200);
    expect(minted).toEqual([USER_B_ARN]);
  });

  it.each([
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    USER_A_ARN,
    '',
    1,
    null,
  ])('rejects selector %j without calling Quick', async (selector) => {
    const reply = await postEmbed(selector);

    expect(reply.status).toBe(400);
    expect(minted).toEqual([]);
  });

  it.each([
    'evil.example.com:3001',
    'evil.example.com',
    'localhost:5173',
    '127.0.0.1:1',
  ])('rejects Host %j, which is how a DNS-rebinding request arrives', async (host) => {
    const reply = await send('GET', '/api/users', { headers: { host } });

    expect(reply.status).toBe(403);
  });

  it('accepts localhost as well as 127.0.0.1 on its own port', async () => {
    const reply = await send('GET', '/api/users', {
      headers: { host: `localhost:${port}` },
    });

    expect(reply.status).toBe(200);
  });

  it('rejects a request from a foreign origin', async () => {
    const reply = await postEmbed('a', { origin: 'https://evil.example.com' });

    expect(reply.status).toBe(403);
    expect(minted).toEqual([]);
  });

  it('rejects a text/plain body, the content type a cross-origin page can send freely', async () => {
    const reply = await postEmbed('a', { 'content-type': 'text/plain' });

    expect(reply.status).toBe(415);
    expect(minted).toEqual([]);
  });

  it('accepts application/json with a charset parameter', async () => {
    const reply = await postEmbed('a', {
      'content-type': 'application/json; charset=utf-8',
    });

    expect(reply.status).toBe(200);
  });

  it('rejects an oversized body', async () => {
    const reply = await send('POST', '/api/embed-url', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'a', pad: 'x'.repeat(5000) }),
    });

    expect(reply.status).toBe(413);
  });

  it('rejects malformed JSON', async () => {
    const reply = await send('POST', '/api/embed-url', {
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(reply.status).toBe(400);
  });

  it('does not pass AWS error detail through to the browser', async () => {
    minter = async () => {
      const err = new Error(`User ${USER_A_ARN} is not authorized`);
      err.name = 'AccessDeniedException';
      throw err;
    };

    const reply = await postEmbed('a');

    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.body)).not.toContain('AccessDenied');
    expect(JSON.stringify(reply.body)).not.toContain('arn:');
    expect(logged.join('\n')).toContain('AccessDeniedException');
  });

  it('returns 404 for anything else', async () => {
    expect((await send('GET', '/api/embed-url')).status).toBe(404);
    expect((await send('GET', '/')).status).toBe(404);
  });
});

describe('loadConfig', () => {
  const base = {
    QUICK_REGION: 'us-east-1',
    QUICK_AWS_ACCOUNT_ID: '123456789012',
    QUICK_USER_A_ARN: USER_A_ARN,
    QUICK_USER_B_ARN: USER_B_ARN,
  };

  it('names every missing variable', () => {
    expect(() => loadConfig({})).toThrow(
      /QUICK_REGION, QUICK_AWS_ACCOUNT_ID, QUICK_USER_A_ARN, QUICK_USER_B_ARN/,
    );
  });

  it('rejects an allowed domain with a trailing slash, which Quick would not match', () => {
    expect(() =>
      loadConfig({ ...base, QUICK_ALLOWED_DOMAIN: 'http://localhost:5173/' }),
    ).toThrow(/bare origin/);
  });

  it('rejects a session lifetime outside 15-600 minutes', () => {
    expect(() => loadConfig({ ...base, QUICK_SESSION_LIFETIME_MINUTES: '5' })).toThrow(
      /between 15 and 600/,
    );
  });
});
