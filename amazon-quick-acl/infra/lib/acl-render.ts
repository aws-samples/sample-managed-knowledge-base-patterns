/**
 * Renders the global ACL template into the file the S3 data source reads.
 *
 * Kept free of file system access so the validation rules can be tested directly.
 *
 * On email matching: Bedrock compares `userContext.userId` to ACL entries
 * case-insensitively and ignores surrounding whitespace, but does no alias resolution.
 * `martha_rivera@example.com` and `martha_rivera+a@example.com` are two distinct
 * identities, so the entries here must name the addresses the users are registered with
 * in Amazon Quick.
 */

export interface AclRenderInput {
  readonly bucketName: string;
  readonly userAEmail: string | undefined;
  readonly userBEmail: string | undefined;
}

export class AclRenderError extends Error {}

/** How Bedrock compares identities: case-insensitive, whitespace-trimmed. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function renderAcl(template: string, input: AclRenderInput): string {
  const userA = input.userAEmail?.trim();
  const userB = input.userBEmail?.trim();

  if (!input.bucketName) {
    throw new AclRenderError('No bucket name was provided.');
  }

  if (!userA || !userB) {
    throw new AclRenderError(
      'DEMO_USER_A_EMAIL and DEMO_USER_B_EMAIL must both be set in infra/.env.\n' +
        'See infra/.env.example.',
    );
  }

  for (const [label, email] of [
    ['DEMO_USER_A_EMAIL', userA],
    ['DEMO_USER_B_EMAIL', userB],
  ] as const) {
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new AclRenderError(
        `${label} ("${email}") does not look like an email address.`,
      );
    }
  }

  // Compared the way Bedrock compares them. Two addresses differing only in case would
  // be one identity at retrieval time, and the demo would show no difference at all.
  if (normalizeEmail(userA) === normalizeEmail(userB)) {
    throw new AclRenderError(
      'DEMO_USER_A_EMAIL and DEMO_USER_B_EMAIL name the same identity (Bedrock compares ' +
        'them case-insensitively). The ACL demo needs two distinct users.',
    );
  }

  const rendered = template
    .replaceAll('__BUCKET_NAME__', input.bucketName)
    .replaceAll('__DEMO_USER_A_EMAIL__', userA)
    .replaceAll('__DEMO_USER_B_EMAIL__', userB);

  // Fail loudly rather than uploading an ACL file with unsubstituted placeholders, which
  // would leave every document under the affected prefix unreadable by anyone.
  const leftover = rendered.match(/__[A-Z_]+__/g);
  if (leftover) {
    throw new AclRenderError(
      `Unsubstituted placeholders remain in the rendered ACL file: ${[...new Set(leftover)].join(', ')}`,
    );
  }

  try {
    JSON.parse(rendered);
  } catch {
    throw new AclRenderError(
      'The rendered ACL file is not valid JSON. Check the template.',
    );
  }

  return rendered;
}
