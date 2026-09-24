import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Proves that document-level access control actually filters, against a real
 * knowledge base.
 *
 * This is the test that substantiates the sample's central claim. Everything else — verified tokens, a required identity
 * argument, scoped IAM — is machinery in service of the property asserted here: two
 * authenticated users issuing the same query get different documents, and an
 * unauthorized user gets nothing.
 *
 * ## Why this is an integration test
 *
 * There is no way to fake it. ACL evaluation happens inside Bedrock, so a mock
 * would only assert that this file's own assumptions are self-consistent. The
 * knowledge base has to be real.
 *
 * ## Running it
 *
 * Requires a `sample` mode deployment, seeded and ingested:
 *
 *   cd infra
 *   npm run deploy:sample
 *   npm run seed:sample
 *   # then the StartIngestionCommand from the stack outputs, and wait for COMPLETE
 *
 * Then, from the repository root:
 *
 *   ACL_TEST_KNOWLEDGE_BASE_ID=<id> npm run test:integration --workspace @unified-search/backend
 *
 * Skipped when that variable is absent, so the unit suite stays runnable with no
 * credentials. A skipped security test proves nothing, so run this against a
 * deployed knowledge base before any release.
 */

const KNOWLEDGE_BASE_ID = process.env.ACL_TEST_KNOWLEDGE_BASE_ID;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

/** Must match `infra/lib/seed-acl.ts`. */
const ALEJANDRO = 'alejandro_rosalez@example.com';
const AKUA = 'akua_mansa@example.com';
const OUTSIDER = 'john_stiles@example.com';

/** Distinctive phrases from each seeded document. */
const SHARED_QUERY = 'how do expenses and time off work';
const FINANCE_QUERY = 'what is the projected quarterly revenue forecast';
const ENGINEERING_QUERY = 'what is on the platform roadmap for retrieval quality';

const describeIfDeployed = KNOWLEDGE_BASE_ID === undefined ? describe.skip : describe;

describeIfDeployed('ACL-aware retrieval (integration)', () => {
  let client: BedrockAgentRuntimeClient;

  beforeAll(() => {
    client = new BedrockAgentRuntimeClient({ region: REGION });
  });

  /**
   * @param userId omit to send no user context at all
   */
  async function retrieve(text: string, userId?: string): Promise<string[]> {
    const response = await client.send(
      new RetrieveCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        retrievalQuery: { text },
        ...(userId === undefined ? {} : { userContext: { userId } }),
      }),
    );

    // The source URI is what identifies which document came back. Everything else
    // is chunk text, which is not stable enough to assert on.
    return (response.retrievalResults ?? []).map(
      (result) => result.location?.s3Location?.uri ?? JSON.stringify(result.location),
    );
  }

  const inFinance = (uris: string[]) => uris.some((uri) => uri.includes('/finance/'));
  const inEngineering = (uris: string[]) =>
    uris.some((uri) => uri.includes('/engineering/'));
  const inShared = (uris: string[]) => uris.some((uri) => uri.includes('/shared/'));

  describe('the authorized case', () => {
    it('returns the shared document to both users', async () => {
      const [forAlejandro, forAkua] = await Promise.all([
        retrieve(SHARED_QUERY, ALEJANDRO),
        retrieve(SHARED_QUERY, AKUA),
      ]);

      expect(inShared(forAlejandro), `alejandro got: ${forAlejandro.join(', ')}`).toBe(
        true,
      );
      expect(inShared(forAkua), `akua got: ${forAkua.join(', ')}`).toBe(true);
    });

    it('returns the finance document to alejandro', async () => {
      const uris = await retrieve(FINANCE_QUERY, ALEJANDRO);

      expect(inFinance(uris), `alejandro got: ${uris.join(', ')}`).toBe(true);
    });

    it('returns the engineering document to akua', async () => {
      const uris = await retrieve(ENGINEERING_QUERY, AKUA);

      expect(inEngineering(uris), `akua got: ${uris.join(', ')}`).toBe(true);
    });
  });

  /**
   * The half that matters. A permission system that grants correctly but never
   * denies is not a permission system, and this is the direction a
   * misconfiguration fails in.
   */
  describe('the unauthorized case', () => {
    it('withholds the finance document from akua', async () => {
      const uris = await retrieve(FINANCE_QUERY, AKUA);

      expect(
        inFinance(uris),
        `akua should not see finance, got: ${uris.join(', ')}`,
      ).toBe(false);
    });

    it('withholds the engineering document from alejandro', async () => {
      const uris = await retrieve(ENGINEERING_QUERY, ALEJANDRO);

      expect(
        inEngineering(uris),
        `alejandro should not see engineering, got: ${uris.join(', ')}`,
      ).toBe(false);
    });

    it('returns nothing at all to a user named in no ACL entry', async () => {
      const uris = await retrieve(SHARED_QUERY, OUTSIDER);

      expect(uris, `outsider got: ${uris.join(', ')}`).toEqual([]);
    });
  });

  /**
   * Omitting user context returns zero results from an ACL-enabled data source.
   *
   * Worth asserting because it is the failure mode a caller is most likely to
   * introduce — and because it fails *safe*, which makes it easy to ship
   * unnoticed. It presents as an empty index rather than an error, which is why the
   * domain port makes identity a required argument.
   */
  describe('the no-user case', () => {
    it('returns nothing when no user context is supplied', async () => {
      const uris = await retrieve(SHARED_QUERY);

      expect(uris, `anonymous got: ${uris.join(', ')}`).toEqual([]);
    });
  });

  /**
   * Guards against the whole suite passing vacuously.
   *
   * Every assertion above would hold if the knowledge base were empty, or if the
   * queries simply matched nothing. This confirms the corpus is genuinely
   * retrievable, so a denial above means "denied" rather than "nothing there".
   */
  describe('the suite is not vacuous', () => {
    it('retrieves at least one document overall', async () => {
      const [shared, finance, engineering] = await Promise.all([
        retrieve(SHARED_QUERY, ALEJANDRO),
        retrieve(FINANCE_QUERY, ALEJANDRO),
        retrieve(ENGINEERING_QUERY, AKUA),
      ]);

      expect([...shared, ...finance, ...engineering].length).toBeGreaterThan(0);
    });

    it('gives the two users demonstrably different result sets', async () => {
      const [forAlejandro, forAkua] = await Promise.all([
        retrieve(FINANCE_QUERY, ALEJANDRO),
        retrieve(FINANCE_QUERY, AKUA),
      ]);

      // Same query, different identities, different documents. This single
      // assertion is the sample's thesis.
      expect(forAlejandro).not.toEqual(forAkua);
    });
  });
});
