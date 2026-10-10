# Amazon Quick + Bedrock Managed Knowledge Base

Deploy an [Amazon Bedrock managed knowledge
base](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html), connect
it to **Amazon Quick** as a knowledge source, and surface it through Quick's chat agent,
either in Quick directly or embedded in your own application.

The headline behavior: **two users query the same knowledge base and get different
answers**, with no authentication or authorization code in the application. Quick forwards
each signed-in user's identity to Bedrock, and Bedrock filters retrieval results against
document-level ACLs.

## Who this is for

The ACL passthrough itself is a Quick feature: [ACL support requires no
configuration](https://docs.aws.amazon.com/quick/latest/userguide/byo-bedrock-kb-acl.html).

What this sample adds is:

- **How to tell what's wrong when a user gets no answer.** ACL filtering fails closed, so
  a configuration mistake shows up as an empty answer rather than an error. The sections
  below say what each mistake looks like, where it shows up, and how to tell it apart from
  the others.
- **An embed harness** that shows how to put Quick chat inside your own application, and
  where the identity boundary sits when you do.
- **A CDK stack and a seed corpus** arranged so the ACL behavior is observable in minutes.

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
git sparse-checkout set amazon-quick-acl

cd amazon-quick-acl
```

Commands in this README run from the `amazon-quick-acl` directory unless a step says to
change into `infra/` or `webapp/`. To clone the whole repository instead, omit the
`--sparse` and `--filter` flags and change into this directory afterward.

## Architecture

```
infra/  (CDK)                          Amazon Quick                   webapp/ (optional)
┌────────────────────────────┐        ┌──────────────────┐          ┌──────────────────┐
│ Bedrock managed KB         │◀───────│ Knowledge base   │          │ React shell      │
│   (Bedrock owns the vector │        │ integration      │◀─────────│ embedQuickChat   │
│    store + embeddings)     │        │                  │          │                  │
│                            │        │ Chat agent in a  │          │ harness mints    │
│ └─ S3 data source (ACLs)   │        │ space            │          │ the embed URL    │
└────────────────────────────┘        └──────────────────┘          └──────────────────┘
```

Quick owns retrieval, generation, citations, conversation history and identity. This
sample provisions the knowledge base and, optionally, a thin front end. Read
[SECURITY.md](SECURITY.md) before touching the embed harness in `webapp/server/`.

## Cost

There is no always-on compute in the stack, so the AWS side is usage-based and driven by
the knowledge base: Bedrock ingestion when documents are indexed, storage for as long as
the knowledge base exists, and retrieval per query, all billed to the knowledge base owner. S3 storage for three small documents and
their access logs is negligible. Connecting a managed knowledge base adds no Quick charge
([Quick billing for Bedrock knowledge
bases](https://docs.aws.amazon.com/quick/latest/userguide/byo-bedrock-kb-billing.html)).

The standing cost is Amazon Quick, and it depends on whether your account already uses it.
On an existing Quick account, this sample adds two **Professional** user subscriptions
(`READER_PRO`) for the demo users. If you sign up for Quick to run it, the account also
carries a monthly infrastructure fee and your administrator's Admin Pro seat. New Quick
accounts may be eligible for a free trial. See [Amazon Quick
pricing](https://aws.amazon.com/quicksuite/pricing/) for current rates and trial terms.

Price the usage-based part against your own corpus size and query volume rather than this
sample's three documents, and remember that Quick subscriptions continue after
`cdk destroy`: deleting the demo users, and unsubscribing if you signed up only for this
sample, is how you stop paying for them. See [Cleanup](#cleanup).

## Prerequisites

### Amazon Quick setup

Do these first. None of it is created by the CDK stack.

1. **Create an Amazon Quick instance** in the target account, if you do not already have
   one. This is a separate signup from creating the AWS account itself: the wizard asks for
   an account name, a Region, and an authentication method. See [Signing up for Amazon
   Quick](https://docs.aws.amazon.com/quick/latest/userguide/signing-up.html).

   The instance **must** be in `us-east-1`, `us-west-2`, `eu-west-1`, or `ap-southeast-2`.
   Those are the only Regions where a managed knowledge base can be connected, and the
   knowledge base has to live in the same Region. `cdk synth` fails fast if you point it
   anywhere else.

2. **Confirm you have Quick administrator access.** Phase 3 grants Quick access to the
   knowledge base, either through Admin → Manage Account → AWS Resources or through the
   Bedrock console's **Use with Amazon Quick** hand-off. Both are admin-only. An
   author-level role is not sufficient.

3. **Create two Quick users with the `READER_PRO` role and distinct email addresses.**
   The ACL demo needs two identities, and their emails go into the ACL file in Phase 2, so
   create them before then and note the exact addresses.

   ```bash
   aws quicksight register-user --aws-account-id <account> --namespace default \
     --identity-type QUICKSIGHT --user-role READER_PRO \
     --email martha_rivera@example.com --user-name martha_rivera --region <region>
   ```

   > [!IMPORTANT]
   > Use `READER_PRO` (Quick Professional), not `READER`. `READER` is the BI-only
   > Quick Sight Reader, and chat agents and spaces need Professional; see [Quick user
   > types](https://docs.aws.amazon.com/quick/latest/userguide/user-types.html).
   > `RegisterUser` and `GenerateEmbedUrlForRegisteredUser` both accept a `READER` user,
   > so the problem only appears when the chat loads. To fix an existing user, change the
   > role in Manage users, or by CLI (`update-user` requires the email to be restated):
   >
   > ```bash
   > aws quicksight update-user --aws-account-id <account> --namespace default \
   >   --user-name martha_rivera --email martha_rivera@example.com \
   >   --role READER_PRO --region <region>
   > ```
   >
   > Then allow a few minutes for it to take effect.

   `--identity-type QUICKSIGHT` creates a Quick-local user with no external identity
   provider. You can also do this in the console under Manage Quick → Manage Users →
   Invite users. Distribution lists are rejected as invitations. If you only have one
   mailbox, `+` aliasing (for example `martha_rivera+a@example.com` and
   `martha_rivera+b@example.com`) gives you two users; each `+` address is a separate
   identity to both Quick and Bedrock.

   You do **not** need their passwords or to sign in as them for the main demo. The
   optional web app in Phase 4 switches between their identities server-side. Signing in
   as one of them once is still worth doing; see [Proving it end to
   end](#proving-it-end-to-end).

### Local tooling

- Node.js **20.19+ or 22.12+** (required by Vite 8). CI runs on Node 22.
- The AWS CLI, with credentials for the target account.

**AWS credentials are not configured in this repo.** No credential, key, or token belongs
in either `.env` file. Those hold only non-secret configuration (account ID, Region, ARNs,
email addresses). Both the CDK CLI and the Phase 4 harness resolve credentials through the
standard AWS credential chain, so configure a profile however you normally would and point
your shell at it:

```bash
export AWS_PROFILE=<your-profile>
aws sts get-caller-identity        # confirm you are in the intended account
```

If you would rather export credentials into the environment than point at a profile, for
example when using IAM Identity Center, this produces the same result:

```bash
aws sso login --profile <your-profile>
eval "$(aws configure export-credentials --profile <your-profile> --format env)"
```

Temporary credentials also require `AWS_SESSION_TOKEN`; omitting it produces
`InvalidClientTokenId` on a key and secret that are otherwise valid.

If you leave `KB_TARGET_REGION` blank in `infra/.env`, the Region falls back to the one the
CDK CLI derives from that profile.

### Limits to keep in mind

- A Quick instance can connect **at most 2** managed knowledge bases.
- The knowledge base and the Quick instance must share a Region.

## Phase 1: Deploy the knowledge base

`infra/` and `webapp/` are npm workspaces, so one install at the sample root covers both:

```bash
npm install
cd infra
cp .env.example .env
```

**Now edit `infra/.env` before going further.** Set these four values:

| Variable            | Value                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `KB_TARGET_ACCOUNT` | Your 12-digit AWS account ID                                                               |
| `KB_TARGET_REGION`  | `us-east-1`, `us-west-2`, `eu-west-1`, or `ap-southeast-2`; must match your Quick instance |
| `DEMO_USER_A_EMAIL` | Email of the first Quick user, as registered                                               |
| `DEMO_USER_B_EMAIL` | Email of the second Quick user, as registered                                              |

The two emails are not needed until Phase 2, but setting them now means you only edit this
file once. `KB_NAME` and `KB_S3_ACL_ENABLED` can stay at their defaults.

Then deploy:

```bash
npm run cdk -- bootstrap   # first time in this account/Region only
npm run deploy
```

Note the outputs. `KnowledgeBaseArn` is what Quick needs:

```
ManagedKbStack.KnowledgeBaseArn  = arn:aws:bedrock:us-east-1:111122223333:knowledge-base/ABCD1234
ManagedKbStack.KnowledgeBaseId   = ABCD1234
ManagedKbStack.DataBucketName    = amzn-s3-demo-bucket
ManagedKbStack.GlobalAclS3Uri    = s3://amzn-s3-demo-bucket/acl/global-acl.json
ManagedKbStack.S3DataSourceId    = EFGH5678
```

Your bucket name will be generated by CloudFormation from the stack and construct names.

> [!NOTE]
> Set `KB_TARGET_REGION`, not `CDK_DEFAULT_REGION`. The CDK CLI **overwrites**
> `CDK_DEFAULT_REGION` in the app subprocess with the Region from your AWS configuration,
> so a value for it in `.env` is silently ignored, which would deploy the knowledge base
> to the wrong Region and leave Quick unable to see it.

## Phase 2: Load the corpus and sync

The seed corpus is arranged to make ACL filtering observable:

| Prefix         | Document           | Visible to   |
| -------------- | ------------------ | ------------ |
| `shared/`      | Travel policy      | User A and B |
| `finance/`     | Q3 margin review   | User A only  |
| `engineering/` | Deployment runbook | User B only  |

`npm run seed:render` reads `DEMO_USER_A_EMAIL` and `DEMO_USER_B_EMAIL` from `infra/.env`
and writes `seed-data/acl/global-acl.json`. It fails if either is missing, malformed, or
the two name the same identity. It cannot tell whether an address belongs to a real Quick
user: a placeholder that merely _looks_ like an email passes and produces an ACL file
matching nobody.

Render the ACL file, read it back, then upload:

```bash
npm run seed:render
cat seed-data/acl/global-acl.json

aws s3 sync ./seed-data s3://<DataBucketName>/ \
  --exclude "acl/global-acl.template.json" --exclude "*.DS_Store"
```

Reading the rendered file takes a second and is worth it, because a wrong email here
produces no error at any later step. See [When a user gets nothing](#when-a-user-gets-nothing).

> [!WARNING]
> **How Bedrock matches the ACL emails.** Bedrock compares the user identity to ACL
> entries case-insensitively and ignores surrounding whitespace, so `Martha_Rivera@...`
> matches `martha_rivera@...`. It does **no alias resolution**:
> `martha_rivera@example.com` does not match `martha_rivera+a@example.com`, because a `+`
> address is a distinct identity.
>
> With `aclEnabled: true`, a document with **no ACL entry is not ingested at all**.
> Missing permissions are treated as restricted, not public. Every prefix holding content
> must appear in the global ACL file or carry a per-document `<filename>.metadata.json`.

Now start the first sync. CloudFormation has no `SyncSchedule` property for managed
connectors, so the initial ingestion is triggered out of band:

```bash
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id <KnowledgeBaseId> \
  --data-source-id <S3DataSourceId> \
  --region <region>

# then poll:
aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id <KnowledgeBaseId> \
  --data-source-id <S3DataSourceId> \
  --region <region>
```

Ingestion is complete when `status` is `COMPLETE`. For the seed corpus the statistics
should read:

```json
{
  "status": "COMPLETE",
  "stats": {
    "numberOfDocumentsScanned": 3,
    "numberOfNewDocumentsIndexed": 3,
    "numberOfDocumentsFailed": 0
  }
}
```

Three documents, not four: the ACL file is configuration, not content. Bedrock requires it
to live in the **same bucket** as the content it describes, so `acl/global-acl.json` sits
inside the data source, but it is not ingested and does not appear in the statistics as
indexed or as failed.

### Reading the ingestion result

ACL problems split into ones ingestion reports and ones it cannot see.

| What you see                                                             | What it means                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `COMPLETE`, 3 scanned, 3 indexed, 0 failed                               | Healthy. Every document had ACL coverage.                                                                                                                                |
| `numberOfDocumentsFailed` above 0, with a message about partial failures | A document had no ACL coverage: its prefix is missing from `global-acl.json` and it has no `.metadata.json`. That document was not ingested, and nobody can retrieve it. |
| The job fails outright, with an error naming the ACL file's S3 path      | `global-acl.json` is missing from the bucket, or at a different key. Nothing was ingested. Upload it and sync again.                                                     |
| `COMPLETE`, all indexed, but one user gets nothing in chat               | Usually a wrong email. Ingestion cannot catch this; see below.                                                                                                           |

### When a user gets nothing

A wrong email in the ACL file does **not** show up in ingestion. Bedrock has no user
directory at ingest time, so an ACL entry naming an address that exists nowhere indexes
normally. The mistake appears only as empty answers for the user you meant to name.

To check which identities a document is actually readable by, use the Bedrock
`GetIngestedDocumentAcl` and `CheckIngestedDocumentAcl` operations, both of which have
console support. They are on the `bedrock-agent-runtime` API and need the data source ID
(`S3DataSourceId`) as well as the knowledge base ID. They need a current AWS CLI or SDK;
if yours doesn't include them, upgrade it or use the Bedrock console.

To put syncs on a recurring schedule afterward, set a sync schedule on the data source
through the console or `UpdateDataSource`.

## Phase 3: Connect it to Amazon Quick

This part is Quick-side configuration and cannot be expressed in CDK. Steps 1 and 2 are
done in the console; see [Scripting part of this phase](#scripting-part-of-this-phase) for
the steps that can be scripted.

There are two ways to do steps 1 and 2. Both end in the same place, a Quick knowledge base
backed by your managed knowledge base, so pick one. Steps 3 and 4 are needed either way.

- **Option A: from the Bedrock console.** One click hands the knowledge base to Quick and
  does steps 1 and 2 for you.
- **Option B: from the Quick console.** You enter the ARN and create the Quick knowledge
  base yourself.

### Option A: Use with Amazon Quick (from the Bedrock console)

1. **Sign in to Quick as your administrator account first**, in the same browser.
   Granting Quick access to a knowledge base is an admin action, and this sample's Quick
   instance, with its two demo users, already exists from the
   [prerequisites](#amazon-quick-setup). The hand-off can also carry a brand-new customer
   through Quick signup, but that would create a separate instance without your demo users.

2. **Start the hand-off.** In the Amazon Bedrock console, switch to the Region you deployed
   to, open **Knowledge Bases**, select the knowledge base from Phase 1 (`KnowledgeBaseId`
   from the stack outputs), and choose **Use with Amazon Quick**. The console opens Quick
   in the same Region, with the knowledge base carried across.

3. **Choose Enable and create.** This single step grants Quick access to the knowledge
   base, creates the Quick knowledge base, scopes a chat to it, and opens the chat panel
   with a first answer already generated.

   > [!NOTE]
   > That first answer runs as **your administrator identity**, which does not appear in
   > `global-acl.json`. Expect it to say it could not find relevant information. That is
   > ACL filtering working, not a failed connection. The two demo users are who the ACLs
   > were written for, and they do not have access yet.

Continue with step 3 below. The hand-off scopes your own chat to the knowledge base, but
the demo needs a space shared with both demo users, which it does not set up.

### Option B: Connect it from the Quick console

1. **Allow Quick to use the knowledge base.** In Quick, go to **Admin → Manage Account →
   AWS Resources**, select **Amazon Bedrock**, and add the `KnowledgeBaseArn` from Phase 1.
   Quick creates a customer managed policy, `AWSQuickSightBedrockAccess`, scoped to that
   ARN, and attaches it to the Quick service role. It is not an AWS managed policy. Choose
   **Save**.

2. **Create the Quick knowledge base.** In the left navigation, choose **More →
   Knowledge**, create a knowledge base, and choose **Amazon Bedrock Managed Knowledge
   Base** as the type. Edit the name, add the ARN you added in step 1, then choose
   **Next**.

### Then, for either option

3. **Attach it to a space.** Create a space, open it, then choose **Add → Add knowledge**
   and select the knowledge base. Quick queries it automatically during chat.

   Allow a few minutes between creating the knowledge base and attaching it.

4. **Share the space and the knowledge base with both demo users.** Quick does not do this
   for you: after steps 1 to 3, only your administrator account has access, and a demo
   user with no access to the space or the knowledge base has no path to your documents
   at all. Share both:

   - the **space**, with both demo users, and
   - the **knowledge base**, with both demo users as **Viewer**, which is the role that
     permits querying.

   Grant both users _identical_ Quick permissions. The demo is only meaningful if the one
   difference between them is in `global-acl.json`. Restricting content through Quick
   sharing instead would produce a convincing-looking result that does not demonstrate ACL
   filtering.

   **Check that the sharing took.** This read-only check lists every space and every
   managed knowledge base in the account, which knowledge bases each space contains, and
   the actions each demo user holds on each one. It reads the account, Region and the two
   user ARNs from `webapp/.env`, so fill in that file first as described in
   [Phase 4](#phase-4-embed-it-in-your-own-app-optional), even if you do not plan to run
   the web app:

   ```bash
   npm run check:sharing --workspace webapp
   ```

   It exits non-zero unless some space contains a managed knowledge base, and both the
   space and that knowledge base are shared with both users with identical actions. Two
   things it does not check:

   - **Group grants.** It detects direct user grants only; a grant made to a Quick group
     shows as missing.
   - **Whether the actions permit querying.** It confirms the two users match, not that
     they hold the right role. Share the knowledge base as **Viewer**.

Allow a few minutes after any role or sharing change before testing. If a correctly configured user fails and the
other works, wait and retry before changing anything.

Cross-account knowledge bases additionally need a resource policy granting the Quick
service role `bedrock:Retrieve` and `bedrock:GetDocumentContent`. Same-account setups do
not. See [Bring your own Bedrock managed knowledge
base](https://docs.aws.amazon.com/quick/latest/userguide/quick-byo-bedrock-kb.html).

### Scripting part of this phase

Steps 1 and 2 are done in the console, using either option above.

Steps 3 and 4 can be scripted with the Quick API: `CreateSpace`, `UpdateSpaceResources`
(resource type `KNOWLEDGE_BASE`), `UpdateSpacePermissions`, and
`UpdateKnowledgeBasePermissions`. Two things to know before you try:

- **Use a current AWS CLI or SDK.** The AWS SDK for JavaScript v3
  (`@aws-sdk/client-quicksight`) includes these operations; `check:sharing` uses their
  read-only counterparts.
- **If `UpdateSpacePermissions` fails,** check the user's role first, then vary one action
  at a time.

### Verify the ACL behavior

Sign in as each demo user in turn, using separate browser profiles so the two sessions do
not collide, and ask all three questions in each session. This requires each user to have
accepted their email invitation and set a password. Or use the Phase 4 web app, which
switches between them (this does not require signing in as each user).

To point chat at the knowledge base: choose **New chat** in the left navigation, then at the
bottom left of the chat widget switch the scope from **All data** to **Specific data** and
select the space the knowledge base is attached to. Without that switch, chat is not
querying your knowledge base and the answers will not reflect the ACLs.

| Question                                               | User A      | User B      |
| ------------------------------------------------------ | ----------- | ----------- |
| What is the travel meal allowance?                     | answers     | answers     |
| Why did Q3 gross margin miss plan?                     | **answers** | nothing     |
| What is the rollback trigger for the payments service? | nothing     | **answers** |

Read the **citations** rather than just the prose. A correct result cites
`travel-policy.md` for both users, `q3-margin-review.md` for user A only, and the
deployment runbook for user B only. An answer that hedges in prose while citing a
restricted document is still a leak.

Two failure shapes mean opposite things:

- **No error, no relevant content** ("I wasn't able to find information about..."). This
  is ACL filtering working. It is the expected result for the two restricted documents. It
  is also what every ACL mistake looks like: a wrong email, a missing ACL entry, or a
  document that failed ingestion. Use [Reading the ingestion
  result](#reading-the-ingestion-result) and [When a user gets
  nothing](#when-a-user-gets-nothing) to tell them apart.
- **An explicit "Insufficient permissions to access this knowledge base".** This is a Quick
  or IAM problem, unrelated to `global-acl.json`. Check step 4 sharing first. If the
  knowledge base works for an administrator but fails for a specific user, check **IAM
  policy assignments**: when they are enabled, Quick applies a per-user session policy at
  retrieval time and intersects it with the service role's permissions, so the user's
  assigned policy must also allow `bedrock:Retrieve` and `bedrock:GetDocumentContent`. See
  [Troubleshooting](https://docs.aws.amazon.com/quick/latest/userguide/byo-bedrock-kb-troubleshooting.html)
  for the full ordered list of permission layers.

### Proving it end to end

The Phase 4 web app switches identities _server-side_: it mints an embed URL for a
configured `UserArn` using your credentials. That demonstrates Bedrock filtering correctly
for whichever identity it is handed, but it does not by itself prove Quick propagates the
**authenticated** user, because the harness is choosing who to be.

To close that loop, sign in to Quick directly as one of the two demo users once (use a
second browser profile or a private window) and ask the question they should _not_ be able
to answer. An empty response there is the real proof. The user has to accept the Quick
invitation and set a password first, which the embedded path does not require. After that,
use the switcher for speed.

## Phase 4: Embed it in your own app (optional)

Skip this if using Quick directly is enough. Quick chat can also be embedded with
`embedQuickChat`. Dependencies were installed at the sample root in Phase 1.

```bash
cd webapp
cp .env.example .env
```

First collect the two Quick user ARNs:

```bash
aws quicksight list-users --aws-account-id <account> --namespace default \
  --region <region> --query "UserList[].{Name:UserName,Email:Email,Role:Role,Arn:Arn}" \
  --output table
```

Check the `Role` column while you are here. Both demo users should show `READER_PRO`.

**Now edit `webapp/.env`** and set these four values:

| Variable               | Value                                                  |
| ---------------------- | ------------------------------------------------------ |
| `QUICK_AWS_ACCOUNT_ID` | Your 12-digit AWS account ID                           |
| `QUICK_REGION`         | Same Region as the knowledge base                      |
| `QUICK_USER_A_ARN`     | ARN of the user with `shared/` + `finance/` access     |
| `QUICK_USER_B_ARN`     | ARN of the user with `shared/` + `engineering/` access |

Match the ARNs to the right users by their email addresses. Swapping A and B makes the demo
look broken in a way that resembles an ACL fault. The remaining variables have working
defaults; leave `QUICK_FIXED_AGENT_ID` blank so you can select the agent in the embedded UI.

Then start it. The harness and Vite run in two terminals, both from `webapp/`:

```bash
npm run dev:api           # terminal 1: embed-URL harness on 127.0.0.1:3001
```

```bash
npm run dev:web           # terminal 2: Vite on localhost:5173
```

Stop each with Ctrl-C.

Open `http://localhost:5173`. The page renders a branded shell with an identity switcher,
so you can watch the same question return different answers as you toggle between the two
users.

Select **User A (shared + finance)**, ask the three test questions, then switch to **User B
(shared + engineering)** and ask them again. These are the same questions as in [Verify
the ACL behavior](#verify-the-acl-behavior), where the guidance on reading citations and
telling the two failure shapes apart also applies here:

| Question                                               | User A      | User B      |
| ------------------------------------------------------ | ----------- | ----------- |
| What is the travel meal allowance?                     | answers     | answers     |
| Why did Q3 gross margin miss plan?                     | **answers** | nothing     |
| What is the rollback trigger for the payments service? | nothing     | **answers** |

Switching identity starts a fresh chat session, so ask each question again after every
switch rather than relying on the earlier conversation.

> [!WARNING]
> `QUICK_ALLOWED_DOMAIN` must match the browser origin **exactly**, and `localhost` and
> `127.0.0.1` are different origins to Quick. The default is `http://localhost:5173`, so
> open the app there. Visiting `http://127.0.0.1:5173` instead makes the embed fail even
> though the harness itself is reachable.
>
> Vite is pinned to port 5173 and **exits** if the port is taken, rather than quietly
> moving to 5174 and breaking the embed the same way. Stop whatever holds the port, or
> change the port in `vite.config.ts` and `QUICK_ALLOWED_DOMAIN` together.

**If the embedded chat refuses to load**, typically a browser page saying the frame was
refused, check in this order:

1. **The users' role.** A `READER` user gets an embed URL that refuses to load. Upgrade to
   `READER_PRO`, then allow a few minutes.
2. **The origin.** The address bar must match `QUICK_ALLOWED_DOMAIN` exactly.
3. **Propagation.** After a role or sharing change, wait a few minutes and retry before
   changing anything else.

The harness terminal prints the full AWS error for any failed embed request. The browser
only gets a generic message, by design.

If you open DevTools, expect many Content Security Policy errors from inside the embedded
Quick frame. They come from Quick itself, not from this app, and do not affect chat.

### Productionizing the embed endpoint

`webapp/server/` is a **local development harness, not a deployable backend.** Read this
before adapting it.

Generating an embed URL requires AWS credentials, and the caller chooses which Quick user
the URL is minted for (`UserArn`). An endpoint that accepts a user identity from its caller
and is not itself authenticated would let anyone open a session as any Quick user. Because
Quick forwards that identity to Bedrock for ACL filtering, that is also a document-level
access control bypass.

The harness limits the damage locally:

- It binds to `127.0.0.1` and accepts only an opaque selector (`"a"` or `"b"`), looked up
  in a `Map` so that keys such as `__proto__` resolve to nothing. The client cannot name
  an arbitrary identity.
- It rejects any request whose `Host` header is not its own loopback address. The embed URL
  it returns is a bearer credential, and a DNS-rebinding page aimed straight at port 3001
  would otherwise be able to read one. The Vite proxy rewrites `Host` for legitimate
  requests.
- It rejects requests carrying a foreign `Origin`, and POST bodies that are not
  `application/json`, the content type a cross-origin page cannot send without a CORS
  preflight the harness never answers.
- It returns generic errors to the browser and logs AWS error detail to the terminal only.

To productionize: authenticate the end user through your identity provider and derive
`UserArn` from the **verified session**, never from request input. The Quick API call
itself is unchanged:

```ts
new GenerateEmbedUrlForRegisteredUserCommand({
  AwsAccountId,
  UserArn, // from your verified session
  ExperienceConfiguration: { QuickChat: {} },
  AllowedDomains: [yourOrigin],
});
```

#### Credentials and least privilege

The _shape_ of this integration is the production one: a backend service holds the embedding
permission and mints a URL per end user. Three specifics of the harness are not, and none of
them is the API pattern itself.

1. **Where the credentials come from.** The harness takes whatever the AWS SDK credential
   chain finds. During development, that is your own credentials from the shell you started
   it in. A deployed service should use its execution role instead (an ECS task role, a
   Lambda execution role). The same credential chain resolves that with no code change,
   which is why `server/index.ts` constructs the client with only a Region.

2. **How broad those credentials are.** Running as an administrator means the endpoint can
   mint a working session for _any_ registered user in the account, including an
   administrator. Grant only `quicksight:GenerateEmbedUrlForRegisteredUser`, and scope
   `Resource` to the specific user ARNs the endpoint may impersonate rather than
   `user/default/*`. You can also constrain origins in IAM with the
   `quicksight:AllowedEmbeddingDomains` condition key, so the allowlist is enforced by IAM
   rather than by application code being correct.

3. **Who chooses the identity.** As above: derive `UserArn` from the verified session.

Two things that are easy to miss:

- **The calling identity is not a Quick user.** IAM decides who may _mint_ an embed URL; the
  Quick user named in `UserArn` is who the session is _for_. The service principal never
  appears in `list-users` and consumes no Quick license. Conversely, IAM has no say in what
  the embedded user can then see. That comes from Quick space and knowledge base sharing,
  and from the Bedrock ACLs.
- **The embed URL is a bearer credential.** Anyone holding it has that user's session until
  it expires (`QUICK_SESSION_LIFETIME_MINUTES`, 60 by default). Do not log it, and keep it
  out of query strings that reach analytics or access logs.

This is a sample, and a production deployment needs work it deliberately leaves out, most
obviously identity provider integration, and provisioning Quick users for your real users
instead of the two created by hand here. One detail worth carrying across: whichever claim
you map to a Quick user, map on the **email address**, and keep it the same address that
appears in your ACLs. Bedrock ignores case but does no alias resolution, so a correctly
authenticated user whose address differs from the ACL entry (a `+` alias, a secondary
domain) gets a working session that retrieves nothing.

## Known limits

- **Adding a source without a permission model removes filtering for its content.** A
  knowledge base can mix ACL-enabled and non-ACL data sources, and that is supported. But
  documents from a non-ACL source are returned to every user regardless of who is asking,
  and they are returned even when no user identity is supplied at all. A web crawler is the
  obvious example: web pages carry no permissions, so ACL awareness cannot be enabled for
  them. If you extend this sample with such a source, be deliberate about it: a single
  answer can then blend filtered and unfiltered content with nothing in the response
  marking which is which.
- **S3 ACLs have no real-time verification.** Your ACL file is the source of truth, so
  permission changes take effect at the next sync. Connectors with a live permission
  system (SharePoint, OneDrive, Google Drive, Confluence) do verify per query.
- **Bedrock filters on the identity it is given.** Bedrock applies ACL-aware filtering for
  the identity the application supplies; authenticating the end user is the
  application's responsibility. Here, Quick authenticates the user before forwarding the
  identity.
- **Testing retrieval directly against Bedrock.** If you call `Retrieve` yourself to check
  ACLs without Quick, a managed knowledge base rejects `vectorSearchConfiguration`; use
  `managedSearchConfiguration` instead. Retrieval with no user identity returns nothing
  from an ACL-enabled source.
- **`cdk-nag` reports two acknowledged findings**, each recorded with a reason: an `IAM5`
  wildcard on `s3:GetObject` in `infra/bin/app.ts` (the knowledge base must be able to
  read any uploaded document; narrowed with an `aws:ResourceAccount` condition), and `S1`
  on the access-logs bucket in `infra/lib/managed-kb-stack.ts` (self-logging would
  recurse). The `S1` acknowledgment is made on that bucket only, so removing access
  logging from the data bucket still fails `cdk synth`.

## Checks

The same checks CI runs, from the sample root:

```bash
npm run verify    # format check, lint, type-check and build, tests, cdk synth with cdk-nag
```

`npm run synth` needs an account and a supported Region. With no `infra/.env`, pass them
inline, as CI does: `KB_TARGET_ACCOUNT=123456789012 KB_TARGET_REGION=us-east-1 npm run synth`.
Nothing is deployed.

## Cleanup

```bash
cd infra
npm run destroy
```

This completes in a single pass and removes the knowledge base, its Bedrock-owned index, the
S3 data source, and the knowledge base service role. It does **not** remove everything, and
some of what it leaves behind costs money.

### Removed automatically

The `ManagedKbStack` CloudFormation stack and the resources above. The knowledge base ID
stops resolving immediately.

### Left behind: delete these yourself

**Both S3 buckets**, because they use `RemovalPolicy.RETAIN` so `cdk destroy` can never
silently delete your source documents. Your uploaded corpus and the ACL file survive intact.

They are **versioned**, which makes them harder to delete than they look: `aws s3 rm
--recursive` removes current objects but leaves every previous version and delete marker, so
`delete-bucket` then fails with `BucketNotEmpty`. One reliable route is the S3 console's **Empty** action, which handles versions, followed by
**Delete**. By CLI:

```bash
BUCKET=amzn-s3-demo-bucket   # replace with your bucket name

aws s3api delete-objects --bucket "$BUCKET" --delete "$(aws s3api list-object-versions \
  --bucket "$BUCKET" --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}')"

aws s3api delete-objects --bucket "$BUCKET" --delete "$(aws s3api list-object-versions \
  --bucket "$BUCKET" --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}')"

aws s3api delete-bucket --bucket "$BUCKET"
```

Each `delete-objects` call handles up to 1000 entries, so repeat them for a large bucket. If
a bucket has no versions or no delete markers, the corresponding query returns null and that
call errors harmlessly; skip it.

The access logs bucket is not in the stack outputs. Find both with:

```bash
aws cloudformation describe-stack-resources --stack-name ManagedKbStack --region <region> \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text
```

Run that _before_ destroying, since the stack is gone afterward.

**The Quick-side objects**, which CloudFormation knows nothing about: delete the space and
the knowledge base under **More → Knowledge**, and remove the ARN from **Admin → Manage
Account → AWS Resources**. Either order relative to `cdk destroy` works; CloudFormation
does not check whether Quick still references the knowledge base.

**The `CDKToolkit` stack** from `cdk bootstrap`, if you bootstrapped solely for this sample.
It holds a staging bucket and an ECR repository. Leave it if other CDK projects in the
account use it.

### Still billing after cleanup

**The Amazon Quick subscription and the two demo users.** Nothing in this sample creates or
removes the subscription, and each Professional user bills monthly until deleted. Delete the
two demo users in Manage users. If you signed up for Quick only to run this sample,
unsubscribe in the Quick console as well. This is the largest recurring cost the sample
leaves behind.

## Repository layout

```
package.json                  npm workspaces root; format, lint, build, test, synth, verify
infra/                        CDK app: managed knowledge base + S3 data source
  bin/app.ts                  Environment resolution and cdk-nag wiring
  lib/managed-kb-stack.ts     The stack
  lib/target-environment.ts   Account and Region resolution, Quick Region check
  lib/acl-render.ts           ACL template rendering and validation
  scripts/render-seed.ts      Renders global-acl.json from your two demo emails
  seed-data/                  Demo corpus arranged by ACL visibility
  test/                       Stack and rendering tests
webapp/                       Optional embedded-chat front end
  server/                     Local embed-URL harness (not for deployment)
  scripts/check-sharing.ts    Read-only check that Phase 3 sharing is in place
  src/App.tsx                 Shell with identity switcher
  src/embedding.ts            Single shared embedding context
  test/                       Harness and sharing-check tests
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). It includes a short list of things this
project will not accept.

## License

MIT-0. See [LICENSE](../LICENSE).
