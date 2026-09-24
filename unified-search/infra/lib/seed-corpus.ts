import { CONTENT_PREFIX, DEPARTMENTS, type Department } from './seed-acl';
import type { DocumentAttributes } from './seed-metadata';

/**
 * Generates a synthetic document corpus large enough for search to be interesting.
 *
 * The three hand-written seed documents are enough to show access control filtering,
 * which is what the ACL suite needs. They are not enough to *demonstrate* enterprise
 * search: every query returns the same one or two files, relevance ranking has little to
 * rank, and the agentic retriever has little to decompose a question across. This
 * produces roughly 120 documents spread over eight departments so that behavior is
 * visible.
 *
 * ## Generated rather than committed
 *
 * 120 markdown files in the repository would be 120 files a reader has to scroll past to
 * find the code, and reviewing a change to them is meaningless. Generating them keeps the
 * repository small and makes the corpus a described thing rather than a pile of prose.
 *
 * ## Deterministic
 *
 * A seeded generator, so the same corpus comes out every time. That matters more than it
 * looks: ACL behavior is verified by asserting which documents a user can retrieve, and
 * a corpus that changed between runs would make those assertions flaky in a way that
 * looks like a permissions bug.
 *
 * ## Content is plain business prose, deliberately
 *
 * No document describes its own permissions. Retrieved text is untrusted input to the
 * generator, and text that reads like an access rule can be interpreted as an
 * instruction about what may be disclosed. Access is enforced by the knowledge base's
 * ACLs, so the content does not restate it, and the corpus contains nothing resembling
 * an instruction. See DESIGN.md.
 */

export interface GeneratedDocument {
  /** Key relative to the content prefix, e.g. `content/finance/q1-budget-review.md`. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /**
   * Business facets written to a `.metadata.json` sidecar and filterable at query time.
   *
   * Derived from the same choices that produce the title and body, so the metadata
   * describes the document rather than being independently random. See
   * `seed-metadata.ts` for the attribute set and the sidecar format.
   */
  readonly attributes: DocumentAttributes;
}

/**
 * Deterministic pseudo-random generator.
 *
 * A small linear congruential generator rather than `Math.random`, because the corpus
 * has to be reproducible. Not suitable for anything security-related, which this is not.
 */
class Rng {
  constructor(private seed: number) {}

  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }

  /** A plausible-looking figure with one decimal place. */
  amount(min: number, max: number): string {
    return (min + this.next() * (max - min)).toFixed(1);
  }
}

interface DepartmentProfile {
  /** Documents produced for this department. */
  readonly docTypes: readonly string[];
  readonly projects: readonly string[];
  readonly topics: readonly string[];
  readonly metrics: readonly string[];
}

/**
 * Vocabulary per department.
 *
 * Distinct wording matters: if every document read the same, a query would match all of
 * them equally and ranking would be indistinguishable from random order.
 */
const PROFILES: Readonly<Record<Department, DepartmentProfile>> = {
  shared: {
    docTypes: ['Handbook', 'Policy', 'Guide', 'FAQ', 'Onboarding Notes'],
    projects: ['Employee Handbook', 'Workplace Guide', 'Benefits Overview'],
    topics: [
      'expense submission and reimbursement timelines',
      'annual leave accrual and carry-over rules',
      'remote and hybrid working expectations',
      'equipment requests and replacement cycles',
      'travel booking and approval thresholds',
      'internal communication norms and meeting etiquette',
      'learning budget and conference attendance',
      'parental leave and phased return arrangements',
    ],
    metrics: ['response time', 'approval turnaround', 'participation rate'],
  },
  finance: {
    docTypes: ['Forecast', 'Budget Review', 'Variance Analysis', 'Board Summary'],
    projects: ['Annual Plan', 'Cost Optimization', 'Revenue Model', 'Pricing Review'],
    topics: [
      'subscription revenue recognition and deferred balances',
      'quarterly operating expense variance against plan',
      'headcount cost modeling and hiring phasing',
      'gross margin trends by product line',
      'cash conversion and days sales outstanding',
      'capital expenditure approvals and depreciation schedules',
      'foreign exchange exposure on international contracts',
      'discount governance and deal desk escalation',
    ],
    metrics: [
      'gross margin',
      'operating expense',
      'renewal rate',
      'annual recurring revenue',
    ],
  },
  engineering: {
    docTypes: [
      'Design Document',
      'Runbook',
      'Postmortem',
      'Roadmap',
      'Architecture Note',
    ],
    projects: [
      'Retrieval Quality',
      'Ingestion Pipeline',
      'Observability',
      'Platform Migration',
    ],
    topics: [
      'hybrid retrieval evaluation against a ground truth question set',
      'ingestion throughput targets for the document pipeline',
      'per-document status reporting for batch imports',
      'deprecation of the v1 search endpoint and client migration',
      'index rebuild strategy and blue-green cutover',
      'latency budgets across the retrieval and generation path',
      'schema evolution for document metadata',
      'load shedding behavior under sustained query volume',
    ],
    metrics: ['p99 latency', 'documents per minute', 'error rate', 'index freshness'],
  },
  hr: {
    docTypes: [
      'Policy',
      'Process Note',
      'Review Cycle Guide',
      'Job Family Description',
    ],
    projects: [
      'Performance Cycle',
      'Hiring Plan',
      'Levelling Framework',
      'Engagement Survey',
    ],
    topics: [
      'performance review calibration and moderation',
      'interview loop composition and scoring rubrics',
      'levelling expectations across engineering job families',
      'internal transfer eligibility and notice periods',
      'compensation review timing and banding',
      'engagement survey themes and follow-up commitments',
      'probation objectives and check-in cadence',
      'grievance escalation and confidentiality handling',
    ],
    metrics: ['time to hire', 'offer acceptance rate', 'attrition', 'engagement score'],
  },
  legal: {
    docTypes: [
      'Contract Summary',
      'Position Paper',
      'Review Checklist',
      'Risk Register',
    ],
    projects: [
      'Vendor Agreements',
      'Data Processing',
      'Trademark Portfolio',
      'Compliance Review',
    ],
    topics: [
      'data processing terms and sub-processor disclosure',
      'liability caps and indemnity carve-outs in enterprise agreements',
      'retention obligations for customer records',
      'export control considerations for regional deployments',
      'trademark usage guidance for partner materials',
      'notice and termination mechanics in reseller contracts',
      'contractual audit rights and evidence expectations',
      'intellectual property assignment in contractor agreements',
    ],
    metrics: ['review turnaround', 'open risk count', 'contract cycle time'],
  },
  sales: {
    docTypes: ['Account Plan', 'Pipeline Review', 'Win-Loss Summary', 'Territory Note'],
    projects: [
      'Enterprise Segment',
      'Renewals Motion',
      'Partner Channel',
      'Land and Expand',
    ],
    topics: [
      'late-stage negotiation status across the enterprise segment',
      'renewal risk indicators and mitigation owners',
      'competitive displacement patterns and objection handling',
      'partner-sourced pipeline contribution by region',
      'expansion opportunities within existing accounts',
      'procurement timelines and security review bottlenecks',
      'pricing exceptions requested during the quarter',
      'territory coverage gaps and quota distribution',
    ],
    metrics: [
      'pipeline coverage',
      'win rate',
      'average deal size',
      'sales cycle length',
    ],
  },
  operations: {
    docTypes: ['Process Map', 'Service Review', 'Capacity Plan', 'Vendor Assessment'],
    projects: [
      'Support Operations',
      'Supplier Management',
      'Facilities Plan',
      'Tooling Consolidation',
    ],
    topics: [
      'support ticket routing and escalation thresholds',
      'supplier performance against agreed service levels',
      'seasonal capacity planning for the support desk',
      'tooling consolidation and license rationalization',
      'change management windows and freeze periods',
      'business continuity assumptions and tested recovery paths',
      'onboarding logistics for new starters across offices',
      'asset tracking and end-of-life disposal',
    ],
    metrics: [
      'first response time',
      'backlog age',
      'service level attainment',
      'cost per ticket',
    ],
  },
  security: {
    docTypes: ['Standard', 'Assessment', 'Incident Review', 'Control Narrative'],
    projects: [
      'Access Governance',
      'Threat Modeling',
      'Logging Program',
      'Third Party Review',
    ],
    topics: [
      'least privilege review for production access paths',
      'access review process for internal applications',
      'logging coverage for administrative actions',
      'third-party assessment findings and remediation owners',
      'secret rotation cadence and exception handling',
      'phishing simulation outcomes and follow-up training',
      'network segmentation between environments',
      'evidence collection for annual audit cycles',
    ],
    metrics: [
      'mean time to detect',
      'open finding count',
      'patch latency',
      'coverage percentage',
    ],
  },
};

/** Documents generated per department. Eight departments, so roughly 120 in total. */
const PER_DEPARTMENT = 15;

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
const YEARS = [2024, 2025, 2026] as const;

/**
 * Builds the corpus.
 *
 * @param seed change to produce a different but equally reproducible corpus.
 */
export function generateCorpus(seed = 20260913): readonly GeneratedDocument[] {
  const rng = new Rng(seed);
  const documents: GeneratedDocument[] = [];

  for (const department of DEPARTMENTS) {
    const profile = PROFILES[department];

    for (let index = 0; index < PER_DEPARTMENT; index += 1) {
      const docType = rng.pick(profile.docTypes);
      const project = rng.pick(profile.projects);
      const quarter = rng.pick(QUARTERS);
      const year = rng.pick(YEARS);
      const primary = rng.pick(profile.topics);
      // A distinct secondary topic. Picking twice from the same list produces a
      // duplicate often enough to matter, and the pair becomes the `topics` attribute —
      // a two-element list holding one value twice looks like a defect in the metadata
      // rather than a coincidence in the generator.
      const secondary = rng.pick(profile.topics.filter((topic) => topic !== primary));
      const metric = rng.pick(profile.metrics);

      const title = `${project} ${docType} — ${quarter} ${String(year)}`;
      const slug = `${slugify(project)}-${slugify(docType)}-${quarter.toLowerCase()}-${String(year)}-${String(index + 1)}`;

      documents.push({
        key: `${CONTENT_PREFIX}${department}/${slug}.md`,
        title,
        body: renderDocument({
          title,
          department,
          quarter,
          year,
          primary,
          secondary,
          metric,
          rng,
        }),
        attributes: {
          department: { type: 'STRING', stringValue: department },
          docType: { type: 'STRING', stringValue: docType },
          project: { type: 'STRING', stringValue: project },
          fiscalQuarter: { type: 'STRING', stringValue: quarter },
          fiscalYear: { type: 'NUMBER', numberValue: year },
          effectiveDate: { type: 'STRING', stringValue: effectiveDate(quarter, year) },
          topics: { type: 'STRING_LIST', stringListValue: [primary, secondary] },
        },
      });
    }
  }

  return documents;
}

interface RenderOptions {
  readonly title: string;
  readonly department: Department;
  readonly quarter: string;
  readonly year: number;
  readonly primary: string;
  readonly secondary: string;
  readonly metric: string;
  readonly rng: Rng;
}

function renderDocument(options: RenderOptions): string {
  const { title, department, quarter, year, primary, secondary, metric, rng } = options;
  // Drawn from the AWS approved fictitious people, so the generated corpus carries no
  // invented personal names.
  const owner = rng.pick([
    'Martha Rivera',
    'Mary Major',
    'John Stiles',
    'Saanvi Sarkar',
    'Terry Whitlock',
  ]);
  const current = rng.amount(1.2, 9.8);
  const prior = rng.amount(1.0, 9.5);
  const target = rng.amount(2.0, 12.0);

  return [
    `# ${title}`,
    '',
    `AnyCompany — ${titleCase(department)} team. All content in this document is`,
    'fictional and generated for demonstration purposes.',
    '',
    `**Period:** ${quarter} ${String(year)}  `,
    `**Owner:** ${owner}`,
    '',
    '## Summary',
    '',
    `This ${quarter} review covers ${primary}. The headline ${metric} moved to ${current}`,
    `from ${prior} in the previous period, against a target of ${target}.`,
    '',
    '## Detail',
    '',
    `The team spent most of ${quarter} on ${primary}. Progress was steady, with the main`,
    `constraint being coordination across teams rather than any single technical or`,
    `commercial blocker.`,
    '',
    `A secondary thread of work looked at ${secondary}. That work is not yet complete and`,
    `carries into the following quarter.`,
    '',
    '## Observations',
    '',
    `- The ${metric} figure is sensitive to how the period boundary is drawn, so compare`,
    '  it against the same quarter last year rather than the preceding one.',
    `- Two items were deferred to make room for ${primary}.`,
    '- No changes were made to previously agreed commitments.',
    '',
    '## Next steps',
    '',
    `1. Close out the remaining work on ${secondary}.`,
    `2. Re-baseline the ${metric} target once the current period closes.`,
    '3. Review this document at the next scheduled team meeting.',
    '',
  ].join('\n');
}

/**
 * First day of a fiscal quarter, as an ISO-8601 instant.
 *
 * Range filters compare date attributes as ISO-8601 date-time strings, so the value is
 * written in full rather than as `2024-04` or `Q2 2024`.
 */
function effectiveDate(quarter: (typeof QUARTERS)[number], year: number): string {
  const month = { Q1: '01', Q2: '04', Q3: '07', Q4: '10' }[quarter];
  return `${String(year)}-${month}-01T00:00:00Z`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
