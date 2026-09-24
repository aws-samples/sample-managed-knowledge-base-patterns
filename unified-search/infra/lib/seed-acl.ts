/**
 * Seed content access control lists.
 *
 * The single source of truth, shared by the stack (for the crawled prefix), the
 * seeding script (which generates the ACL file), and the access-control test suite
 * (which asserts against these identities). Restating them in any of those places
 * would let them drift, and a drifted ACL is easy to miss: with ACL enabled, a
 * document whose prefix has no entry is not ingested at all.
 */

/**
 * Test identities the seeded lists refer to.
 *
 * Every username is drawn from the AWS approved fictitious people, and `example.com` is
 * reserved for documentation and cannot be registered, so these can never collide with a
 * real mailbox — which matters because they are written into access control entries.
 */
export const SEED_USERS = {
  /** Alejandro Rosalez. `shared`, `finance`, `legal`. */
  alejandro: 'alejandro_rosalez@example.com',
  /** Akua Mansa. `shared`, `engineering`, `operations`, `security`. */
  akua: 'akua_mansa@example.com',
  /**
   * Martha Rivera. `hr`, `legal`, `security`. Notably **not** `shared`, so one user's
   * view excludes it.
   */
  martha: 'martha_rivera@example.com',
  /** Mary Major. `sales`, `operations`. */
  mary: 'mary_major@example.com',
  /**
   * John Stiles. Referenced by no entry, so entitled to nothing.
   *
   * Load-bearing: this identity is what distinguishes "access control filters" from
   * "these documents happen to be readable by everyone who was tested". It must stay
   * absent from every entry below.
   */
  outsider: 'john_stiles@example.com',
} as const;

/**
 * Departments the generated corpus is organized into.
 *
 * Each is a key prefix and therefore an access control boundary — on an ACL-enabled S3
 * data source, permissions are granted by prefix. Every department here **must** appear
 * in {@link SEED_ACL}: a document under a prefix with no entry is not ingested at all, so
 * a missing department is absent from the index rather than merely unauthorized. A test asserts the two lists agree.
 */
export const DEPARTMENTS = [
  'shared',
  'finance',
  'engineering',
  'hr',
  'legal',
  'sales',
  'operations',
  'security',
] as const;

export type Department = (typeof DEPARTMENTS)[number];

/** Prefix under the content bucket that the connector crawls. */
export const CONTENT_PREFIX = 'content/';

/**
 * Key of the global ACL file.
 *
 * Deliberately outside {@link CONTENT_PREFIX}: the file must live in the same
 * bucket as the content it governs, and if it sat inside the crawled prefix it
 * would be ingested as a document.
 */
export const GLOBAL_ACL_KEY = 'acl/global-acl.json';

export interface SeedAclEntry {
  readonly prefix: string;
  readonly allow: readonly string[];
}

/**
 * Who may read what.
 *
 * The first three entries must not change: the access-control suite asserts on exactly
 * this shape — one prefix both Alejandro and Akua can read, one only Alejandro can, one
 * only Akua can. That trio is what proves filtering rather than a blanket allow, so
 * widening `finance` or `engineering` would quietly turn those tests into assertions
 * about nothing.
 *
 * The remaining entries exist so a larger corpus has a realistic permission structure:
 * overlapping departments, users who share some access and not other, and one department
 * everybody can read.
 */
export const SEED_ACL: readonly SeedAclEntry[] = [
  // --- The load-bearing trio. Do not widen; the ACL suite depends on it. ---
  {
    prefix: `${CONTENT_PREFIX}shared/`,
    allow: [SEED_USERS.alejandro, SEED_USERS.akua],
  },
  { prefix: `${CONTENT_PREFIX}finance/`, allow: [SEED_USERS.alejandro] },
  { prefix: `${CONTENT_PREFIX}engineering/`, allow: [SEED_USERS.akua] },

  // --- Additional departments for the generated corpus. ---
  { prefix: `${CONTENT_PREFIX}hr/`, allow: [SEED_USERS.martha] },
  // Overlapping: two users from different departments share this one.
  {
    prefix: `${CONTENT_PREFIX}legal/`,
    allow: [SEED_USERS.alejandro, SEED_USERS.martha],
  },
  { prefix: `${CONTENT_PREFIX}sales/`, allow: [SEED_USERS.mary] },
  { prefix: `${CONTENT_PREFIX}operations/`, allow: [SEED_USERS.mary, SEED_USERS.akua] },
  { prefix: `${CONTENT_PREFIX}security/`, allow: [SEED_USERS.akua, SEED_USERS.martha] },
];

export interface GlobalAclDocument {
  readonly keyPrefix: string;
  readonly aclEntries: readonly {
    readonly Name: string;
    readonly Type: 'USER';
    readonly Access: 'ALLOW' | 'DENY';
  }[];
}

/**
 * Builds the global ACL document for a given bucket.
 *
 * `keyPrefix` must be an absolute `s3://` URI, not a bare key. A bare key is
 * accepted and then matches nothing, so every document is treated as having no
 * ACL entry and none are ingested.
 */
export function buildGlobalAcl(bucketName: string): GlobalAclDocument[] {
  return SEED_ACL.map((entry) => ({
    keyPrefix: `s3://${bucketName}/${entry.prefix}`,
    aclEntries: entry.allow.map((email) => ({
      Name: email,
      Type: 'USER' as const,
      Access: 'ALLOW' as const,
    })),
  }));
}
