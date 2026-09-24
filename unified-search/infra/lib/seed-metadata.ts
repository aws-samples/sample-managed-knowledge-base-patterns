/**
 * Custom metadata attributes for the seeded corpus, and the `.metadata.json` sidecar
 * files that carry them.
 *
 * The single source of truth for the sidecar wire format, shared by the seeding script
 * (which writes the files) and the corpus test suite (which asserts on them) — the same
 * arrangement as `seed-acl.ts`, and for the same reason: keeping the writer and the tests
 * on one definition stops them drifting apart. A filter on an attribute that was not
 * ingested returns no results rather than an error, so a drifted sidecar would show up
 * as empty filtered results.
 *
 * ## Why custom attributes are in the sample at all
 *
 * Without them the only things filterable are the ten `_`-prefixed attributes the
 * service populates — file type, data source, language, timestamps. Those demonstrate the
 * mechanism but not the point. Real filtering is on business facets: document type,
 * owning department, effective date, product line. These attributes give the sample
 * something of each supported type to filter on.
 *
 * ## Sidecar placement
 *
 * A sidecar is `<document-key>.metadata.json`, adjacent to the document it describes:
 * `content/finance/q3-review.md` is described by
 * `content/finance/q3-review.md.metadata.json`.
 *
 * Two properties of this placement:
 *
 * 1. **No `metadataFilesPrefix` is needed.** That connector parameter exists for
 *    sidecars kept somewhere other than beside their documents. Adjacent sidecars are
 *    found without it, so this sample does not set it.
 * 2. **Sidecars are not ingested as documents.** Ingestion jobs count them separately
 *    (`numberOfMetadataDocumentsScanned`), and a `.metadata.json` file is not returned
 *    as a query result. So they can live inside the crawled prefix, unlike the global ACL file,
 *    which has to sit outside it precisely because it *would* be ingested.
 *
 * Being inside the crawled prefix has a consequence worth stating: a sidecar is covered
 * by whatever ACL entry covers its department prefix. That is what you want — the
 * metadata and the document it describes share a permission boundary.
 */

/**
 * The value of a custom attribute.
 *
 * Mirrors `MetadataAttributeValue` in the Bedrock API model, minus `BOOLEAN`, which the
 * corpus has no natural use for. Types are declared rather than inferred because the
 * declared type decides which operators work: `NUMBER` supports the range operators,
 * `STRING_LIST` supports `listContains`, and a number written as a string supports
 * neither.
 */
export type AttributeValue =
  | { readonly type: 'STRING'; readonly stringValue: string }
  | { readonly type: 'NUMBER'; readonly numberValue: number }
  | { readonly type: 'STRING_LIST'; readonly stringListValue: readonly string[] };

export type DocumentAttributes = Readonly<Record<string, AttributeValue>>;

/**
 * The attributes every generated document carries.
 *
 * Documented here rather than only in code because this list is the sample's answer to
 * "what can I filter on?", and a builder adapting the sample will want to replace it
 * wholesale with their own facets.
 *
 * | Attribute       | Type          | Filterable with                        |
 * | --------------- | ------------- | -------------------------------------- |
 * | `department`    | `STRING`      | `equals`, `notEquals`, `in`, `notIn`   |
 * | `docType`       | `STRING`      | `equals`, `notEquals`, `in`, `notIn`   |
 * | `project`       | `STRING`      | `equals`, `notEquals`, `in`, `notIn`   |
 * | `fiscalQuarter` | `STRING`      | `equals`, `in`                         |
 * | `fiscalYear`    | `NUMBER`      | the four range operators, `equals`     |
 * | `effectiveDate` | `STRING`      | the four range operators, ISO-8601     |
 * | `topics`        | `STRING_LIST` | `listContains`                         |
 *
 * `fiscalYear` and `effectiveDate` overlap on purpose: they show the two ways a range
 * filter can be expressed, as a number and as an ISO-8601 date string.
 */
export const ATTRIBUTE_NAMES = [
  'department',
  'docType',
  'project',
  'fiscalQuarter',
  'fiscalYear',
  'effectiveDate',
  'topics',
] as const;

export type AttributeName = (typeof ATTRIBUTE_NAMES)[number];

interface SidecarEntry {
  readonly value: AttributeValue;
  /**
   * Whether the attribute's text is embedded along with the document body.
   *
   * `false` throughout. These attributes exist to filter and to display, not to
   * influence ranking, and folding facet labels into the embedding would make every
   * document in a department slightly more similar to every other. This is a design
   * choice rather than a tuning result.
   */
  readonly includeForEmbedding: boolean;
}

export interface SidecarDocument {
  readonly metadataAttributes: Readonly<Record<string, SidecarEntry>>;
}

/**
 * Builds the sidecar document for a set of attributes.
 *
 * The nested, explicitly typed form is used rather than the flat
 * `{"metadataAttributes": {"key": "value"}}` shorthand. The connector accepts both, but
 * the flat form cannot express a type or `includeForEmbedding`, and a sample about
 * customization should show the form that can.
 *
 * @throws {Error} if given no attributes. An empty sidecar is valid but makes no
 * attribute filterable, so filters written against the document match nothing. Failing
 * here surfaces the mistake at seed time.
 */
export function buildSidecar(attributes: DocumentAttributes): SidecarDocument {
  const names = Object.keys(attributes);
  if (names.length === 0) {
    throw new Error(
      'buildSidecar requires at least one attribute. An empty sidecar makes no ' +
        'attribute filterable, so filters on this document would match nothing.',
    );
  }

  return {
    metadataAttributes: Object.fromEntries(
      names.map((name) => [
        name,
        { value: attributes[name] as AttributeValue, includeForEmbedding: false },
      ]),
    ),
  };
}

/** The S3 key of the sidecar describing a document. */
export function sidecarKey(documentKey: string): string {
  return `${documentKey}.metadata.json`;
}
