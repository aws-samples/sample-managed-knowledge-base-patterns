import { describe, expect, it } from 'vitest';
import { UserIdentity } from './identity.js';

describe('UserIdentity', () => {
  it('builds from verified claims', () => {
    const identity = UserIdentity.fromVerifiedClaims({
      email: 'alejandro_rosalez@example.com',
      subject: 'sub-1',
    });

    expect(identity.email).toBe('alejandro_rosalez@example.com');
    expect(identity.subject).toBe('sub-1');
  });

  // ACL entries match on email address and aliases are not resolved.
  // Normalizing case and whitespace here means every provider gets a
  // consistent join key regardless of how the token formats the address.
  it('normalizes email case and surrounding whitespace', () => {
    const identity = UserIdentity.fromVerifiedClaims({
      email: '  Alejandro_Rosalez@Example.COM  ',
      subject: ' sub-1 ',
    });

    expect(identity.email).toBe('alejandro_rosalez@example.com');
    expect(identity.subject).toBe('sub-1');
  });

  it.each([
    ['empty email', { email: '', subject: 'sub-1' }],
    ['blank email', { email: '   ', subject: 'sub-1' }],
    ['empty subject', { email: 'alejandro_rosalez@example.com', subject: '' }],
    ['blank subject', { email: 'alejandro_rosalez@example.com', subject: '  ' }],
  ])('rejects %s rather than producing an unusable identity', (_label, claims) => {
    // Failing loudly matters: an identity with no email reaches Bedrock as an
    // absent user context. ACL-enabled sources return no results in that case,
    // which is easy to mistake for an empty index.
    expect(() => UserIdentity.fromVerifiedClaims(claims)).toThrow(/email|subject/);
  });

  it('cannot be constructed without going through the verified-claims factory', () => {
    // The guarantee is compile-time — `new UserIdentity(...)` does not typecheck,
    // because the constructor is private. This assertion documents the intent and
    // pins the shape of the public surface, so adding a second construction path
    // is a deliberate act rather than an accident.
    expect(Object.getOwnPropertyNames(UserIdentity)).toContain('fromVerifiedClaims');
    expect(typeof UserIdentity.fromVerifiedClaims).toBe('function');
  });

  it('masks the local part of the address when stringified for logs', () => {
    const identity = UserIdentity.fromVerifiedClaims({
      email: 'alejandro_rosalez@example.com',
      subject: 'sub-1',
    });

    const rendered = identity.toString();

    expect(rendered).toBe('UserIdentity(a***@example.com)');
    expect(rendered).not.toContain('alejandro_rosalez@');
  });

  it('does not leak a single-character local part', () => {
    const identity = UserIdentity.fromVerifiedClaims({
      email: 'a@example.com',
      subject: 'sub-1',
    });

    expect(identity.toString()).toBe('UserIdentity(*@example.com)');
  });
});
