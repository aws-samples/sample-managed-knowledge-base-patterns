# Per-tenant retrieval instructions for Amazon Bedrock Managed Knowledge Base

Give each tenant of one shared
[Amazon Bedrock Managed Knowledge Base](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html)
its own voice, answer format, and pinned retrieval instruction version, while a
metadata filter built on the server keeps each tenant to its own documents. The sample
is the companion code of the AWS blog post "Customize answers per tenant in Amazon
Bedrock Managed Knowledge Base".

![Tenant applications call a backend that picks a per-tenant instruction version and metadata filter, then calls AgenticRetrieveStream on one shared managed knowledge base](docs/images/figure-1.png)

_Figure 1: One managed knowledge base with per-tenant instructions and filters._

The infrastructure is an AWS CDK app. The retrieval instructions, their versions, and
every request are SDK code, in Python and in TypeScript, with the same commands and the
same output. Design decisions and the service behavior behind them are in
[DESIGN.md](DESIGN.md).

## How it works

The fictitious company AnyCompany Smart Home sells a home controller and room sensors in
three sales regions. Its documents serve six tenants, three sales regions and three
internal teams, from one knowledge base:

| Tenant                  | Kind   | Retrieves                                                          | Answers                                           |
| ----------------------- | ------ | ------------------------------------------------------------------ | ------------------------------------------------- |
| `sales-region-north`    | region | Global and Sales Region North customer documents                   | English, dates as 2026-12-31, amounts as $5.00    |
| `sales-region-central`  | region | Global and Sales Region Central customer documents                 | Spanish, dates as 31/12/2026, amounts as 5,00 USD |
| `sales-region-south`    | region | Global and Sales Region South customer documents                   | English, dates as 1 Mar 2027, amounts as USD 5.00 |
| `team-support`          | team   | Every region's customer documents and the support team's notes     | A short ticket note                               |
| `team-field-sales`      | team   | Every region's customer documents and the field sales team's notes | A deal brief                                      |
| `team-legal-compliance` | team   | Every region's customer documents and the legal team's notes       | A risk memo that cites each document's version    |

For each request, the application does four things on the server, from the
authenticated tenant:

1. It picks the tenant's retrieval instruction and the version pinned in the tenant's
   release configuration.
2. It builds the tenant's metadata filter (`region` and `audience_team`), never from the
   question or other user input.
3. It puts a short tenant line, such as `Customer sales region: Sales Region Central.`,
   before the question.
4. It calls `AgenticRetrieveStream` on the shared knowledge base with all three.

Optional AWS Identity and Access Management (IAM) roles show how tag conditions limit
which instruction a tenant role can apply. The trace and AWS CloudTrail record which
instruction version answered.

A retrieval instruction changes how an answer is written. It isn't an authorization or
data-isolation boundary: the filter is what keeps a tenant to its own documents. See
[SECURITY.md](SECURITY.md).

![Three panels: instruction only, instruction plus a tenant metadata filter, and a separate knowledge base per tenant](docs/images/figure-2.png)

_Figure 2: Where tenant isolation comes from._

## What gets deployed

`npm run deploy` creates one AWS CloudFormation stack, `RetrievalInstructionsSample`:

- An Amazon S3 bucket with the 32 synthetic documents and their metadata files under
  `docs/`. Public access is blocked, objects are encrypted with S3 managed keys, and
  requests must use TLS.
- A shared managed knowledge base, `retrieval-instructions-sample-shared`, with an S3
  data source over `docs/`, and its service role.
- A Sales Region South knowledge base, `retrieval-instructions-sample-south`, with a data
  source over `docs/global/` and `docs/sales-region-south/` (16 documents), and its own
  service role.
- An ingestion job for each knowledge base, started on deploy, and three AWS Lambda
  functions that CDK uses to upload the documents, start the jobs, and empty the bucket
  when you delete the stack, with their log groups.

The SDK commands create 7 retrieval instructions in your account and Region, each with
version 1: one for each tenant, plus `assistant-structured-json` for the JSON example.
With `--combined`, they create 4 more. Everything the sample creates carries the tag
`app=retrieval-instructions-sample`.

Optional parts. None of them is needed for the core walkthrough:

- **Tenant roles.** An applier role and a tenant admin role for one tenant, plus a
  platform admin role that manages every instruction with a `tenant` tag. Created only
  when you deploy with `-c trustedPrincipalArn=...`. See
  [Check the tenant roles](#check-the-tenant-roles-optional).
- **The Sales Region South knowledge base.** On by default, and only the `multi-kb`
  step uses it. Deploy with `-c southKnowledgeBase=false` to leave it out.
- **Combined instructions** for a region and team pair, with
  `create-instructions --combined`.
- **A CloudTrail data-event trail**, created with the AWS CLI steps in
  [Optional data-event trail](#optional-data-event-trail).
- **An AWS KMS key** for the instructions. Documented in
  [Encrypt instructions with your own key](#encrypt-instructions-with-your-own-key), not
  used.

## Repository structure

```
corpus/          The 32 synthetic documents, their metadata files, and manifest.json
instructions/    The instruction text for each tenant, the combined cells, the JSON
                 example, and the support team's version 2 change
infra/           AWS CDK app (TypeScript) with cdk-nag
python/          The Python commands (src/ri_sample) and their tests
typescript/      The TypeScript commands (src) and their tests
test-fixtures/   Inputs and expected output that both languages' tests share
docs/images/     The figures
```

## Getting this sample

This sample lives in the
[sample-managed-knowledge-base-patterns](https://github.com/aws-samples/sample-managed-knowledge-base-patterns)
repository alongside other patterns that share no code with it. To get only this one,
have git fetch only this directory. With `--filter=blob:none` the file contents of the
other patterns are never downloaded.

```bash
# Clone the repository structure without any file contents
git clone --filter=blob:none --sparse \
  https://github.com/aws-samples/sample-managed-knowledge-base-patterns.git
cd sample-managed-knowledge-base-patterns

# Fetch only this sample
git sparse-checkout set retrieval-instructions

cd retrieval-instructions
```

Commands in this README run from the `retrieval-instructions` directory.

## Prerequisites

- An AWS account, and credentials with permissions to deploy the CDK app and to create
  retrieval instructions.
- An AWS Region with Managed Knowledge Base. The sample was tested in US East
  (N. Virginia) (`us-east-1`). See
  [Supported AWS Regions](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-regions.html).
- Python 3.10 or later through [uv](https://docs.astral.sh/uv/). uv installs Python 3.13
  when needed.
- Node.js 22 or later and npm.
- AWS CLI 2.38 or later, for the control-plane commands in this README. Older versions
  don't have the retrieval instruction commands.
- The AWS CDK comes from npm: the npm scripts run the pinned CDK CLI, so you don't need a
  global install. The account and Region need `cdk bootstrap` once (`npm run bootstrap`).
- Room for 7 retrieval instructions (11 with combined cells) under the quota of 50 per
  account and Region. `status` shows the headroom.

Boto3 1.43.118 and the AWS SDK for JavaScript v3 3.1155.0 come from the lockfiles.

## Cost

There is no always-on compute. The standing cost is the managed knowledge base index
storage, billed at $5.00 per GB of raw data per month, which comes to well under one cent
a month for the sample's 54 KB corpus (both knowledge bases). It accrues until you
[clean up](#clean-up).

Each pass of the walkthrough makes about 17 agentic retrieval calls (21 with the optional
steps), at $0.004 each plus $0.001 per underlying `Retrieve` call. Retrieval instructions
have no line item on the
[Amazon Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/). The optional
data-event trail bills $0.10 per 100,000 data events, plus S3 storage for the log files.
Its selector is scoped to the sample knowledge base, so it records only the sample's
calls.

## Deploy

```bash
npm ci
uv sync --locked
export AWS_REGION=us-east-1
```

The CDK app and both programs use `AWS_REGION` when it's set, and `us-east-1`
otherwise. They don't read the Region from your AWS CLI profile, so the stack and the
commands always land in the same Region. Export it anyway, so the AWS CLI commands in this
README use that Region too.

If this account and Region aren't bootstrapped for the AWS CDK yet, run
`npm run bootstrap` once. Then deploy:

```bash
npm run deploy
```

The deploy uploads the documents and starts ingestion. The stack prints these outputs:

| Output                                                                                    | Description                                               |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `SharedKnowledgeBaseId`, `SharedKnowledgeBaseArn`, `SharedDataSourceId`                   | The shared knowledge base and its data source             |
| `SouthKnowledgeBaseId`, `SouthKnowledgeBaseArn`, `SouthDataSourceId`                      | The Sales Region South knowledge base, when it's deployed |
| `CorpusBucketName`                                                                        | The bucket with the documents                             |
| `TenantRoleTenants`, `ApplierRoleArn...`, `TenantAdminRoleArn...`, `PlatformAdminRoleArn` | Only with the optional tenant roles                       |

You don't need to copy them: both programs read the outputs from the stack. Wait for
ingestion to finish:

```bash
uv run ri-sample status --wait
```

```text
Region: us-east-1
Stack: RetrievalInstructionsSample (CREATE_COMPLETE)
Tenant roles: none
Knowledge bases:
  knowledge base  id          data source  latest ingestion  started               scanned  indexed  failed
  shared          ABCDE12345  KLMNO12345   COMPLETE          2026-11-03T02:00:26Z  32       32       0
  south           FGHIJ67890  PQRST67890   COMPLETE          2026-11-03T02:00:27Z  16       16       0
Retrieval instructions in this account and Region: 0 of 50 (50 free)
Sample instructions: none (run create-instructions)
```

If the deploy fails with "No AWS account", configure AWS credentials, then deploy again.

## Walk through the post

Each step shows the Python command. For the TypeScript version, replace `uv run ri-sample`
with `npm run -s ri-sample --`, which writes the same output. Both programs read and
write one state file, `sample-state.json`, so you can create the instructions in one
language and ask in the other. Don't run both at the same time.

The example outputs come from a test run. Answers vary from run to run, even at a pinned
version, and long ones are cut at `[...]`.

### 1. Create and pin an instruction for each tenant

```bash
uv run ri-sample create-instructions
```

For each tenant, the command sends `CreateRetrievalInstruction` with the text in
`instructions/tenants.json`, waits for the review, creates version 1, and pins it in the
state file. Each instruction is named `assistant-<tenant>` and tagged with
`tenant=<tenant>` and `app=retrieval-instructions-sample`.

```text
Region: us-east-1
Retrieval instructions in this account and Region: 0 of 50 before this run, 7 to create
  key                    name                             id          result   versions  live
  sales-region-north     assistant-sales-region-north     abcde12345  created  1         1
  sales-region-central   assistant-sales-region-central   bcdef23456  created  1         1
  sales-region-south     assistant-sales-region-south     cdefg34567  created  1         1
  team-support           assistant-team-support           defgh45678  created  1         1
  team-field-sales       assistant-team-field-sales       efghi56789  created  1         1
  team-legal-compliance  assistant-team-legal-compliance  fghij67890  created  1         1
  structured-json        assistant-structured-json        ghijk78901  created  1         1
Retrieval instructions in this account and Region: 7 of 50 after this run
```

If a review fails, the command prints each reason. Edit the instruction in
`instructions/`, then run the command again: it updates the rejected instruction in place.
If you raised the instruction quota, pass it with `--quota <value>`.

### 2. Compare with no instruction

Ask the same return question without an instruction, then as a Sales Region Central
customer:

```bash
uv run ri-sample baseline --question "How many days do I have to return an AnySmartProduct-5?"
uv run ri-sample ask --tenant sales-region-central \
  --question "How many days do I have to return an AnySmartProduct-5?"
```

```text
Tenant: none
Instruction: none
Applied: none
Filter: none
Message:
  How many days do I have to return an AnySmartProduct-5?
Answer:
The return window for an AnySmartProduct-5 depends on where it was purchased, since the global policy sets a default that regional addenda can override:

| Sales region | Return window | Restocking fee (opened units) |
|---|---|---|
| Global base (no regional addendum) | 30 days from delivery | $10.00 |
| Sales Region North | 40 days from delivery | $15.00 |
| Sales Region Central | 45 days from delivery | $12.00 |
| Sales Region South | 14 days from delivery (unopened only) | $25.00 (all returns) |
[...]
Could you tell me which sales region you purchased the AnySmartProduct-5 in (e.g., North, Central, South, or another region), and whether it's a new or reconditioned unit? That will let me give you the exact number of days that applies to your case.

Tenant: sales-region-central
Instruction: assistant-sales-region-central version 1
Applied: bcdef23456 version 1
Filter: audience_team = all; region in (global, sales-region-central)
Message:
  Customer sales region: Sales Region Central.
  How many days do I have to return an AnySmartProduct-5?
Answer:
Tiene 45 días desde la fecha de entrega para devolver su AnySmartProduct-5 comprado en Sales Region Central.

Algunos detalles importantes:
- Puede devolver la unidad aunque esté abierta, siempre que incluya todos los accesorios.
- Si la unidad está abierta, se aplica una tarifa de reacondicionamiento de 12,00 USD; si está sin abrir y en su empaque original sellado, no se cobra ninguna tarifa.
- Si su compra cae dentro de un período de extensión de devolución por temporada navideña, se aplica la fecha que sea más tardía entre la extensión y la ventana normal de 45 días.
- Para iniciar la devolución, contáctenos con su número de pedido y le emitiremos la autorización de devolución junto con una etiqueta prepagada.

Si su AnySmartProduct-5 fue comprado en otra región de ventas, se aplican las reglas de esa región y le pedimos que se comunique con los contactos de soporte global correspondientes.

Source: central-returns-addendum.md
```

`baseline` sends no instruction, no tenant line, and no filter. `ask` sends the tenant's
instruction at its pinned version, the tenant line, and the tenant's filter.

### 3. Answer as three tenants

```bash
uv run ri-sample ask --tenant sales-region-north \
  --question "How many days do I have to return an AnySmartProduct-5?"
uv run ri-sample ask --tenant sales-region-central \
  --question "How many days do I have to return an AnySmartProduct-5?"
uv run ri-sample ask --tenant team-support \
  --question "How many days do I have to return an AnySmartProduct-5?"
```

```text
Tenant: sales-region-north
Instruction: assistant-sales-region-north version 1
Applied: abcde12345 version 1
Filter: audience_team = all; region in (global, sales-region-north)
Message:
  Customer sales region: Sales Region North.
  How many days do I have to return an AnySmartProduct-5?
Answer:
You have 40 days from the delivery date to return your AnySmartProduct-5, since you bought it in Sales Region North. The unit can be opened as long as all accessories that came in the box are included. If it's opened, a $15.00 restocking fee applies; if it's unopened and in sealed packaging, there's no fee. If your purchase falls within a holiday return extension period, whichever is later between the extension date and this 40-day window will apply. To start a return, just contact Sales Region North support with your order number, and they'll issue a return authorization and prepaid label.

Source: north-returns-addendum.md

Tenant: sales-region-central
Instruction: assistant-sales-region-central version 1
Applied: bcdef23456 version 1
Filter: audience_team = all; region in (global, sales-region-central)
Message:
  Customer sales region: Sales Region Central.
  How many days do I have to return an AnySmartProduct-5?
Answer:
Tiene 45 días desde la fecha de entrega para devolver su AnySmartProduct-5 comprado en Sales Region Central.
[...]
Source: central-returns-addendum.md

Tenant: team-support
Instruction: assistant-team-support version 1
Applied: defgh45678 version 1
Filter: audience_team in (all, team-support)
Message:
  How many days do I have to return an AnySmartProduct-5?
Answer:
Ticket note:
- Global base return window is 30 days from delivery; opened units allowed with all accessories; $10 restocking fee if opened, none if unopened.
- Sales region addenda override this: North 40 days, Central 45 days, South 14 days (unopened only).
- If the unit is reconditioned, the window is 7 days with no restocking fee instead.
- Return window depends on the sales region of purchase, which is not stated in the query.

Next action: Confirm the sales region of purchase (and whether the unit is new or reconditioned) with the customer before quoting the exact return window.
```

The support team's instruction asks for a ticket note. Without `--region`, a team tenant
gets no tenant line, so the note covers every region.

### 4. Check isolation

`isolation` makes two calls with the tenant's instruction and tenant line, one without the
tenant filter and one with it, and lists every document each call retrieved:

```bash
uv run ri-sample isolation --tenant sales-region-north \
  --question "How many days do I have to return an AnySmartProduct-5?"
uv run ri-sample isolation --tenant sales-region-north \
  --question "Why do some AnySmartProduct-6 units restart after firmware 5.3.2, and what is the root cause?"
```

```text
Tenant: sales-region-north
Question: How many days do I have to return an AnySmartProduct-5?

Without the tenant filter:
  [...]
  Outside the tenant's entitlement: 2 of 7 documents

With the tenant filter:
  [...]
  Outside the tenant's entitlement: 0 of 7 documents
Result: PASS (the filtered request retrieved only documents the tenant is entitled to)

Tenant: sales-region-north
Question: Why do some AnySmartProduct-6 units restart after firmware 5.3.2, and what is the root cause?

Without the tenant filter:
  step                  document                                     scope               entitled
  SpeculativeRetrieval  eng-known-issue-ki-4471.md                   team-engineering    no
  SpeculativeRetrieval  firmware-release-notes-public-5x.md          global              yes
  SpeculativeRetrieval  eng-firmware-diagnostics-internal.md         team-engineering    no
  SpeculativeRetrieval  support-ticket-playbook.md                   team-support        no
  SpeculativeRetrieval  product-overview-anysmartproduct-5-and-6.md  global              yes
  SpeculativeRetrieval  north-returns-addendum.md                    sales-region-north  yes
  SpeculativeRetrieval  north-warranty-addendum.md                   sales-region-north  yes
  result                eng-known-issue-ki-4471.md                   team-engineering    no
  result                firmware-release-notes-public-5x.md          global              yes
  result                eng-firmware-diagnostics-internal.md         team-engineering    no
  result                support-ticket-playbook.md                   team-support        no
  result                product-overview-anysmartproduct-5-and-6.md  global              yes
  result                north-returns-addendum.md                    sales-region-north  yes
  result                north-warranty-addendum.md                   sales-region-north  yes
  Outside the tenant's entitlement: 3 of 7 documents

With the tenant filter:
  step                  document                                     scope               entitled
  SpeculativeRetrieval  firmware-release-notes-public-5x.md          global              yes
  SpeculativeRetrieval  product-overview-anysmartproduct-5-and-6.md  global              yes
  SpeculativeRetrieval  north-returns-addendum.md                    sales-region-north  yes
  SpeculativeRetrieval  north-warranty-addendum.md                   sales-region-north  yes
  SpeculativeRetrieval  north-local-support-and-conventions.md       sales-region-north  yes
  SpeculativeRetrieval  global-warranty-policy-v3-0.md               global              yes
  result                firmware-release-notes-public-5x.md          global              yes
  result                product-overview-anysmartproduct-5-and-6.md  global              yes
  result                north-returns-addendum.md                    sales-region-north  yes
  result                north-warranty-addendum.md                   sales-region-north  yes
  result                north-local-support-and-conventions.md       sales-region-north  yes
  result                global-warranty-policy-v3-0.md               global              yes
  Outside the tenant's entitlement: 0 of 6 documents
Result: PASS (the filtered request retrieved only documents the tenant is entitled to)
```

The command fails (exit code 1) if the filtered call retrieved any document the tenant
isn't entitled to. The second question asks about the restricted engineering notes, which
belong to no tenant.

### 5. Cover a user in a region and a team

A support agent in Sales Region South uses the support team's instruction, the region's
tenant line, and a filter for that region and team:

```bash
uv run ri-sample ask --tenant team-support --region sales-region-south \
  --question "How many days do I have to return an AnySmartProduct-5?"
```

```text
Tenant: team-support
Instruction: assistant-team-support version 1
Applied: defgh45678 version 1
Filter: audience_team in (all, team-support); region in (global, sales-region-south)
Message:
  Customer sales region: Sales Region South.
  How many days do I have to return an AnySmartProduct-5?
Answer:
Ticket note:
- Customer purchased AnySmartProduct-5 in Sales Region South.
- South returns addendum replaces global window: return period is 14 days from delivery date, not the global 30 days.
- Only unopened units in original sealed packaging qualify; opened units cannot be returned for refund in this region.
- A $25.00 restocking fee applies to all South returns, including unopened units.
- Purchase evidence (receipt, invoice, or order confirmation) is required to process the return.

Next action: Confirm the unit is unopened and request purchase evidence before processing the return under the Sales Region South returns addendum.
```

Optional: to try one combined instruction per region and team pair instead, create the
four combined cells (4 more instructions), then ask with the combined key:

```bash
uv run ri-sample create-instructions --combined
uv run ri-sample ask --tenant sales-region-south.team-support \
  --question "How many days do I have to return an AnySmartProduct-5?"
```

### 6. Trace each answer to a tenant and version

```bash
uv run ri-sample ask --tenant sales-region-central --trace \
  --question "How many days do I have to return an AnySmartProduct-5?"
```

```text
Tenant: sales-region-central
Instruction: assistant-sales-region-central version 1
Applied: bcdef23456 version 1
Planning trace event:
  {"step": "Planning", "status": "IN_PROGRESS", "message": "Agent planning started", "appliedInstruction": {"id": "bcdef23456", "version": "1"}}
Filter: audience_team = all; region in (global, sales-region-central)
Message:
  Customer sales region: Sales Region Central.
  How many days do I have to return an AnySmartProduct-5?
Answer:
Tiene 45 días desde la fecha de entrega para devolver su AnySmartProduct-5. Esta es la ventana de devolución específica para Sales Region Central, que sustituye a la regla global de 30 días. Si el equipo viene abierto, puede devolverlo igualmente siempre que incluya todos los accesorios; si está sin abrir y con el empaque original sellado, no se le cobrará ningún cargo por reposición, y si viene abierto se aplica un cargo de 12,00 USD. Además, si su compra cayó dentro del periodo de extensión de devoluciones por fiestas, se aplica la fecha que sea más tardía entre esa extensión y la ventana normal de 45 días. Para iniciar la devolución, solo tiene que contactar al soporte de Sales Region Central con su número de pedido, y ellos le darán la autorización de devolución y una etiqueta prepagada.

Source: central-returns-addendum.md
```

`--trace` prints the first `Planning` trace event, whose `appliedInstruction` holds the
ID and version that answered. Every `ask` also checks it against the requested version.

Each apply also creates a `GetRetrievalInstruction` management event in CloudTrail event
history, invoked by `bedrock.amazonaws.com` under your session, with the version when
one is pinned. Events take a few minutes to appear:

```bash
uv run ri-sample cloudtrail --since 60 --wait
```

```text
GetRetrievalInstruction calls made by Amazon Bedrock in the last 60 minutes:
  time                  tenant                version  caller role          error
  2026-11-03T02:22:01Z  sales-region-central  1        ExampleOperatorRole  none
  2026-11-03T02:26:02Z  sales-region-north    1        ExampleOperatorRole  none
  2026-11-03T02:26:21Z  sales-region-central  1        ExampleOperatorRole  none
  2026-11-03T02:26:38Z  team-support          1        ExampleOperatorRole  none
  2026-11-03T02:35:37Z  sales-region-north    1        ExampleOperatorRole  none
  2026-11-03T02:35:39Z  sales-region-north    1        ExampleOperatorRole  none
  2026-11-03T02:35:52Z  sales-region-north    1        ExampleOperatorRole  none
  2026-11-03T02:35:54Z  sales-region-north    1        ExampleOperatorRole  none
AgenticRetrieveStream events in event history for the same window: 0 (a data event: only a trail that records data events has it)
```

The `AgenticRetrieveStream` call itself is a data event, which event history doesn't
show. To record it, see [Optional data-event trail](#optional-data-event-trail).

### 7. Release a change to one tenant

`support-v2` updates the support team's instruction with the answer format in
`instructions/support-v2.json`, waits for the review, and creates version 2. It doesn't
move any pin:

```bash
uv run ri-sample support-v2
```

```text
Updated assistant-team-support (defgh45678) and created version 2.
Change: answerFormat gains a final line 'Ticket ref: pending' after the 'Next action:' line; every other field is unchanged.
Release pins are unchanged:
  key                    name                             latest version  live  canary
  sales-region-north     assistant-sales-region-north     1               1     none
  sales-region-central   assistant-sales-region-central   1               1     none
  sales-region-south     assistant-sales-region-south     1               1     none
  team-support           assistant-team-support           2               1     none
  team-field-sales       assistant-team-field-sales       1               1     none
  team-legal-compliance  assistant-team-legal-compliance  1               1     none
  structured-json        assistant-structured-json        1               1     none
To send one request in five to version 2, run: release set --tenant team-support --live 1 --canary 2 --every 5
```

Send one request in two to version 2, check which version each request gets, then promote
it:

```bash
uv run ri-sample release set --tenant team-support --live 1 --canary 2 --every 2
uv run ri-sample release route --tenant team-support
uv run ri-sample ask --tenant team-support --request-index 0 \
  --question "How many days do I have to return an AnySmartProduct-5?"
uv run ri-sample ask --tenant team-support --request-index 1 \
  --question "How many days do I have to return an AnySmartProduct-5?"
uv run ri-sample release set --tenant team-support --live 2
uv run ri-sample ask --tenant sales-region-north \
  --question "How many days do I have to return an AnySmartProduct-5?"
uv run ri-sample release show
```

```text
Release for team-support: live 1, canary 2 (1 in 2)

Tenant: team-support
Release: live 1, canary 2 (1 in 2)
  request  version
  0        2
  1        1
  2        2
  3        1
  4        2
  5        1
  6        2
  7        1
  8        2
  9        1
Requests per version: 1 = 5, 2 = 5

Tenant: team-support
Instruction: assistant-team-support version 2 (routed by the release configuration, request 0)
Applied: defgh45678 version 2
Filter: audience_team in (all, team-support)
Message:
  How many days do I have to return an AnySmartProduct-5?
Answer:
Ticket note:
- Global base return window for AnySmartProduct-5 is 30 days from delivery date; opened units allowed with all accessories included.
- Sales region addenda override this: Region North = 40 days, Region Central = 45 days, Region South = 14 days, unopened only.
- Reconditioned units (labeled "Reconditioned") get only 7 days, no restocking fee.
- Agent must confirm the sales region of purchase to give the exact window, since the question doesn't name one.
Next action: Ask customer to confirm sales region of purchase and whether unit is new or reconditioned, then apply matching policy.
Ticket ref: pending

Tenant: team-support
Instruction: assistant-team-support version 1 (routed by the release configuration, request 1)
Applied: defgh45678 version 1
Filter: audience_team in (all, team-support)
Message:
  How many days do I have to return an AnySmartProduct-5?
Answer:
Ticket note:
- Return window depends on the sales region where the unit was purchased, not where the customer lives.
- Global base policy (no regional addendum applies): 30 days from delivery date, opened units allowed if all accessories included.
- Sales Region North: 40 days; Sales Region Central: 45 days; Sales Region South: 14 days, unopened only.
- Reconditioned units follow a separate rule: 7 days from delivery, no restocking fee.
Next action: Confirm the sales region of purchase with the customer (and whether the unit is new or reconditioned) before quoting the exact return window.

Release for team-support: live 2, no canary

Tenant: sales-region-north
Instruction: assistant-sales-region-north version 1
Applied: abcde12345 version 1
Filter: audience_team = all; region in (global, sales-region-north)
Message:
[...]

Release configuration in sample-state.json:
  key                    name                             versions  live  canary
  sales-region-north     assistant-sales-region-north     1         1     none
  sales-region-central   assistant-sales-region-central   1         1     none
  sales-region-south     assistant-sales-region-south     1         1     none
  team-support           assistant-team-support           1, 2      2     none
  team-field-sales       assistant-team-field-sales       1         1     none
  team-legal-compliance  assistant-team-legal-compliance  1         1     none
  structured-json        assistant-structured-json        1         1     none
```

Request 0 goes to version 2 and request 1 to version 1. After the promotion, the other
five tenants still answer with version 1. To roll back, run
`uv run ri-sample release set --tenant team-support --live 1`. The release configuration
lives in `sample-state.json`; Amazon Bedrock serves whichever version each request pins.

### 8. Return structured JSON

`assistant-structured-json` has only an `answerFormat`, which asks for one JSON object
with five keys. The command applies it with a filter for public documents and validates
the reply:

```bash
uv run ri-sample structured-json --question "How long is the warranty on an AnySmartProduct-6?"
```

```text
Instruction: assistant-structured-json version 1
Applied: ghijk78901 version 1
Filter: audience_team = all
Question: How long is the warranty on an AnySmartProduct-6?
Reply:
{"answer": "It depends on where the AnySmartProduct-6 was purchased. The global base warranty is 24 months from the purchase date. However, regional addenda override this: in Sales Region Central it's 36 months, in Sales Region North it's 30 months, and in Sales Region South it's 12 months. Note that the warranty term does not restart upon repair or replacement, and if the unit is reconditioned, a separate 6-month warranty from the delivery date applies instead of the regular terms. Could you tell me which sales region the unit was purchased in, and whether it is a new or reconditioned unit, so I can give you the exact warranty length?", "sources": ["global-warranty-policy-v3-0.md", "central-warranty-addendum.md", "north-warranty-addendum.md", "south-warranty-addendum.md", "reconditioned-units-policy.md"], "confidence": "high", "followUpQuestion": "Which sales region was the AnySmartProduct-6 purchased in, and is it a new or reconditioned unit?", "outOfScope": false}
Validation: PASS (one JSON object with exactly the five keys)
  answer: It depends on where the AnySmartProduct-6 was purchased. The global base warranty is 24 months from the purchase date. However, regional addenda override this: in Sales Region Central it's 36 months, in Sales Region North it's 30 months, and in Sales Region South it's 12 months. Note that the warranty term does not restart upon repair or replacement, and if the unit is reconditioned, a separate 6-month warranty from the delivery date applies instead of the regular terms. Could you tell me which sales region the unit was purchased in, and whether it is a new or reconditioned unit, so I can give you the exact warranty length?
  sources: global-warranty-policy-v3-0.md, central-warranty-addendum.md, north-warranty-addendum.md, south-warranty-addendum.md, reconditioned-units-policy.md
  confidence: high
  followUpQuestion: Which sales region was the AnySmartProduct-6 purchased in, and is it a new or reconditioned unit?
  outOfScope: false
```

The full `answerFormat` text is in `instructions/structured-json.json`:

```text
Reply with exactly one JSON object and nothing else. Do not use markdown, do not use code fences, and do not write any text before or after the object.
The object has exactly these five keys and no others:
- "answer": a string. The answer to the customer's question, written only from the retrieved documents.
- "sources": an array of strings. The file names of the documents the answer relies on, exactly as the documents are named. Use an empty array if no document supports an answer.
- "confidence": one of "high", "medium" or "low". Use "high" when the documents state the answer directly, "medium" when you combined or inferred across documents, and "low" when support is thin or missing.
- "followUpQuestion": a string or null. One clarifying question when the customer's situation is ambiguous, otherwise null.
- "outOfScope": a boolean. true when the documents do not contain the information needed to answer the question, otherwise false.
```

### 9. Query two knowledge bases with a filter each

`multi-kb` asks as Sales Region South, the only tenant with its own knowledge base. One
request applies the South instruction to two retrievers: the shared knowledge base,
filtered to global documents, and the South knowledge base, filtered to Sales Region South
documents.

```bash
uv run ri-sample multi-kb --question "How many days do I have to return an AnySmartProduct-5?"
uv run ri-sample multi-kb --no-filters \
  --question "How many days do I have to return an AnySmartProduct-5?"
```

```text
Tenant: sales-region-south
Instruction: assistant-sales-region-south version 1
Applied: cdefg34567 version 1
Retrievers:
  retriever  knowledge base  filter
  shared     ABCDE12345      audience_team = all; region = global
  south      FGHIJ67890      audience_team = all; region = sales-region-south
Message:
  Customer sales region: Sales Region South.
  How many days do I have to return an AnySmartProduct-5?
Answer:
You have 14 days from the delivery date to return an AnySmartProduct-5 purchased in Sales Region South. This Sales Region South return window replaces the global 30-day window and applies all year, including the November–December holiday period, since the holiday return extension does not apply in Sales Region South. Please note that only unopened units in their original sealed packaging are eligible for return, a restocking fee of USD 25.00 applies to every return (including unopened units), and purchase evidence is required for every return. Opened units cannot be returned for a refund, though a faulty opened unit may be assessed under the Sales Region South warranty addendum.

To start a return, contact Sales Region South support with your order number and purchase evidence.

Source: south-returns-addendum.md

Documents:
  retriever  document                          scope               entitled
  shared     global-returns-policy-v2-0.md     global              yes
  south      south-returns-addendum.md         sales-region-south  yes
  south      south-warranty-addendum.md        sales-region-south  yes
  shared     returns-policy-2024-archived.md   global              yes
  shared     faq-general.md                    global              yes
  shared     holiday-return-extension-2026.md  global              yes
  shared     global-warranty-policy-v3-0.md    global              yes
  shared     reconditioned-units-policy.md     global              yes
  Outside the tenant's entitlement: 0 of 8 documents

Tenant: sales-region-south
Instruction: assistant-sales-region-south version 1
Applied: cdefg34567 version 1
Retrievers:
  retriever  knowledge base  filter
  shared     ABCDE12345      none (--no-filters)
  south      FGHIJ67890      none (--no-filters)
Message:
  Customer sales region: Sales Region South.
  How many days do I have to return an AnySmartProduct-5?
Answer:
You have 14 days from the delivery date to return an AnySmartProduct-5 bought in Sales Region South. Only unopened units in their original sealed packaging are eligible for a refund return, and purchase evidence is required for every return. Please note that this 14-day window applies all year, as the holiday return extension does not apply in Sales Region South. A restocking fee of USD 25.00 applies to every return in Sales Region South, including unopened units. If your unit is opened and faulty, it cannot be returned for a refund, but it may be assessed under the Sales Region South warranty addendum instead. To start a return, contact Sales Region South support with your order number and purchase evidence.

Source: south-returns-addendum.md

Documents:
  retriever  document                                scope                  entitled
  shared     south-returns-addendum.md               sales-region-south     yes
  south      south-returns-addendum.md               sales-region-south     yes
  south      south-warranty-addendum.md              sales-region-south     yes
  south      holiday-return-extension-2026.md        global                 yes
  south      global-returns-policy-v2-0.md           global                 yes
  south      south-local-support-and-conventions.md  sales-region-south     yes
  south      returns-policy-2024-archived.md         global                 yes
  south      faq-general.md                          global                 yes
  shared     north-returns-addendum.md               sales-region-north     no
  shared     central-returns-addendum.md             sales-region-central   no
  shared     south-warranty-addendum.md              sales-region-south     yes
  shared     holiday-return-extension-2026.md        global                 yes
  shared     global-returns-policy-v2-0.md           global                 yes
  shared     legal-central-consumer-terms-lc212.md   team-legal-compliance  no
  shared     south-local-support-and-conventions.md  sales-region-south     yes
  Outside the tenant's entitlement: 3 of 10 documents
```

`--no-filters` sends the same request without the retriever filters, so you can see what
they remove.

## Check the tenant roles (optional)

The tenant roles trust one principal that you name. Look up the ARN of the role you use:

```bash
aws sts get-caller-identity --query Arn --output text
# arn:aws:sts::123456789012:assumed-role/<role-name>/<session>
aws iam get-role --role-name <role-name> --query Role.Arn --output text
```

Deploy again with that ARN, then run the five checks:

```bash
npm run deploy -- -c trustedPrincipalArn=<role-arn>
uv run ri-sample verify-abac
```

```text
Tenant: sales-region-north
Other tenant: sales-region-central
  check  role            action                                                             expected  observed  result
  1      applier         apply assistant-sales-region-north                                 allow     allow     PASS
  2      applier         apply assistant-sales-region-central                               deny      deny      PASS
  3      tenant admin    tag assistant-sales-region-central with tenant=sales-region-north  deny      deny      PASS
  4      tenant admin    tag assistant-sales-region-north with app=verify-abac-check        deny      deny      PASS
  5      platform admin  read assistant-sales-region-central                                allow     allow     PASS
Result: PASS (5 of 5 checks as expected)
```

The checks assume the applier, the tenant admin, and the platform admin, and none of
them creates an instruction:

1. The applier applies its own tenant's instruction (allowed).
2. The applier applies another tenant's instruction (denied).
3. The tenant admin retags another tenant's instruction into its own scope (denied).
4. The tenant admin changes the `app` tag on its own instruction (denied).
5. The platform admin reads another tenant's instruction (allowed).

The platform admin manages every retrieval instruction in the account and Region that
has a `tenant` tag, including one created as the post shows, with only that tag. In an
account that other applications share, narrow it with another tag, as
[SECURITY.md](SECURITY.md#what-the-iam-tag-conditions-cover) describes.

Two notes:

- Pass the same `-c trustedPrincipalArn=<role-arn>` on every later deploy to keep the
  roles. A deploy without it removes them.
- The roles cover `sales-region-north` by default. To add tenants, list them:
  `npm run deploy -- -c trustedPrincipalArn=<role-arn> -c tenantRoles=sales-region-north,sales-region-central`.

## Optional data-event trail

CloudTrail records `AgenticRetrieveStream` as a data event, and only on a trail that
selects knowledge base data events. These AWS CLI steps create a trail scoped to the
shared knowledge base. Replace `amzn-s3-demo-trail-bucket` with a bucket name of your
own, `<Region>` with your Region, `<account-id>` with your account ID, and
`<SharedKnowledgeBaseArn>` with the stack output.

```bash
aws s3api create-bucket --bucket amzn-s3-demo-trail-bucket
# Outside us-east-1, add: --create-bucket-configuration LocationConstraint=<Region>
aws s3api put-bucket-tagging --bucket amzn-s3-demo-trail-bucket \
  --tagging 'TagSet=[{Key=app,Value=retrieval-instructions-sample}]'
aws s3api put-public-access-block --bucket amzn-s3-demo-trail-bucket \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Save this bucket policy outside the checkout, for example as
`/tmp/trail-bucket-policy.json`. It lets only this trail write to the bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AWSCloudTrailAclCheck",
      "Effect": "Allow",
      "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:GetBucketAcl",
      "Resource": "arn:aws:s3:::amzn-s3-demo-trail-bucket",
      "Condition": {
        "StringEquals": {
          "aws:SourceArn": "arn:aws:cloudtrail:<Region>:<account-id>:trail/retrieval-instructions-sample-data-events"
        }
      }
    },
    {
      "Sid": "AWSCloudTrailWrite",
      "Effect": "Allow",
      "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::amzn-s3-demo-trail-bucket/AWSLogs/<account-id>/*",
      "Condition": {
        "StringEquals": {
          "s3:x-amz-acl": "bucket-owner-full-control",
          "aws:SourceArn": "arn:aws:cloudtrail:<Region>:<account-id>:trail/retrieval-instructions-sample-data-events"
        }
      }
    }
  ]
}
```

```bash
aws s3api put-bucket-policy --bucket amzn-s3-demo-trail-bucket \
  --policy file:///tmp/trail-bucket-policy.json
aws cloudtrail create-trail --name retrieval-instructions-sample-data-events \
  --s3-bucket-name amzn-s3-demo-trail-bucket \
  --tags-list Key=app,Value=retrieval-instructions-sample
aws cloudtrail put-event-selectors --trail-name retrieval-instructions-sample-data-events \
  --advanced-event-selectors '[{"Name": "Sample knowledge base data events", "FieldSelectors": [
    {"Field": "eventCategory", "Equals": ["Data"]},
    {"Field": "resources.type", "Equals": ["AWS::Bedrock::KnowledgeBase"]},
    {"Field": "resources.ARN", "Equals": ["<SharedKnowledgeBaseArn>"]}]}]'
aws cloudtrail start-logging --name retrieval-instructions-sample-data-events
```

Wait five minutes before the first call, because the trail can miss calls made in the first
few minutes after `start-logging`. Then run one `ask` from the walkthrough. CloudTrail
delivers log files to the bucket, usually within 15 minutes. The record has `eventName`
`AgenticRetrieveStream` and `eventCategory` `Data`:

```text
{"eventName": "AgenticRetrieveStream", "eventCategory": "Data", "eventTime": "2026-11-03T04:21:49Z"}
```

The trail bills $0.10 per 100,000 data events, plus S3 storage for the log files. Delete
it when you're done:

```bash
aws cloudtrail stop-logging --name retrieval-instructions-sample-data-events
aws cloudtrail delete-trail --name retrieval-instructions-sample-data-events
aws s3 rm s3://amzn-s3-demo-trail-bucket --recursive
aws s3api delete-bucket --bucket amzn-s3-demo-trail-bucket
```

## Where the post's code lives

| Post section                                     | Python (`python/src/ri_sample/`)                                                            | TypeScript (`typescript/src/`)                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Prerequisites (client setup)                     | `config.py`                                                                                 | `config.ts`                                                                        |
| Create a retrieval instruction for each tenant   | `instructions.py` `create_and_pin()`, `poll.py`                                             | `instructions.ts` `createAndPin()`, `poll.ts`                                      |
| Keep tenant data apart with metadata filters     | `filters.py` `eq()`, `filter_for()`; `tenancy.py`                                           | `filters.ts` `eq()`, `filterFor()`; `tenancy.ts`                                   |
| Answer as the tenant                             | `ask.py` `ask_as_tenant()`                                                                  | `ask.ts` `askAsTenant()`                                                           |
| Cover users who belong to a region and a team    | `tenancy.py` `tenant_scope()`, `labels.py`                                                  | `tenancy.ts` `tenantScope()`, `labels.ts`                                          |
| Scope tenant roles with instruction tags         | `infra/lib/constructs/tenant-roles.ts`, `platform-admin-role.ts`; `abac.py` `verify_abac()` | the same CDK constructs; `abac.ts` `verifyAbac()`                                  |
| Trace each answer to a tenant and version        | `ask.py` `read_stream()`; `cloudtrail.py` `lookup()`                                        | `ask.ts` `readStream()`; `cloudtrail.ts` `lookup()`                                |
| Release instruction changes one tenant at a time | `release.py` `version_for()`; `instructions.py` `update_answer_format()`                    | `release.ts` `versionFor()`; `instructions.ts` `updateAnswerFormat()`              |
| Return structured JSON                           | `structured_json.py` `validate_reply()`; `instructions/structured-json.json`                | `structured-json.ts` `validateReply()`                                             |
| Apply one instruction across knowledge bases     | `ask.py` `build_request()`, `send_request()`; `tenancy.py` `south_retriever_filters()`      | `ask.ts` `buildRequest()`, `sendRequest()`; `tenancy.ts` `southRetrieverFilters()` |
| Clean up                                         | `instructions.py` `delete()`; `commands.py` `cmd_teardown()`                                | `instructions.ts` `deleteInstruction()`; `commands.ts` `cmdTeardown()`             |

The command-line entry points are `python/src/ri_sample/cli.py` and
`typescript/src/cli.ts`, and each command is a function in `commands.py` and
`commands.ts`.

## Configuration

Pass context values to `npm run deploy` after `--`, for example
`npm run deploy -- -c southKnowledgeBase=false`. Defaults are in `infra/cdk.json`.

| Key                   | Default              | Description                                                                                                        |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `trustedPrincipalArn` | none                 | The IAM role or user ARN that the tenant roles trust. Without it, the stack creates no tenant roles                |
| `tenantRoles`         | `sales-region-north` | Comma-separated tenant keys that get an applier and a tenant admin role. Read only with `trustedPrincipalArn`      |
| `southKnowledgeBase`  | `true`               | Deploy the Sales Region South knowledge base. Only the `multi-kb` step needs it                                    |
| `account`             | none                 | An account ID for `cdk synth` without credentials, such as `123456789012`. A deploy uses your credentials' account |

`AWS_REGION` sets the Region for the stack and both programs (default `us-east-1`).

Instruction names are fixed (`assistant-<tenant>`), so the sample supports one deployment
per account and Region.

## Encrypt instructions with your own key

To encrypt an instruction with an AWS KMS customer managed key, set
`customerEncryptionKeyArn` in `CreateRetrievalInstruction`. You can set it only when you
create the instruction; you can't add or change the key later. The key policy needs the
statement in
[Encryption of retrieval instructions](https://docs.aws.amazon.com/bedrock/latest/userguide/encryption-kb.html#encryption-kb-retrieval-instruction).
The sample doesn't use a key.

## Development

```bash
npm run verify    # prettier check, eslint, tsc, vitest (CDK, cdk-nag, TypeScript), cdk synth with cdk-nag
uv run --frozen ruff check python
uv run --frozen ruff format --check python
uv run --frozen mypy --strict
uv run --frozen pytest
UV_PROJECT_ENVIRONMENT=.venv-py310 uv run --locked --python 3.10 pytest
```

`npm run synth:example` synthesizes the stack, with the optional tenant roles, for the
example account `123456789012` without credentials, as CI does. cdk-nag runs inside
synth, so an unacknowledged finding fails it. The last command runs the Python tests on
Python 3.10 in a separate environment, so `.venv` stays as it is.

## Troubleshooting

- **The deploy fails on `StartIngestion` with a conflict.** An ingestion job is already
  running on the data source. Wait for it to finish (`uv run ri-sample status --wait`),
  then deploy again.
- **"stack RetrievalInstructionsSample not found".** The commands look in `AWS_REGION`, or
  `us-east-1` when it isn't set. Set `AWS_REGION` to the Region you deployed to.
- **"Invalid S3 bucket name", or cdk-nag `IAM5` findings on ARNs that contain
  `<AWS::Partition>`.** `AWS_REGION` is empty or isn't a Region name. Check its value.
- **Synth fails with `F3006` on `AWS::Bedrock::KnowledgeBase`.** The Region has no Managed
  Knowledge Base. Choose a Region from the prerequisites link.
- **"an instruction named ... already exists".** An instruction with a sample name exists,
  but the state file doesn't record it. If an earlier run of this sample created it, run
  `uv run ri-sample teardown --yes`, then `create-instructions` again.
- **"sample-state.json was written for account ...".** The state file belongs to another
  account or Region. Switch credentials or Region, or run `teardown` where it was
  written.
- **The quota guard stops `create-instructions`.** The account doesn't have room for the
  instructions. Delete instructions you no longer need, or request a quota increase and
  pass `--quota <value>`.
- **A review is rejected.** The command prints each field and reason. Edit the text in
  `instructions/` and run the command again.

## Clean up

First delete the retrieval instructions. Without `--yes`, `teardown` prints what it would
delete:

```bash
uv run ri-sample teardown
uv run ri-sample teardown --yes
```

```text
Teardown plan (nothing is deleted without --yes):
  name                                           id          versions  action
  assistant-sales-region-north                   abcde12345  1         delete
  assistant-sales-region-central                 bcdef23456  1         delete
  assistant-sales-region-south                   cdefg34567  1         delete
  assistant-team-support                         defgh45678  2, 1      delete
  assistant-team-field-sales                     efghi56789  1         delete
  assistant-team-legal-compliance                fghij67890  1         delete
  assistant-structured-json                      ghijk78901  1         delete
  assistant-sales-region-north-team-support      hijkl89012  1         delete
  assistant-sales-region-north-team-field-sales  ijklm90123  1         delete
  assistant-sales-region-south-team-support      jklmn01234  1         delete
  assistant-sales-region-south-team-field-sales  klmno12345  1         delete
Run teardown --yes to delete 11 instructions and their versions.

assistant-sales-region-north deleted (versions 1)
assistant-sales-region-central deleted (versions 1)
assistant-sales-region-south deleted (versions 1)
assistant-team-support deleted (versions 2, 1)
assistant-team-field-sales deleted (versions 1)
assistant-team-legal-compliance deleted (versions 1)
assistant-structured-json deleted (versions 1)
assistant-sales-region-north-team-support deleted (versions 1)
assistant-sales-region-north-team-field-sales deleted (versions 1)
assistant-sales-region-south-team-support deleted (versions 1)
assistant-sales-region-south-team-field-sales deleted (versions 1)
Deleted 11 instructions. Removed sample-state.json.
```

`teardown` deletes each instruction's versions, newest first, then the instruction. It
deletes only instructions with a sample name and the `app=retrieval-instructions-sample`
tag. To delete one instruction by hand instead, run the post's commands:

```bash
aws bedrock-agent list-retrieval-instruction-versions --retrieval-instruction-id <instruction-id>
aws bedrock-agent delete-retrieval-instruction --retrieval-instruction-id <instruction-id> \
  --retrieval-instruction-version <n>   # repeat for each version
aws bedrock-agent delete-retrieval-instruction --retrieval-instruction-id <instruction-id>
```

`teardown` also cleans up after them: an instruction you deleted by hand prints
`already deleted`. Then delete the stack:

```bash
npm run destroy
```

If you already ran `npm run destroy`, `teardown` still works: it doesn't need the stack.

### Removed

- The `RetrievalInstructionsSample` stack: the bucket and its documents, both knowledge
  bases with their data sources and indexed data, the service roles, the Lambda functions
  and their log groups, and the tenant roles if you created them.
- The retrieval instructions and their versions.
- `sample-state.json`.

### Left behind

1. The assets that `cdk deploy` uploaded to the CDK bootstrap bucket. CDK doesn't delete
   them. In an account that only you use, the CDK CLI's `cdk gc` command can remove
   unused assets.
2. The `CDKToolkit` stack, if you bootstrapped only for this sample. Delete it only if no
   other CDK app in the account and Region uses it.

Also left: CloudTrail event history, which expires on its own after 90 days, and the
optional trail and its bucket, if you created them and skipped their clean up steps.

### Still billing

Nothing from the stack. The bootstrap bucket's storage keeps billing at S3 rates, and so
does the optional trail if you left it.

To check that nothing the sample created remains:

```bash
aws cloudformation describe-stacks --stack-name RetrievalInstructionsSample
# An error that the stack does not exist
aws bedrock-agent list-retrieval-instructions \
  --query "retrievalInstructionSummaries[?starts_with(name, 'assistant-')].name"
aws bedrock-agent list-knowledge-bases \
  --query "knowledgeBaseSummaries[?starts_with(name, 'retrieval-instructions-sample')].name"
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=app,Values=retrieval-instructions-sample \
  --query 'ResourceTagMappingList[].ResourceARN'
# Each list is empty. The tag index can lag by a few minutes.
```

## Security

This sample is for demonstration. The corpus is fictitious, and the bucket has no access
logging. Read [SECURITY.md](SECURITY.md) before you change how the filter is built, how
requests are sent, or the tenant roles. It explains the security property the sample
depends on and how to report a vulnerability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). It includes a short list of things this project
will not accept.

## License

MIT-0. See [LICENSE](../LICENSE).
