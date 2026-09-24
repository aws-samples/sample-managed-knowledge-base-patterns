import { describe, expect, it } from 'vitest';
import loadConfig, {
  type AppConfig,
  cognitoIssuer,
  cognitoJwksUri,
  validateConfig,
} from './configuration.js';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3001,
    aws: { region: 'us-east-1' },
    corsAllowedOrigins: ['http://localhost:5173'],
    auth: {
      userPoolId: 'us-east-1_ABC123',
      clientId: 'client-abc',
      region: 'us-east-1',
    },
    ...overrides,
  };
}

describe('configuration', () => {
  describe('Cognito URL derivation', () => {
    // Derived rather than separately configured so they cannot drift apart. A
    // JWKS URL pointing at a different pool than the issuer being enforced would
    // be a verification bypass, not a typo.
    it('derives the issuer from region and pool id', () => {
      expect(cognitoIssuer(config().auth)).toBe(
        'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
      );
    });

    it('derives the JWKS URI from the issuer', () => {
      expect(cognitoJwksUri(config().auth)).toBe(
        'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123/.well-known/jwks.json',
      );
    });

    it('uses https', () => {
      expect(cognitoJwksUri(config().auth)).toMatch(/^https:\/\//);
    });
  });

  describe('validateConfig', () => {
    it('accepts a complete configuration', () => {
      expect(() => validateConfig(config())).not.toThrow();
    });

    it.each([
      ['user pool id', { userPoolId: '' }, /COGNITO_USER_POOL_ID/],
      ['blank user pool id', { userPoolId: '   ' }, /COGNITO_USER_POOL_ID/],
      ['client id', { clientId: '' }, /COGNITO_CLIENT_ID/],
      ['blank client id', { clientId: '  ' }, /COGNITO_CLIENT_ID/],
    ])('refuses to start without a %s', (_label, authOverrides, expected) => {
      const broken = config({ auth: { ...config().auth, ...authOverrides } });

      expect(() => validateConfig(broken)).toThrow(expected);
    });

    it('reports every missing variable at once', () => {
      const broken = config({
        auth: { userPoolId: '', clientId: '', region: 'us-east-1' },
      });

      // One restart per missing variable is a bad way to configure a service.
      expect(() => validateConfig(broken)).toThrow(
        /COGNITO_USER_POOL_ID.*COGNITO_CLIENT_ID/s,
      );
    });

    it('rejects a non-numeric port', () => {
      expect(() => validateConfig(config({ port: Number.NaN }))).toThrow(/PORT/);
    });

    // CORS is warned about at startup rather than fatal: a missing allowlist
    // blocks browser callers, whereas missing auth settings mean tokens cannot be
    // verified at all.
    it('does not treat an empty CORS allowlist as fatal', () => {
      expect(() => validateConfig(config({ corsAllowedOrigins: [] }))).not.toThrow();
    });
  });

  describe('defaults', () => {
    it('never defaults authentication settings to a usable value', () => {
      const loaded = loadConfig();

      // Absent auth config must produce something that fails validation, not a
      // placeholder that lets the service start with an unverifiable issuer.
      if (process.env.COGNITO_USER_POOL_ID === undefined) {
        expect(loaded.auth.userPoolId).toBe('');
        expect(() => validateConfig(loaded)).toThrow();
      }
    });

    it('never defaults CORS to a wildcard', () => {
      const loaded = loadConfig();

      expect(loaded.corsAllowedOrigins).not.toContain('*');
    });
  });
});
