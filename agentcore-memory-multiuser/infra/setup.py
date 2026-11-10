#!/usr/bin/env python3
"""Provision everything the AnyCompany internal assistant needs, idempotently.

Creates (or reuses, by name):
  * one Amazon S3 bucket holding the synthetic corpus in data/ and a global ACL file that
    says which employees (by email) may read which folder
  * one Amazon Bedrock Managed Knowledge Base with an ACL-enabled Amazon S3 data source,
    and runs a sync (ingestion job) so the documents and their ACLs are indexed
  * one Amazon Bedrock AgentCore Memory resource with per-actor namespaces
  * one Amazon Cognito user pool with an immutable, verified email attribute, an app
    client, and three test users
  * one IAM application role whose memory permissions are scoped to the calling user
    with session tags (the policy in infra/app-role-policy.json), and whose trust policy
    accepts only the backend's principal (infra/app-role-trust-policy.json)

Writes the resulting identifiers to config.json at the project root.

Usage:
    python infra/setup.py            # create or reuse everything, upload docs, sync
    python infra/setup.py --status   # print the latest sync job and its statistics
    python infra/setup.py --resync   # upload docs + ACL file again and run a new sync
    python infra/setup.py --backend-principal-arn arn:aws:iam::<account>:role/<name>
                                     # the backend runs as another role (default: the
                                     # identity running this script)
"""

import argparse
import json
import pathlib
import re
import secrets
import string
import sys
import time

import boto3
from botocore.exceptions import ClientError

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
DATA_DIR = ROOT / "data"
RUNS_DIR = ROOT / "runs"
RUNS_DIR.mkdir(exist_ok=True)

REGION = "us-west-2"
PREFIX = "anycompany-assistant"

KNOWLEDGE_BASE = {
    "name": f"{PREFIX}-docs",
    "description": "AnyCompany internal documents: HR policies, IT guides, engineering runbooks, sales plans.",
}

TEST_USERS = [
    {"username": "maya", "email": "maya@example.com"},   # engineer, Frankfurt
    {"username": "liam", "email": "liam@example.com"},   # engineer
    {"username": "sofia", "email": "sofia@example.com"},  # account executive
]
EVERYONE = [u["email"] for u in TEST_USERS]

# Who may read each folder of data/. This becomes the data source's global ACL file.
# The knowledge base enforces it at retrieval time against userContext.userId (an email).
# In a real deployment the permissions come from the source system itself (SharePoint,
# Google Drive, Confluence, ...); an S3 data source has no permission system of its own,
# so you write the ACL file.
FOLDER_ACCESS = {
    "hr": EVERYONE,
    "it": EVERYONE,
    "engineering": ["maya@example.com", "liam@example.com"],
    "sales": ["sofia@example.com"],
}

DOCS_PREFIX = "docs/"
ACL_KEY = "acl/global-acl.json"

# Matches a Cognito sub (a UUID). The trust policy requires the userId session tag and the
# SourceIdentity to have this shape, so an empty or malformed value is refused by STS.
SUB_PATTERN = "????????-????-????-????-????????????"


def test_password(cfg: dict) -> str:
    """One random password for the three demo users, generated on first run and kept in
    config.json so later runs and the scripts can sign in. Demo only: a real application
    never provisions users with a shared password."""
    existing = (cfg.get("cognito") or {}).get("testPassword")
    if existing:
        return existing
    alphabet = string.ascii_letters + string.digits
    body = "".join(secrets.choice(alphabet) for _ in range(16))
    return f"Demo-{body}!1aA"  # satisfies the pool policy: upper, lower, digit, symbol, >= 12 chars


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text())
    return {"region": REGION}


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2) + "\n")


# ----------------------------------------------------------------------- S3

def ensure_bucket(s3, account_id: str) -> str:
    bucket = f"{PREFIX}-docs-{account_id}-{REGION}"
    try:
        s3.head_bucket(Bucket=bucket, ExpectedBucketOwner=account_id)
        print(f"[s3] reuse bucket {bucket}")
    except ClientError as e:
        if e.response["Error"]["Code"] not in ("404", "NoSuchBucket", "NotFound"):
            raise
        s3.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": REGION})
        print(f"[s3] created bucket {bucket}")
    s3.put_public_access_block(Bucket=bucket, PublicAccessBlockConfiguration={
        "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True})
    s3.put_bucket_policy(Bucket=bucket, ExpectedBucketOwner=account_id, Policy=json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "DenyInsecureTransport",
            "Effect": "Deny",
            "Principal": "*",
            "Action": "s3:*",
            "Resource": [f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"],
            "Condition": {"Bool": {"aws:SecureTransport": "false"}},
        }],
    }))
    return bucket


def upload_corpus(s3, bucket: str) -> None:
    """data/<folder>/<doc>.md -> s3://bucket/docs/<folder>/<doc>.md, plus the global ACL file."""
    count = 0
    for folder in sorted(p for p in DATA_DIR.iterdir() if p.is_dir()):
        if folder.name not in FOLDER_ACCESS:
            sys.exit(f"data/{folder.name}/ has no entry in FOLDER_ACCESS; every document needs an ACL")
        for path in sorted(folder.glob("*.md")):
            s3.put_object(Bucket=bucket, Key=f"{DOCS_PREFIX}{folder.name}/{path.name}",
                          Body=path.read_bytes(), ContentType="text/markdown")
            count += 1
    acl = [
        {"keyPrefix": f"s3://{bucket}/{DOCS_PREFIX}{folder}/",
         "aclEntries": [{"Name": email, "Type": "USER", "Access": "ALLOW"} for email in emails]}
        for folder, emails in FOLDER_ACCESS.items()
    ]
    s3.put_object(Bucket=bucket, Key=ACL_KEY, Body=json.dumps(acl, indent=2).encode(), ContentType="application/json")
    (RUNS_DIR / "global-acl.json").write_text(json.dumps(acl, indent=2) + "\n")
    print(f"[s3] uploaded {count} documents and s3://{bucket}/{ACL_KEY}")


# --------------------------------------------------------------------- IAM

def ensure_kb_service_role(iam, account_id: str, bucket: str) -> str:
    """Service role the knowledge base assumes to read the bucket during a sync. A managed
    knowledge base needs no vector store permissions."""
    name = f"{PREFIX}-kb-service-role"
    trust = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "bedrock.amazonaws.com"},
            "Action": "sts:AssumeRole",
            "Condition": {
                "StringEquals": {"aws:SourceAccount": account_id},
                "ArnLike": {"aws:SourceArn": f"arn:aws:bedrock:{REGION}:{account_id}:knowledge-base/*"},
            },
        }],
    }
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {"Sid": "ListBucket", "Effect": "Allow", "Action": "s3:ListBucket",
             "Resource": f"arn:aws:s3:::{bucket}",
             "Condition": {"StringEquals": {"aws:ResourceAccount": account_id}}},
            {"Sid": "ReadDocumentsAndAcl", "Effect": "Allow", "Action": "s3:GetObject",
             "Resource": f"arn:aws:s3:::{bucket}/*",
             "Condition": {"StringEquals": {"aws:ResourceAccount": account_id}}},
        ],
    }
    created = False
    try:
        role = iam.get_role(RoleName=name)["Role"]
        print(f"[iam] reuse KB service role {role['Arn']}")
    except ClientError as e:
        if e.response["Error"]["Code"] != "NoSuchEntity":
            raise
        role = iam.create_role(
            RoleName=name,
            AssumeRolePolicyDocument=json.dumps(trust),
            Description="Service role for the AnyCompany assistant managed knowledge base",
        )["Role"]
        created = True
        print(f"[iam] created KB service role {role['Arn']}")
    iam.put_role_policy(RoleName=name, PolicyName=f"{PREFIX}-read-docs", PolicyDocument=json.dumps(policy))
    if created:
        time.sleep(10)  # IAM propagation before Bedrock tries to assume it
    return role["Arn"]


def app_role_policy(kb_arn: str, memory_arn: str) -> dict:
    """The application's permissions. Every memory statement is conditioned on the session
    tag userId, which the backend sets to the caller's Cognito sub when it assumes this role
    for that user. A request whose actorId or namespace names somebody else is refused by
    IAM even if the application code is wrong."""
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AgenticRetrieve",
                "Effect": "Allow",
                "Action": "bedrock:AgenticRetrieveStream",
                "Resource": "*",
            },
            {
                "Sid": "KnowledgeBaseRetrieval",
                "Effect": "Allow",
                "Action": ["bedrock:Retrieve", "bedrock:GetDocumentContent"],
                "Resource": kb_arn,
            },
            # CUSTOM foundation models also need bedrock:InvokeModelWithResponseStream;
            # MANAGED (what this sample uses) does not.
            {
                "Sid": "MemoryDescribe",
                "Effect": "Allow",
                "Action": "bedrock-agentcore:GetMemory",
                "Resource": memory_arn,
            },
            {
                # ListEvents: sessionBinding restore and the UI's history view.
                # CreateEvent: persistenceMode DEFAULT. ListSessions: the UI's conversation list.
                "Sid": "MemorySessionsScopedToCaller",
                "Effect": "Allow",
                "Action": [
                    "bedrock-agentcore:ListEvents",
                    "bedrock-agentcore:CreateEvent",
                    "bedrock-agentcore:ListSessions",
                ],
                "Resource": memory_arn,
                "Condition": {"StringEquals": {"bedrock-agentcore:actorId": "${aws:PrincipalTag/userId}"}},
            },
            {
                # RetrieveMemoryRecords: retrievalConfigs. ListMemoryRecords: the UI's
                # "what memory knows about you" view.
                "Sid": "MemoryRecordsScopedToCaller",
                "Effect": "Allow",
                "Action": [
                    "bedrock-agentcore:RetrieveMemoryRecords",
                    "bedrock-agentcore:ListMemoryRecords",
                ],
                "Resource": memory_arn,
                # The "/" after the tag keeps one user's prefix from matching another's.
                "Condition": {"StringLike": {"bedrock-agentcore:namespacePath": "/anycompany/${aws:PrincipalTag/userId}/*"}},
            },
        ],
    }


def app_role_trust_policy(account_id: str, backend_principal_arn: str) -> dict:
    """Only the backend's own principal may assume the app role, and only with a userId
    session tag and a SourceIdentity that look like a Cognito sub. The backend chooses
    these values, so this guards against application bugs, not against the backend
    principal itself (see README, Security).

    One statement per action: STS authorizes each action with its own condition keys.
    sts:TagSession has no sts:SourceIdentity and sts:SetSourceIdentity has no
    aws:RequestTag, so a single statement conditioned on both denies every request."""
    # Locally the developer's credentials assume it; in production this is the backend's
    # compute role (Lambda execution role, ECS task role).
    principal = {"AWS": f"arn:aws:iam::{account_id}:root"}
    backend = {"ArnEquals": {"aws:PrincipalArn": backend_principal_arn}}
    only_user_id = {"ForAllValues:StringEquals": {"aws:TagKeys": ["userId"]}}
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                # AssumeRole sees both keys, so it fails when either marker is missing.
                "Sid": "BackendAssumesRolePerUser",
                "Effect": "Allow",
                "Principal": principal,
                "Action": "sts:AssumeRole",
                "Condition": {
                    **backend,
                    "StringLike": {"aws:RequestTag/userId": SUB_PATTERN, "sts:SourceIdentity": SUB_PATTERN},
                    **only_user_id,
                },
            },
            {
                "Sid": "BackendTagsSessionWithUserId",
                "Effect": "Allow",
                "Principal": principal,
                "Action": "sts:TagSession",
                "Condition": {**backend, "StringLike": {"aws:RequestTag/userId": SUB_PATTERN}, **only_user_id},
            },
            {
                "Sid": "BackendSetsSourceIdentity",
                "Effect": "Allow",
                "Principal": principal,
                "Action": "sts:SetSourceIdentity",
                "Condition": {**backend, "StringLike": {"sts:SourceIdentity": SUB_PATTERN}},
            },
        ],
    }


def resolve_backend_principal_arn(iam, account_id: str, arn: str) -> str:
    """aws:PrincipalArn of a role session is the role ARN, path included. GetCallerIdentity
    returns the assumed-role ARN without the path, so look the role up."""
    m = re.fullmatch(r"arn:aws[a-z-]*:sts::(\d{12}):assumed-role/([^/]+)/.+", arn)
    if m:
        if m.group(1) != account_id:
            sys.exit(f"backend principal {arn} is in another account; it must be in {account_id}")
        return iam.get_role(RoleName=m.group(2))["Role"]["Arn"]
    m = re.fullmatch(r"arn:aws[a-z-]*:iam::(\d{12}):(role|user)/.+", arn)
    if m:
        if m.group(1) != account_id:
            sys.exit(f"backend principal {arn} is in another account; it must be in {account_id}")
        return arn
    sys.exit("the backend must run as an IAM role or user; "
             "pass --backend-principal-arn arn:aws:iam::<account>:role/<name>")


def ensure_app_role(iam, account_id: str, kb_arn: str, memory_arn: str, backend_principal_arn: str) -> str:
    name = f"{PREFIX}-app-role"
    trust = app_role_trust_policy(account_id, backend_principal_arn)
    policy = app_role_policy(kb_arn, memory_arn)
    try:
        role = iam.get_role(RoleName=name)["Role"]
        iam.update_assume_role_policy(RoleName=name, PolicyDocument=json.dumps(trust))
        print(f"[iam] reuse app role {role['Arn']}")
    except ClientError as e:
        if e.response["Error"]["Code"] != "NoSuchEntity":
            raise
        role = iam.create_role(
            RoleName=name,
            AssumeRolePolicyDocument=json.dumps(trust),
            Description="Least-privilege role for the AnyCompany assistant backend, assumed per user",
            MaxSessionDuration=3600,
        )["Role"]
        print(f"[iam] created app role {role['Arn']}")
    for old in iam.list_role_policies(RoleName=name)["PolicyNames"]:
        if old != f"{PREFIX}-runtime":
            iam.delete_role_policy(RoleName=name, PolicyName=old)
    iam.put_role_policy(RoleName=name, PolicyName=f"{PREFIX}-runtime", PolicyDocument=json.dumps(policy))
    # infra/app-role-policy.json and infra/app-role-trust-policy.json are these documents with
    # placeholder identifiers, kept in the repository for reading. The copies resolved to
    # your account's ARNs go under runs/.
    (RUNS_DIR / "app-role-policy.resolved.json").write_text(json.dumps(policy, indent=2) + "\n")
    (RUNS_DIR / "app-role-trust-policy.resolved.json").write_text(json.dumps(trust, indent=2) + "\n")
    print(f"[iam] app role trusts {backend_principal_arn}")
    return role["Arn"]


# ------------------------------------------------------------ Knowledge Base

def ensure_knowledge_base(agent, role_arn: str, cfg: dict) -> dict:
    spec = KNOWLEDGE_BASE
    existing = cfg.get("knowledgeBase")
    if existing:
        try:
            kb = agent.get_knowledge_base(knowledgeBaseId=existing["id"])["knowledgeBase"]
            print(f"[kb] reuse {spec['name']} {kb['knowledgeBaseId']} ({kb['status']})")
            return {"id": kb["knowledgeBaseId"], "arn": kb["knowledgeBaseArn"],
                    "name": spec["name"], "description": spec["description"]}
        except ClientError as e:
            if e.response["Error"]["Code"] != "ResourceNotFoundException":
                raise
    for s in agent.list_knowledge_bases(maxResults=100)["knowledgeBaseSummaries"]:
        if s["name"] == spec["name"]:
            kb = agent.get_knowledge_base(knowledgeBaseId=s["knowledgeBaseId"])["knowledgeBase"]
            print(f"[kb] reuse by name {spec['name']} {kb['knowledgeBaseId']}")
            return {"id": kb["knowledgeBaseId"], "arn": kb["knowledgeBaseArn"],
                    "name": spec["name"], "description": spec["description"]}

    kb = agent.create_knowledge_base(
        name=spec["name"],
        description=spec["description"],
        roleArn=role_arn,
        knowledgeBaseConfiguration={
            "type": "MANAGED",
            "managedKnowledgeBaseConfiguration": {"embeddingModelType": "MANAGED"},
        },
    )["knowledgeBase"]
    kb_id = kb["knowledgeBaseId"]
    print(f"[kb] created {spec['name']} {kb_id}, waiting for ACTIVE ...")
    for _ in range(120):
        status = agent.get_knowledge_base(knowledgeBaseId=kb_id)["knowledgeBase"]["status"]
        if status == "ACTIVE":
            break
        if status == "FAILED":
            sys.exit(f"knowledge base {kb_id} FAILED")
        time.sleep(5)
    return {"id": kb_id, "arn": kb["knowledgeBaseArn"], "name": spec["name"], "description": spec["description"]}


def ensure_s3_acl_data_source(agent, kb_id: str, bucket: str, account_id: str) -> str:
    name = "s3-docs-acl"
    for ds in agent.list_data_sources(knowledgeBaseId=kb_id)["dataSourceSummaries"]:
        if ds["name"] == name:
            print(f"[kb] reuse data source {ds['dataSourceId']}")
            return ds["dataSourceId"]
    ds = agent.create_data_source(
        knowledgeBaseId=kb_id,
        name=name,
        description="AnyCompany documents in Amazon S3, with document-level access control",
        # For a managed knowledge base, every connector is MANAGED_KNOWLEDGE_BASE_CONNECTOR
        # and connectorParameters.type picks the source
        # (https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-ds-s3.html).
        # aclEnabled cannot be changed after the data source is created.
        dataSourceConfiguration={
            "type": "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
            "managedKnowledgeBaseConnectorConfiguration": {
                "connectorParameters": {
                    "type": "S3",
                    "version": "1",
                    "connectionConfiguration": {"bucketName": bucket, "bucketOwnerAccountId": account_id},
                    "filterConfiguration": {"inclusionPrefixes": [DOCS_PREFIX]},
                    "aclEnabled": True,
                    "aclConfiguration": {"globalAccessControlListS3Uri": f"s3://{bucket}/{ACL_KEY}"},
                },
            },
        },
    )["dataSource"]
    ds_id = ds["dataSourceId"]
    print(f"[kb] created ACL-enabled S3 data source {ds_id}, waiting for AVAILABLE ...")
    for _ in range(120):
        status = agent.get_data_source(knowledgeBaseId=kb_id, dataSourceId=ds_id)["dataSource"]["status"]
        if status == "AVAILABLE":
            break
        if status == "FAILED":
            sys.exit(f"data source {ds_id} FAILED")
        time.sleep(5)
    return ds_id


def sync(agent, kb: dict, timeout_s: int = 1800) -> dict:
    """Run an ingestion job and wait for it. The connector crawls the bucket, reads the
    global ACL file, and indexes each document together with its ACL."""
    job = agent.start_ingestion_job(knowledgeBaseId=kb["id"], dataSourceId=kb["dataSourceId"])["ingestionJob"]
    job_id = job["ingestionJobId"]
    print(f"[kb] sync {job_id} started")
    deadline = time.time() + timeout_s
    while True:
        job = agent.get_ingestion_job(knowledgeBaseId=kb["id"], dataSourceId=kb["dataSourceId"],
                                      ingestionJobId=job_id)["ingestionJob"]
        if job["status"] in ("COMPLETE", "FAILED", "STOPPED"):
            break
        if time.time() > deadline:
            sys.exit(f"sync {job_id} still {job['status']} after {timeout_s}s")
        time.sleep(15)
    print(f"[kb] sync {job_id} {job['status']}: {json.dumps(job.get('statistics', {}), default=str)}")
    if job["status"] != "COMPLETE":
        sys.exit(f"sync failed: {job.get('failureReasons')}")
    return job


def print_status(agent, kb: dict) -> None:
    jobs = agent.list_ingestion_jobs(knowledgeBaseId=kb["id"], dataSourceId=kb["dataSourceId"],
                                     sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"}, maxResults=1)
    for j in jobs["ingestionJobSummaries"]:
        print(json.dumps(j, indent=2, default=str))


# ---------------------------------------------------------------------- Memory

def ensure_memory(control, cfg: dict) -> dict:
    name = f"{PREFIX.replace('-', '_')}_memory"
    existing = cfg.get("memory")
    if existing:
        try:
            mem = control.get_memory(memoryId=existing["id"])["memory"]
            print(f"[memory] reuse {mem['id']} ({mem['status']})")
            return _memory_summary(mem)
        except ClientError as e:
            if e.response["Error"]["Code"] != "ResourceNotFoundException":
                raise
    for m in control.list_memories(maxResults=100)["memories"]:
        if m["id"].startswith(name + "-"):
            mem = control.get_memory(memoryId=m["id"])["memory"]
            print(f"[memory] reuse by name {mem['id']}")
            return _memory_summary(mem)

    # Namespace layout: {actorId} sits directly under the root so that ONE
    # retrievalConfigs entry with namespacePath "/anycompany/<actorId>/" reaches every
    # long-term record about that employee (profile facts and session summaries). The
    # trailing slashes follow the AgentCore guidance against prefix collisions.
    mem = control.create_memory(
        name=name,
        description="AnyCompany internal assistant memory: per-employee conversation history and preferences",
        eventExpiryDuration=30,
        memoryStrategies=[
            {"userPreferenceMemoryStrategy": {
                "name": "EmployeeProfile",
                "description": "Durable facts about the employee: office, role, operating system, team, preferences.",
                "namespaces": ["/anycompany/{actorId}/profile/"],
            }},
            {"summaryMemoryStrategy": {
                "name": "ConversationSummaries",
                "description": "Summary of each conversation the employee had with the assistant.",
                "namespaces": ["/anycompany/{actorId}/summaries/{sessionId}/"],
            }},
        ],
    )["memory"]
    print(f"[memory] created {mem['id']}, waiting for ACTIVE ...")
    for _ in range(60):
        mem = control.get_memory(memoryId=mem["id"])["memory"]
        if mem["status"] == "ACTIVE":
            break
        if mem["status"] == "FAILED":
            sys.exit(f"memory {mem['id']} FAILED: {mem.get('failureReason')}")
        time.sleep(5)
    return _memory_summary(mem)


def _memory_summary(mem: dict) -> dict:
    return {
        "id": mem["id"], "arn": mem["arn"], "status": mem["status"],
        "namespaceRoot": "/anycompany",
        "strategies": [
            {"id": s["strategyId"], "name": s["name"], "type": s["type"], "namespaces": s.get("namespaces", [])}
            for s in mem.get("strategies", [])
        ],
    }


# --------------------------------------------------------------------- Cognito

def ensure_cognito(idp, cfg: dict) -> dict:
    pool_name = f"{PREFIX}-employees"
    existing = cfg.get("cognito")
    pool_id = None
    if existing:
        try:
            idp.describe_user_pool(UserPoolId=existing["userPoolId"])
            pool_id = existing["userPoolId"]
            print(f"[cognito] reuse pool {pool_id}")
        except ClientError as e:
            if e.response["Error"]["Code"] != "ResourceNotFoundException":
                raise
    if not pool_id:
        for p in idp.list_user_pools(MaxResults=60)["UserPools"]:
            if p["Name"] == pool_name:
                pool_id = p["Id"]
                print(f"[cognito] reuse pool by name {pool_id}")
    if not pool_id:
        pool_id = idp.create_user_pool(
            PoolName=pool_name,
            AutoVerifiedAttributes=["email"],
            Policies={"PasswordPolicy": {"MinimumLength": 12, "RequireUppercase": True,
                                          "RequireLowercase": True, "RequireNumbers": True,
                                          "RequireSymbols": True}},
            # The email decides which documents a user may read (userContext.userId), so a
            # user must not be able to change it. Mutable cannot be changed after the pool
            # is created.
            Schema=[{"Name": "email", "Required": True, "Mutable": False, "AttributeDataType": "String"}],
            # Email as an alias: users still sign in with their username (maya, ...), and
            # Cognito refuses a second user with the same verified email.
            AliasAttributes=["email"],
            AdminCreateUserConfig={"AllowAdminCreateUserOnly": True},
        )["UserPool"]["Id"]
        print(f"[cognito] created pool {pool_id}")

    # Refuse to run against a pool whose email users can edit, or that lets two users
    # share an email.
    pool = idp.describe_user_pool(UserPoolId=pool_id)["UserPool"]
    email_attr = next(a for a in pool["SchemaAttributes"] if a["Name"] == "email")
    if email_attr.get("Mutable", True):
        sys.exit(f"user pool {pool_id} has a mutable email attribute; delete it and re-run setup")
    if "email" not in pool.get("AliasAttributes", []) + pool.get("UsernameAttributes", []):
        sys.exit(f"user pool {pool_id} does not enforce unique emails (email is not an alias); "
                 "delete it and re-run setup")

    # App client: no secret so a browser can use it; USER_PASSWORD_AUTH keeps the local
    # demo simple. Production apps typically use managed login or Amplify (SRP).
    client_id = None
    for c in idp.list_user_pool_clients(UserPoolId=pool_id, MaxResults=60)["UserPoolClients"]:
        if c["ClientName"] == f"{PREFIX}-web":
            client_id = c["ClientId"]
    if not client_id:
        client_id = idp.create_user_pool_client(
            UserPoolId=pool_id, ClientName=f"{PREFIX}-web", GenerateSecret=False,
            ExplicitAuthFlows=["ALLOW_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
            ReadAttributes=["email", "email_verified"],
            AccessTokenValidity=60, IdTokenValidity=60,
            TokenValidityUnits={"AccessToken": "minutes", "IdToken": "minutes"},
        )["UserPoolClient"]["ClientId"]
        print(f"[cognito] created app client {client_id}")

    password = test_password(cfg)
    users = {}
    for u in TEST_USERS:
        try:
            idp.admin_create_user(
                UserPoolId=pool_id, Username=u["username"], MessageAction="SUPPRESS",
                UserAttributes=[{"Name": "email", "Value": u["email"]}, {"Name": "email_verified", "Value": "true"}],
            )
            print(f"[cognito] created user {u['username']}")
        except ClientError as e:
            if e.response["Error"]["Code"] != "UsernameExistsException":
                raise
        idp.admin_set_user_password(UserPoolId=pool_id, Username=u["username"], Password=password, Permanent=True)
        attrs = {a["Name"]: a["Value"] for a in idp.admin_get_user(UserPoolId=pool_id, Username=u["username"])["UserAttributes"]}
        users[u["username"]] = {"sub": attrs["sub"], "email": attrs["email"]}

    return {
        "userPoolId": pool_id,
        "clientId": client_id,
        "issuer": f"https://cognito-idp.{REGION}.amazonaws.com/{pool_id}",
        "testUsers": users,
        "testPassword": password,
    }


# ------------------------------------------------------------------------ main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true", help="print the latest sync job and exit")
    ap.add_argument("--resync", action="store_true", help="upload docs + ACL file and run a new sync")
    ap.add_argument("--backend-principal-arn",
                    help="IAM role or user the backend runs as (default: the identity running this script)")
    args = ap.parse_args()

    cfg = load_config()
    if "knowledgeBases" in cfg:
        # Running over it would orphan the old knowledge bases and stop at the old user pool.
        sys.exit("config.json is from the earlier two-knowledge-base layout of this sample. Tear that deployment "
                 "down with its own teardown first, then re-run setup:\n"
                 "  git show ddb9445:infra/teardown.py > infra/teardown_ddb9445.py\n"
                 "  python infra/teardown_ddb9445.py\n"
                 "  rm infra/teardown_ddb9445.py")

    session = boto3.Session(region_name=REGION)
    sts, iam, s3 = session.client("sts"), session.client("iam"), session.client("s3")
    agent = session.client("bedrock-agent")
    control = session.client("bedrock-agentcore-control")
    idp = session.client("cognito-idp")
    identity = sts.get_caller_identity()
    account_id = identity["Account"]
    cfg["region"] = REGION
    cfg["accountId"] = account_id

    if args.status:
        print_status(agent, cfg["knowledgeBase"])
        return

    # Resolve before creating anything, so a bad ARN stops here. Stored in config.json so a
    # later run under other credentials does not silently retarget the trust policy.
    cfg["backendPrincipalArn"] = resolve_backend_principal_arn(
        iam, account_id, args.backend_principal_arn or cfg.get("backendPrincipalArn") or identity["Arn"])
    save_config(cfg)

    bucket = ensure_bucket(s3, account_id)
    cfg["bucket"] = bucket
    upload_corpus(s3, bucket)

    kb_role = ensure_kb_service_role(iam, account_id, bucket)
    kb = ensure_knowledge_base(agent, kb_role, cfg)
    kb["dataSourceId"] = ensure_s3_acl_data_source(agent, kb["id"], bucket, account_id)
    kb["folderAccess"] = FOLDER_ACCESS
    cfg["knowledgeBase"] = kb
    save_config(cfg)

    cfg["memory"] = ensure_memory(control, cfg)
    save_config(cfg)

    cfg["cognito"] = ensure_cognito(idp, cfg)
    save_config(cfg)

    cfg["appRoleArn"] = ensure_app_role(iam, account_id, kb["arn"], cfg["memory"]["arn"], cfg["backendPrincipalArn"])
    save_config(cfg)

    if args.resync or not cfg.get("lastSyncJobId"):
        job = sync(agent, kb)
        cfg["lastSyncJobId"] = job["ingestionJobId"]
        save_config(cfg)

    print(f"\nconfig written to {CONFIG_PATH}")
    print(json.dumps({k: v for k, v in cfg.items() if k != "cognito"}, indent=2))


if __name__ == "__main__":
    main()
