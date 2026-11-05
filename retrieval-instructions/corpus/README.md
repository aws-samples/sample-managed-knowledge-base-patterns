# Sample corpus

Synthetic demo content. AnyCompany Smart Home (written "AnyCompany" in the document
text) is a fictitious company, and AnySmartProduct-5 (home controller) and
AnySmartProduct-6 (room sensor) are fictitious products. Nothing here describes a real
company, customer, policy, or person. All names, emails (`first_last@example.com`), and
phone numbers (555-0110 to 555-0144) come from the AWS fictitious content library.

The corpus models one company with several tenants that share one knowledge base:

- Sales regions "Sales Region North", "Sales Region Central", and "Sales Region South".
  They are fictional sales regions, not AWS Regions and not real countries. Each has its
  own warranty term, return window, restocking fee, support contact, and writing
  conventions.
- Teams: support, field sales, and legal and compliance. Each has internal documents the
  others should not see.
- Engineering documents (`docs/team-engineering/`) are **restricted test content**. No
  tenant is entitled to them. They exist to detect over-sharing.

| Folder                         | Docs | region                                 | audience_team         | sensitivity |
| ------------------------------ | ---- | -------------------------------------- | --------------------- | ----------- |
| `docs/global/`                 | 12   | global                                 | all                   | public      |
| `docs/sales-region-north/`     | 3    | sales-region-north                     | all                   | public      |
| `docs/sales-region-central/`   | 3    | sales-region-central                   | all                   | public      |
| `docs/sales-region-south/`     | 4    | sales-region-south                     | all                   | public      |
| `docs/team-support/`           | 3    | global                                 | team-support          | internal    |
| `docs/team-field-sales/`       | 3    | global (one doc sales-region-south)    | team-field-sales      | internal    |
| `docs/team-legal-compliance/`  | 2    | global (one doc sales-region-central)  | team-legal-compliance | internal    |
| `docs/team-engineering/`       | 2    | global                                 | team-engineering      | restricted  |

Every document has a `<file>.md.metadata.json` sidecar with `metadataAttributes`
`region`, `audience_team`, and `sensitivity`, used for knowledge base metadata
filtering. `manifest.json` lists every document with the same values, and
`infra/test/corpus.test.ts` checks that each sidecar matches its manifest entry.
